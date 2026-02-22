/*
 Copyright 2025 Google LLC

 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
 */

const httpErrors = require("http").STATUS_CODES;
const crypto = require("crypto");
const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const { BigQuery } = require("@google-cloud/bigquery");
const { Storage } = require("@google-cloud/storage");
const { WebSocketServer } = require("ws");

const { handleEvent } = require("./eventhandlers");
const { matchEventSchema } = require("./schemas");
const config = require("./config");
const { DEBUG_MODE } = require("./utils");
const pkg = require("../package.json");
const { PerfCtx } = require("./perf");
const {
  WS_COMPRESSION,
  WS_PAYLOAD_TYPE,
  formatDurationMs,
  getWsCompressionLabel,
  getWsPayloadTypeLabel,
  chooseWsCompression,
  encodeWsFrame,
  decodeWsFrame,
  buildBinaryPayload,
} = require("./admin/ws-frame");
const { buildNormalizedStudyMetadata } = require("./admin/study-metadata");
const { parseGsPath, extractDlqFileInfo } = require("./admin/dlq-utils");
const {
  loadDeploymentConfig,
  uploadToGCS,
  pollBigQueryForResult,
  calculatePollTimeout,
  formatResultOverview,
  isArchiveFile,
  countDicomFilesInArchive,
} = require("./process-command");

const app = express();
const bigquery = new BigQuery();
const storage = new Storage();
const WS_CORRELATION_SECRET = crypto.randomBytes(32).toString("hex");

function createWsConnectionId() {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function createWsCorrelationSignature(wsConnectionId, wsMessageId, wsAction) {
  const payload = `${String(wsConnectionId || "")}|${String(wsMessageId || "")}|${String(wsAction || "")}`;
  return crypto.createHmac("sha256", WS_CORRELATION_SECRET).update(payload).digest("hex");
}

function isValidWsCorrelationSignature(wsConnectionId, wsMessageId, wsAction, signature) {
  if (!wsConnectionId || !signature) {
    return false;
  }

  try {
    const expected = createWsCorrelationSignature(wsConnectionId, wsMessageId, wsAction);
    const actualBuffer = Buffer.from(String(signature), "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch (_) {
    return false;
  }
}

function normalizeErrorForLog(error) {
  if (!error) {
    return { message: "unknown" };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  return {
    name: error.name,
    message: error.message,
    code: error.code,
  };
}

function logStructured(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const output = JSON.stringify(entry);
  if (level === "error") {
    console.error(output);
    return;
  }
  if (level === "warn") {
    console.warn(output);
    return;
  }
  console.log(output);
}

function summarizeBodyForLog(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const keys = Object.keys(body);
  if (keys.length === 0) {
    return null;
  }

  return {
    bodyKeys: keys.slice(0, 8),
    bodyKeyCount: keys.length,
  };
}

function summarizeWsPayloadForLog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    return null;
  }

  return {
    payloadKeys: keys.slice(0, 8),
    payloadKeyCount: keys.length,
    payloadId: typeof payload.id === "string" ? payload.id : undefined,
    studyId: typeof payload.studyId === "string" ? payload.studyId : undefined,
    idsCount: Array.isArray(payload.ids) ? payload.ids.length : undefined,
    studyIdsCount: Array.isArray(payload.studyIds) ? payload.studyIds.length : undefined,
    messageIdsCount: Array.isArray(payload.messageIds) ? payload.messageIds.length : undefined,
    limit: typeof payload.limit !== "undefined" ? payload.limit : undefined,
  };
}

function loadDeploymentConfigWithFallback(configPath) {
  if (configPath) {
    return loadDeploymentConfig(configPath);
  }

  try {
    return loadDeploymentConfig();
  } catch (_) {
    return config.get();
  }
}

function getRuntimeTablesConfig() {
  const cfg = loadDeploymentConfigWithFallback();
  const gcpCfg = cfg.gcpConfig || {};
  const bqCfg = gcpCfg.bigQuery || {};

  const projectId = gcpCfg.projectId || cfg.projectId || bigquery.projectId;
  let datasetId = bqCfg.datasetId || cfg.datasetId;
  const instancesTableId = bqCfg.instancesTableId;
  const instancesViewId = bqCfg.instancesViewId || (instancesTableId ? `${instancesTableId}View` : null);

  let deadLetterTableId = bqCfg.deadLetterTableId || cfg.deadLetterTableId || "dead_letter";

  if (typeof deadLetterTableId === "string") {
    const trimmed = deadLetterTableId.replace(/`/g, "").trim();
    const parts = trimmed.split(".");
    if (parts.length === 2) {
      datasetId = datasetId || parts[0];
      deadLetterTableId = parts[1];
    } else if (parts.length === 3) {
      deadLetterTableId = `${parts[0]}.${parts[1]}.${parts[2]}`;
    }
  }

  return {
    projectId,
    datasetId,
    instancesTableId,
    instancesViewId,
    deadLetterTableId,
  };
}

const ADMIN_UI_DIR = path.join(__dirname, "..", "assets", "http-admin");

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECT_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9-:.]*$/;

function isSafeIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_REGEX.test(value);
}

function isSafeProjectId(value) {
  return typeof value === "string" && PROJECT_ID_REGEX.test(value);
}

function buildQualifiedTable(tableId, runtimeCfg = getRuntimeTablesConfig()) {
  if (!tableId) {
    throw new Error("BigQuery tableId is not configured");
  }

  const raw = String(tableId).replace(/`/g, "").trim();
  const parts = raw.split(".");

  if (parts.length === 1) {
    if (!runtimeCfg.projectId || !runtimeCfg.datasetId) {
      throw new Error("BigQuery projectId or datasetId is not configured");
    }
    if (!isSafeProjectId(runtimeCfg.projectId) || !isSafeIdentifier(runtimeCfg.datasetId) || !isSafeIdentifier(parts[0])) {
      throw new Error("Unsafe BigQuery identifier");
    }
    return `\`${runtimeCfg.projectId}.${runtimeCfg.datasetId}.${parts[0]}\``;
  }

  if (parts.length === 2) {
    if (!runtimeCfg.projectId) {
      throw new Error("BigQuery projectId is not configured");
    }
    if (!isSafeProjectId(runtimeCfg.projectId) || !isSafeIdentifier(parts[0]) || !isSafeIdentifier(parts[1])) {
      throw new Error("Unsafe BigQuery identifier");
    }
    return `\`${runtimeCfg.projectId}.${parts[0]}.${parts[1]}\``;
  }

  if (parts.length === 3) {
    if (!isSafeProjectId(parts[0]) || !isSafeIdentifier(parts[1]) || !isSafeIdentifier(parts[2])) {
      throw new Error("Unsafe BigQuery identifier");
    }
    return `\`${parts[0]}.${parts[1]}.${parts[2]}\``;
  }

  throw new Error("Invalid BigQuery table identifier");
}

function getSearchExpression(key) {
  const columnMap = new Map([
    ["id", "CAST(id AS STRING)"],
    ["path", "CAST(path AS STRING)"],
    ["version", "CAST(version AS STRING)"],
    ["timestamp", "CAST(timestamp AS STRING)"],
  ]);

  if (columnMap.has(key)) {
    return columnMap.get(key);
  }

  if (key.startsWith("metadata.")) {
    const metadataKey = key.substring("metadata.".length);
    if (!isSafeIdentifier(metadataKey)) {
      throw new Error("Invalid metadata key");
    }
    return `JSON_VALUE(metadata, '$.${metadataKey}')`;
  }

  if (key.startsWith("info.")) {
    const infoPath = key.substring("info.".length).split(".");
    if (infoPath.length === 0 || !infoPath.every(isSafeIdentifier)) {
      throw new Error("Invalid info key");
    }
    return `JSON_VALUE(info, '$.${infoPath.join(".")}')`;
  }

  if (!isSafeIdentifier(key)) {
    throw new Error("Invalid search key");
  }

  return `JSON_VALUE(metadata, '$.${key}')`;
}

async function queryInstancesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const runtimeCfg = getRuntimeTablesConfig();
  const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
  const query = `
    SELECT id, ARRAY_LENGTH(embeddingVector) AS embeddingVectorLength
    FROM ${instancesTable}
    WHERE id IN UNNEST(@ids)
  `;

  const [rows] = await bigquery.query({
    query,
    params: { ids },
  });

  return rows;
}

async function runProcessRequest(payload, onProgress = () => {}) {
  let tempFilePath;
  try {
    const fileName = String(payload?.fileName || "").trim();
    const fileDataBase64 = String(payload?.fileDataBase64 || "").trim();
    if (!fileName || !fileDataBase64) {
      const err = new Error("Both fileName and fileDataBase64 are required");
      err.code = 400;
      throw err;
    }

    onProgress("input_received", { fileName });
    const dataBuffer = Buffer.from(fileDataBase64, "base64");
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dcm2bq-process-"));
    tempFilePath = path.join(tmpDir, fileName.replace(/[^A-Za-z0-9._-]/g, "_"));
    await fs.writeFile(tempFilePath, dataBuffer);
    onProgress("file_staged", { fileSizeBytes: dataBuffer.length });

    const deploymentConfig = loadDeploymentConfigWithFallback(payload?.configPath);
    const gcpConfig = deploymentConfig.gcpConfig || deploymentConfig;
    const datasetId = gcpConfig.bigQuery?.datasetId;
    const tableId = gcpConfig.bigQuery?.instancesTableId;
    const bucketName = gcpConfig.gcs_bucket_name;

    if (!datasetId || !tableId || !bucketName) {
      throw new Error("Deployment config missing required fields for BigQuery/GCS");
    }

    const fileSizeBytes = dataBuffer.length;
    const archive = isArchiveFile(tempFilePath);
    const expectedFileCount = archive ? await countDicomFilesInArchive(tempFilePath) : undefined;
    onProgress("upload_started", { archive, expectedFileCount: expectedFileCount || null });

    const uploadResult = await uploadToGCS(tempFilePath, bucketName);
    onProgress("upload_completed", {
      objectName: uploadResult.objectName,
      objectVersion: uploadResult.version,
    });

    const pollInterval = parseInt(payload?.pollInterval || "2000", 10);
    const baseTimeout = parseInt(payload?.pollTimeout || "60000", 10);
    const timeoutPerMB = parseInt(payload?.pollTimeoutPerMb || "10000", 10);
    let maxPollTime = calculatePollTimeout(fileSizeBytes, baseTimeout, timeoutPerMB);
    if (archive) {
      maxPollTime += 30000;
    }

    onProgress("polling_started", { pollInterval, maxPollTime });
    const results = await pollBigQueryForResult({
      datasetId,
      tableId,
      objectPath: `${bucketName}/${uploadResult.objectName}`,
      objectVersion: uploadResult.version,
      pollInterval,
      maxPollTime,
      isArchive: archive,
      expectedFileCount,
    });

    const overview = results && results.length > 0
      ? formatResultOverview(results, archive)
      : "No result found in BigQuery within timeout period";

    onProgress("polling_completed", { resultCount: results ? results.length : 0 });
    return {
      uploaded: true,
      objectName: uploadResult.objectName,
      objectVersion: uploadResult.version,
      isArchive: archive,
      expectedFileCount: expectedFileCount || null,
      resultCount: results ? results.length : 0,
      overview,
      results: results || [],
    };
  } finally {
    if (tempFilePath) {
      try {
        await fs.rm(path.dirname(tempFilePath), { recursive: true, force: true });
      } catch (_) {}
    }
  }
}

// Helper: Look up instance by DICOM UIDs
async function getInstanceByDicomUids(studyUid, seriesUid, sopInstanceUid, runtimeCfg) {
  const instancesView = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
  const query = `
    SELECT id, path, version, timestamp, metadata, info
    FROM ${instancesView}
    WHERE COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') = @studyUid
      AND COALESCE(JSON_VALUE(metadata, '$.SeriesInstanceUID'), 'UNKNOWN') = @seriesUid
      AND COALESCE(JSON_VALUE(metadata, '$.SOPInstanceUID'), 'UNKNOWN') = @sopInstanceUid
    LIMIT 1
  `;
  const [rows] = await bigquery.query({
    query,
    params: { studyUid, seriesUid, sopInstanceUid },
  });
  return rows.length > 0 ? rows[0] : null;
}

async function proxyApiThroughHttp(port, action, payload, wsMessageId = null, wsConnectionId = null) {
  const routes = {
    "instances.search": { method: "POST", path: "/api/instances/search" },
    "instances.searchCounts": { method: "POST", path: "/api/instances/search/counts" },
    "instances.get": { method: "GET", path: `/api/instances/${encodeURIComponent(String(payload?.id || ""))}` },
    "instances.content": {
      method: "GET",
      path: payload?.studyUid && payload?.seriesUid && payload?.sopInstanceUid
        ? `/studies/${encodeURIComponent(String(payload.studyUid))}/series/${encodeURIComponent(String(payload.seriesUid))}/instances/${encodeURIComponent(String(payload.sopInstanceUid))}/rendered`
        : `/api/instances/${encodeURIComponent(String(payload?.id || ""))}/content`,
    },
    "instances.delete": { method: "DELETE", path: "/api/instances" },
    "instances.counts": { method: "GET", path: "/api/instances/counts/overview" },
    "studies.search": { method: "POST", path: "/api/studies/search" },
    "studies.searchCounts": { method: "POST", path: "/api/studies/search/counts" },
    "studies.instances": {
      method: "GET",
      path: `/studies/${encodeURIComponent(String(payload?.studyId || ""))}/instances?limit=${encodeURIComponent(String(payload?.limit || "5000"))}`,
    },
    "studies.metadata": {
      method: "GET",
      path: `/studies/${encodeURIComponent(String(payload?.studyId || ""))}/metadata?limit=${encodeURIComponent(String(payload?.limit || "20000"))}`,
    },
    "studies.delete": { method: "POST", path: "/api/studies/delete" },
    "dlq.summary": { method: "GET", path: `/api/dlq/summary?limit=${encodeURIComponent(String(payload?.limit || "500"))}` },
    "dlq.items": {
      method: "GET",
      path: `/api/dlq/items?limit=${encodeURIComponent(String(payload?.limit || "100"))}&offset=${encodeURIComponent(String(payload?.offset || "0"))}`,
    },
    "dlq.requeue": { method: "POST", path: "/api/dlq/requeue" },
    "dlq.delete": { method: "DELETE", path: "/api/dlq" },
    "dlq.count": { method: "GET", path: "/api/dlq/count" },
  };

  const route = routes[action];
  if (!route) {
    const err = new Error(`Unsupported websocket action: ${action}`);
    err.code = 400;
    throw err;
  }

  const url = `http://127.0.0.1:${port}${route.path}`;
  const headers = { "Content-Type": "application/json" };
  if (wsConnectionId) {
    const wsMessageIdValue = String(wsMessageId || "");
    const wsActionValue = String(action || "");
    headers["x-ws-connection-id"] = String(wsConnectionId);
    headers["x-ws-message-id"] = wsMessageIdValue;
    headers["x-ws-action"] = wsActionValue;
    headers["x-ws-correlation-signature"] = createWsCorrelationSignature(wsConnectionId, wsMessageIdValue, wsActionValue);
  }

  const init = { method: route.method, headers };
  if (route.method !== "GET") {
    init.body = JSON.stringify(payload || {});
  }

  const response = await fetch(url, init);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(json.reason || json.error || json.message || `HTTP ${response.status}`);
    err.code = response.status;
    throw err;
  }
  return json;
}

app.use(express.json({ limit: "50mb" }));

app.use((req, res, next) => {
  const startNs = process.hrtime.bigint();
  const bodySummary = summarizeBodyForLog(req.body);
  const wsConnectionId = String(req.get("x-ws-connection-id") || "").trim();
  const wsMessageId = String(req.get("x-ws-message-id") || "").trim();
  const wsAction = String(req.get("x-ws-action") || "").trim();
  const wsSignature = String(req.get("x-ws-correlation-signature") || "").trim();
  const hasWsCorrelationHeaders = !!(wsConnectionId || wsMessageId || wsAction || wsSignature);
  const wsCorrelationTrusted = isValidWsCorrelationSignature(wsConnectionId, wsMessageId, wsAction, wsSignature);
  const wsCorrelationStatus = !hasWsCorrelationHeaders
    ? "none"
    : (wsCorrelationTrusted ? "trusted" : "rejected");

  res.on("finish", () => {
    const durationMs = Number(formatDurationMs(startNs).toFixed(1));
    const contentLength = res.getHeader("content-length");
    logStructured("info", "http.request", {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      bytes: contentLength ? Number(contentLength) : undefined,
      wsMessageId: wsCorrelationTrusted ? (wsMessageId || undefined) : undefined,
      wsAction: wsCorrelationTrusted ? (wsAction || undefined) : undefined,
      wsCorrelationStatus,
      ...(bodySummary || {}),
    });
  });

  next();
});

app.use("/ui", express.static(ADMIN_UI_DIR));

app.get("/ui", (_, res) => {
  res.sendFile(path.join(ADMIN_UI_DIR, "index.html"));
});

app.post("/api/instances/search", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "").trim();
    const studyLimit = Math.min(Math.max(parseInt(req.body?.studyLimit || 50, 10), 1), 200);

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const whereExpr = getSearchExpression(key);
    
    // Step 1: Get the list of matching studies (lightweight query)
    const studiesQuery = `
      SELECT 
        COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') as study_id,
        MAX(timestamp) as max_timestamp,
        COUNT(*) as instance_count
      FROM ${viewTable}
      WHERE ${whereExpr} LIKE @valuePattern
      GROUP BY study_id
      ORDER BY max_timestamp DESC
      LIMIT @studyLimit
    `;

    const [studyRows] = await bigquery.query({
      query: studiesQuery,
      params: {
        valuePattern: `%${value}%`,
        studyLimit,
      },
    });

    // Step 2: Get instances from these studies (limited to avoid large result sets)
    const studyIds = studyRows.map((row) => row.study_id);
    if (studyIds.length === 0) {
      return res.json({ count: 0, items: [], totalStudies: 0 });
    }

    
    // Build a subquery with study ordering info
    const studyOrderInfo = studyRows.map((row, index) => 
      `SELECT '${row.study_id.replace(/'/g, "''")}'  as study_id, ${index} as study_order`
    ).join(' UNION ALL ');
    
    const instancesQuery = `
      WITH study_order AS (
        ${studyOrderInfo}
      )
      SELECT 
        i.id, i.path, i.version, i.timestamp, i.metadata, i.info,
        so.study_order
      FROM ${viewTable} i
      LEFT JOIN study_order so ON COALESCE(JSON_VALUE(i.metadata, '$.StudyInstanceUID'), 'UNKNOWN') = so.study_id
      WHERE COALESCE(JSON_VALUE(i.metadata, '$.StudyInstanceUID'), 'UNKNOWN') IN UNNEST(@studyIds)
      ORDER BY 
        COALESCE(so.study_order, 999999),
        i.timestamp DESC
      LIMIT 5000
    `;

    const [rows] = await bigquery.query({
      query: instancesQuery,
      params: {
        studyIds,
      },
    });

    const ids = rows.map((row) => row.id).filter(Boolean);
    const embeddingRows = await queryInstancesByIds(ids);
    const embeddingMap = new Map(
      embeddingRows.map((row) => [row.id, Number(row.embeddingVectorLength || 0)])
    );

    // If we got exactly the limit, we need to count to know if there are more
    let totalStudies = studyRows.length;
    if (studyRows.length === studyLimit) {
      const countQuery = `
        SELECT COUNT(DISTINCT COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN')) as total
        FROM ${viewTable}
        WHERE ${whereExpr} LIKE @valuePattern
      `;
      const [countRows] = await bigquery.query({
        query: countQuery,
        params: { valuePattern: `%${value}%` },
      });
      totalStudies = Number(countRows[0]?.total || studyLimit);
    }

    const results = rows.map((row) => {
      const metadata = parseJsonValue(row.metadata);
      const info = parseJsonValue(row.info);
      const embeddingVectorLength = embeddingMap.get(row.id) || 0;
      return {
        id: row.id,
        path: row.path,
        version: row.version,
        timestamp: row.timestamp,
        metadata,
        info,
        embeddingVectorLength,
        hasEmbeddingVector: embeddingVectorLength > 0,
      };
    });

    res.json({ 
      count: results.length, 
      items: results,
      totalStudies,
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/instances/search/counts", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "").trim();

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const whereExpr = getSearchExpression(key);
    const countQuery = `
      SELECT
        COUNT(*) as totalInstances,
        COUNT(DISTINCT COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN')) as totalStudies
      FROM ${viewTable}
      WHERE ${whereExpr} LIKE @valuePattern
    `;

    const [rows] = await bigquery.query({
      query: countQuery,
      params: { valuePattern: `%${value}%` },
    });

    const totals = rows[0] || {};
    const totalInstances = Number(totals.totalInstances || 0);
    const totalStudies = Number(totals.totalStudies || 0);
    res.json({ totalInstances, totalStudies });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/studies/search", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "").trim();
    const studyLimit = Math.min(Math.max(parseInt(req.body?.studyLimit || 50, 10), 1), 200);
    const studyOffset = Math.max(parseInt(req.body?.studyOffset || 0, 10), 0);

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const whereExpr = getSearchExpression(key);

    const studiesQuery = `
      SELECT
        COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') as study_id,
        MAX(timestamp) as max_timestamp,
        COUNT(*) as instance_count,
        COUNT(DISTINCT COALESCE(JSON_VALUE(metadata, '$.SeriesInstanceUID'), 'UNKNOWN')) as series_count,
        ANY_VALUE(JSON_VALUE(metadata, '$.PatientName')) as patient_name,
        ANY_VALUE(JSON_VALUE(metadata, '$.PatientID')) as patient_id,
        ANY_VALUE(JSON_VALUE(metadata, '$.AccessionNumber')) as accession_number,
        ANY_VALUE(JSON_VALUE(metadata, '$.ReferringPhysicianName')) as referring_physician_name,
        ANY_VALUE(JSON_VALUE(metadata, '$.InstitutionName')) as institution_name,
        ANY_VALUE(JSON_VALUE(metadata, '$.StudyDate')) as study_date,
        ANY_VALUE(JSON_VALUE(metadata, '$.StudyTime')) as study_time,
        ANY_VALUE(JSON_VALUE(metadata, '$.StudyDescription')) as study_description
      FROM ${viewTable}
      WHERE ${whereExpr} LIKE @valuePattern
      GROUP BY study_id
      ORDER BY max_timestamp DESC
      LIMIT @studyLimit OFFSET @studyOffset
    `;

    const totalsQuery = `
      SELECT
        COUNT(*) as totalInstances,
        COUNT(DISTINCT COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN')) as totalStudies
      FROM ${viewTable}
      WHERE ${whereExpr} LIKE @valuePattern
    `;

    const [studyRows, totalRows] = await Promise.all([
      bigquery.query({
        query: studiesQuery,
        params: { valuePattern: `%${value}%`, studyLimit, studyOffset },
      }),
      bigquery.query({
        query: totalsQuery,
        params: { valuePattern: `%${value}%` },
      }),
    ]);

    const studies = (studyRows?.[0] || []).map((row) => ({
      studyId: row.study_id,
      instanceCount: Number(row.instance_count || 0),
      seriesCount: Number(row.series_count || 0),
      patientName: row.patient_name || null,
      patientId: row.patient_id || null,
      accessionNumber: row.accession_number || null,
      referringPhysicianName: row.referring_physician_name || null,
      institutionName: row.institution_name || null,
      studyDate: row.study_date || null,
      studyTime: row.study_time || null,
      studyDescription: row.study_description || null,
    }));

    const totals = totalRows?.[0]?.[0] || {};
    const totalInstances = Number(totals.totalInstances || 0);
    const totalStudies = Number(totals.totalStudies || 0);
    res.json({ items: studies, totalInstances, totalStudies, studyLimit, studyOffset });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/studies/search/counts", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "").trim();

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const whereExpr = getSearchExpression(key);
    const countQuery = `
      SELECT
        COUNT(*) as totalInstances,
        COUNT(DISTINCT COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN')) as totalStudies
      FROM ${viewTable}
      WHERE ${whereExpr} LIKE @valuePattern
    `;

    const [rows] = await bigquery.query({
      query: countQuery,
      params: { valuePattern: `%${value}%` },
    });

    const totals = rows[0] || {};
    const totalInstances = Number(totals.totalInstances || 0);
    const totalStudies = Number(totals.totalStudies || 0);
    res.json({ totalInstances, totalStudies });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/studies/:studyInstanceUid/instances", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const studyInstanceUid = String(req.params.studyInstanceUid || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "5000", 10), 1), 5000);
    if (!studyInstanceUid) {
      return res.status(400).json({ error: "Missing studyInstanceUid" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const instancesQuery = `
      SELECT id, path, version, timestamp, metadata, info
      FROM ${viewTable}
      WHERE COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') = @studyInstanceUid
      ORDER BY timestamp DESC
      LIMIT @limit
    `;

    const [rows] = await bigquery.query({
      query: instancesQuery,
      params: { studyInstanceUid, limit },
    });

    const ids = rows.map((row) => row.id).filter(Boolean);
    const embeddingRows = await queryInstancesByIds(ids);
    const embeddingMap = new Map(
      embeddingRows.map((row) => [row.id, Number(row.embeddingVectorLength || 0)])
    );

    const items = rows.map((row) => {
      const metadata = parseJsonValue(row.metadata);
      const info = parseJsonValue(row.info);
      const embeddingVectorLength = embeddingMap.get(row.id) || 0;
      return {
        id: row.id,
        path: row.path,
        version: row.version,
        timestamp: row.timestamp,
        metadata,
        info,
        embeddingVectorLength,
        hasEmbeddingVector: embeddingVectorLength > 0,
      };
    });

    res.json({ items, count: items.length, studyInstanceUid });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/studies/:studyInstanceUid/metadata", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const studyInstanceUid = String(req.params.studyInstanceUid || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "20000", 10), 1), 50000);
    if (!studyInstanceUid) {
      return res.status(400).json({ error: "Missing studyInstanceUid" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const query = `
      SELECT id, path, version, timestamp, metadata
      FROM ${viewTable}
      WHERE COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') = @studyInstanceUid
      ORDER BY timestamp DESC
      LIMIT @limit
    `;

    const [rows] = await bigquery.query({ query, params: { studyInstanceUid, limit } });
    if (!rows.length) {
      return res.status(404).json({ error: "Study not found" });
    }

    const normalized = buildNormalizedStudyMetadata(rows, studyInstanceUid);
    res.json(normalized);
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/studies/delete", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const studyIds = Array.isArray(req.body?.studyIds)
      ? req.body.studyIds.filter((id) => typeof id === "string" && id)
      : [];
    if (studyIds.length === 0) {
      return res.status(400).json({ error: "No studyIds provided" });
    }

    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const query = `
      DELETE FROM ${instancesTable}
      WHERE id IN (
        SELECT id
        FROM ${viewTable}
        WHERE COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN') IN UNNEST(@studyIds)
      )
    `;

    await bigquery.query({ query, params: { studyIds } });
    res.json({ deletedStudyCount: studyIds.length });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/instances/counts/overview", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    
    const [rows] = await bigquery.query({
      query: `
        SELECT 
          COUNT(DISTINCT id) as totalInstances,
          COUNT(DISTINCT CONCAT(COALESCE(JSON_VALUE(metadata, '$.StudyInstanceUID'), 'UNKNOWN'))) as totalStudies
        FROM ${viewTable}
      `,
    });
    
    const result = rows[0] || {};
    res.json({
      totalInstances: Number(result.totalInstances || 0),
      totalStudies: Number(result.totalStudies || 0),
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/instances/:id", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const viewTable = buildQualifiedTable(runtimeCfg.instancesViewId, runtimeCfg);
    const query = `
      SELECT
        i.id,
        i.path,
        i.version,
        i.timestamp,
        i.info,
        i.embeddingVector,
        ARRAY_LENGTH(i.embeddingVector) AS embeddingVectorLength,
        v.metadata AS metadataFromView,
        v.info AS infoFromView
      FROM ${instancesTable} i
      LEFT JOIN ${viewTable} v USING(id)
      WHERE i.id = @id
      LIMIT 1
    `;

    const [rows] = await bigquery.query({ query, params: { id } });
    if (rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    const row = rows[0];
    const metadata = parseJsonValue(row.metadataFromView || null);
    const info = parseJsonValue(row.infoFromView || row.info || null);
    const vectorLength = Number(row.embeddingVectorLength || 0);
    const vector = Array.isArray(row.embeddingVector) ? row.embeddingVector : [];

    res.json({
      id: row.id,
      path: row.path,
      version: row.version,
      timestamp: row.timestamp,
      metadata,
      info,
      embeddingVectorLength: vectorLength,
      hasEmbeddingVector: vectorLength > 0,
      embeddingVectorPreview: vector.slice(0, 25),
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/instances/:id/content", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const id = String(req.params.id || "").trim();
    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const query = `
      SELECT id, info
      FROM ${instancesTable}
      WHERE id = @id
      LIMIT 1
    `;
    const [rows] = await bigquery.query({ query, params: { id } });
    if (rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    const info = parseJsonValue(rows[0].info) || {};
    const input = info?.embedding?.input || null;
    const objectPath = input?.path;
    const mimeType = input?.mimeType || "application/octet-stream";

    if (!objectPath) {
      return res.status(404).json({ error: "No embedding input content associated with this item" });
    }

    const parsed = parseGsPath(objectPath);
    if (!parsed) {
      return res.status(400).json({ error: `Invalid embedding input path: ${objectPath}` });
    }

    const [buffer] = await storage.bucket(parsed.bucket).file(parsed.object).download();
    if (mimeType.startsWith("image/")) {
      return res.json({
        id,
        objectPath,
        mimeType,
        contentType: "image",
        dataBase64: buffer.toString("base64"),
      });
    }

    return res.json({
      id,
      objectPath,
      mimeType,
      contentType: "text",
      text: buffer.toString("utf-8"),
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.delete("/api/instances", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string" && id) : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: "No ids provided" });
    }

    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const query = `
      DELETE FROM ${instancesTable}
      WHERE id IN UNNEST(@ids)
    `;
    await bigquery.query({ query, params: { ids } });
    res.json({ deletedCount: ids.length });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

// DICOMweb: Get instance by DICOM UIDs
app.get("/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;

    const row = await getInstanceByDicomUids(studyInstanceUid, seriesInstanceUid, sopInstanceUid, runtimeCfg);
    if (!row) {
      return res.status(404).json({ error: "Instance not found" });
    }

    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const query = `
      SELECT
        i.id,
        i.embeddingVector,
        ARRAY_LENGTH(i.embeddingVector) AS embeddingVectorLength
      FROM ${instancesTable} i
      WHERE i.id = @id
      LIMIT 1
    `;
    const [fullRows] = await bigquery.query({ query, params: { id: row.id } });
    const fullRow = fullRows?.[0];

    const metadata = parseJsonValue(row.metadata || null);
    const info = parseJsonValue(row.info || null);
    const vectorLength = Number(fullRow?.embeddingVectorLength || 0);
    const vector = Array.isArray(fullRow?.embeddingVector) ? fullRow.embeddingVector : [];

    res.json({
      id: row.id,
      path: row.path,
      version: row.version,
      timestamp: row.timestamp,
      metadata,
      info,
      embeddingVectorLength: vectorLength,
      hasEmbeddingVector: vectorLength > 0,
      embeddingVectorPreview: vector.slice(0, 25),
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

// DICOMweb: Get instance rendered content by DICOM UIDs
app.get("/studies/:studyInstanceUid/series/:seriesInstanceUid/instances/:sopInstanceUid/rendered", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const { studyInstanceUid, seriesInstanceUid, sopInstanceUid } = req.params;

    const row = await getInstanceByDicomUids(studyInstanceUid, seriesInstanceUid, sopInstanceUid, runtimeCfg);
    if (!row) {
      return res.status(404).json({ error: "Instance not found" });
    }

    const instancesTable = buildQualifiedTable(runtimeCfg.instancesTableId, runtimeCfg);
    const query = `SELECT info FROM ${instancesTable} WHERE id = @id LIMIT 1`;
    const [rows] = await bigquery.query({ query, params: { id: row.id } });

    const info = parseJsonValue(rows[0]?.info || null) || {};
    const input = info?.embedding?.input || null;
    const objectPath = input?.path;
    const mimeType = input?.mimeType || "application/octet-stream";

    if (!objectPath) {
      return res.status(404).json({ error: "Content not found" });
    }

    const parsed = parseGsPath(objectPath);
    if (!parsed) {
      return res.status(400).json({ error: `Invalid embedding input path: ${objectPath}` });
    }

    const file = storage.bucket(parsed.bucket).file(parsed.object);
    const [exists] = await file.exists();
    if (!exists) {
      return res.status(404).json({ error: "File not found in storage" });
    }

    const [fileContent] = await file.download();
    const dataBase64 = Buffer.from(fileContent).toString("base64");
    const contentType = mimeType.startsWith("image/") ? "image" : "text";

    res.json({
      contentType,
      mimeType,
      dataBase64,
      text: contentType === "text" ? fileContent.toString("utf-8") : null,
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/dlq/count", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const deadLetterTable = buildQualifiedTable(runtimeCfg.deadLetterTableId, runtimeCfg);
    
    const [rows] = await bigquery.query({
      query: `SELECT COUNT(*) as totalCount FROM ${deadLetterTable}`,
    });
    
    const totalCount = Number(rows[0]?.totalCount || 0);
    res.json({ totalCount });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/dlq/summary", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "500", 10), 1), 5000);
    const deadLetterTable = buildQualifiedTable(runtimeCfg.deadLetterTableId, runtimeCfg);

    const countQuery = `SELECT COUNT(*) AS totalCount FROM ${deadLetterTable}`;
    const itemsQuery = `
      SELECT data, attributes, message_id, publish_time
      FROM ${deadLetterTable}
      ORDER BY publish_time DESC, message_id DESC
      LIMIT @limit
    `;

    const [[countRows], [rows]] = await Promise.all([
      bigquery.query({ query: countQuery }),
      bigquery.query({ query: itemsQuery, params: { limit } }),
    ]);

    const files = new Map();
    let parseErrors = 0;
    for (const row of rows) {
      const fileInfo = extractDlqFileInfo(row);
      if (!fileInfo) {
        parseErrors++;
        continue;
      }
      const key = `${fileInfo.bucket}/${fileInfo.name}`;
      files.set(key, (files.get(key) || 0) + 1);
    }

    res.json({
      totalCount: Number(countRows[0]?.totalCount || 0),
      sampledCount: rows.length,
      uniqueFilesInSample: files.size,
      parseErrors,
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.get("/api/dlq/items", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || "0", 10), 0);
    const deadLetterTable = buildQualifiedTable(runtimeCfg.deadLetterTableId, runtimeCfg);
    const query = `
      SELECT data, attributes, message_id, publish_time
      FROM ${deadLetterTable}
      ORDER BY publish_time DESC, message_id DESC
      LIMIT @limit
      OFFSET @offset
    `;
    const [rows] = await bigquery.query({ query, params: { limit, offset } });
    const items = rows.map((row) => {
      const fileInfo = extractDlqFileInfo(row);
      return {
        messageId: row.message_id,
        publishTime: row.publish_time,
        bucket: fileInfo?.bucket || null,
        name: fileInfo?.name || null,
        generation: fileInfo?.generation || null,
        source: fileInfo?.source || null,
        gcsPath: fileInfo ? `gs://${fileInfo.bucket}/${fileInfo.name}` : null,
      };
    });

    res.json({ count: items.length, items, limit, offset });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/dlq/requeue", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id) => typeof id === "string" && id)
      : [];
    const limit = Math.min(Math.max(parseInt(req.body?.limit || "100", 10), 1), 1000);
    const deadLetterTable = buildQualifiedTable(runtimeCfg.deadLetterTableId, runtimeCfg);

    let query;
    let params;
    if (messageIds.length > 0) {
      query = `
        SELECT data, attributes, message_id, publish_time
        FROM ${deadLetterTable}
        WHERE message_id IN UNNEST(@messageIds)
      `;
      params = { messageIds };
    } else {
      query = `
        SELECT data, attributes, message_id, publish_time
        FROM ${deadLetterTable}
        ORDER BY publish_time DESC, message_id DESC
        LIMIT @limit
      `;
      params = { limit };
    }

    const [rows] = await bigquery.query({ query, params });
    if (rows.length === 0) {
      return res.json({ requeuedCount: 0, deletedMessageCount: 0, failures: [] });
    }

    const files = new Map();
    for (const row of rows) {
      const fileInfo = extractDlqFileInfo(row);
      if (!fileInfo) continue;
      const key = `${fileInfo.bucket}/${fileInfo.name}`;
      const existing = files.get(key);
      if (!existing) {
        files.set(key, { fileInfo, messageIds: [row.message_id] });
      } else {
        existing.messageIds.push(row.message_id);
      }
    }

    let requeuedCount = 0;
    const deletedMessageIds = [];
    const failures = [];

    for (const [, entry] of files) {
      const { fileInfo } = entry;
      try {
        const file = storage.bucket(fileInfo.bucket).file(fileInfo.name);
        const [exists] = await file.exists();
        if (!exists) {
          failures.push({ gcsPath: `gs://${fileInfo.bucket}/${fileInfo.name}`, error: "File not found" });
          continue;
        }
        await file.setMetadata({
          metadata: {
            "dcm2bq-reprocess": new Date().toISOString(),
            "dcm2bq-requeue-source": "dlq-api",
          },
        });
        requeuedCount++;
        deletedMessageIds.push(...entry.messageIds);
      } catch (error) {
        failures.push({ gcsPath: `gs://${fileInfo.bucket}/${fileInfo.name}`, error: error.message });
      }
    }

    if (deletedMessageIds.length > 0) {
      const deleteQuery = `
        DELETE FROM ${deadLetterTable}
        WHERE message_id IN UNNEST(@messageIds)
      `;
      await bigquery.query({ query: deleteQuery, params: { messageIds: deletedMessageIds } });
    }

    res.json({
      requeuedCount,
      deletedMessageCount: deletedMessageIds.length,
      failures,
    });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.delete("/api/dlq", async (req, res) => {
  try {
    const runtimeCfg = getRuntimeTablesConfig();
    const messageIds = Array.isArray(req.body?.messageIds)
      ? req.body.messageIds.filter((id) => typeof id === "string" && id)
      : [];
    if (messageIds.length === 0) {
      return res.status(400).json({ error: "No messageIds provided" });
    }

    const deadLetterTable = buildQualifiedTable(runtimeCfg.deadLetterTableId, runtimeCfg);
    const query = `
      DELETE FROM ${deadLetterTable}
      WHERE message_id IN UNNEST(@messageIds)
    `;
    await bigquery.query({ query, params: { messageIds } });
    res.json({ deletedCount: messageIds.length });
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.post("/api/process", async (req, res) => {
  try {
    const result = await runProcessRequest(req.body || {});
    res.json(result);
  } catch (error) {
    handleHttpError(req, res, error);
  }
});

app.use(/.*/, (req, res, next) => {
  res.perfCtx = new PerfCtx();
  if (DEBUG_MODE && req.body) {
    const output = { url: req.url, body: req.body };
    try {
      logStructured("info", "http.debug.body", output);
    } catch (e) {}
  }
  next();
});

// Method for version response
app.get("/", (_, res) => {
  res.json({ name: pkg.name, version: pkg.version });
  res.perfCtx.addRef("afterResponse");
  res.perfCtx.print();
});

// Method for receiving push events
app.post("/", async (req, res) => {
  try {
    const eventName = matchEventSchema(req.body);
    res.perfCtx.addRef("beforeHandleEvent");
    await handleEvent(eventName, req, res);
    res.perfCtx.addRef("afterHandleEvent");
  } catch (e) {
    return handleHttpError(req, res, e);
  }
  res.status(200).send();
  res.perfCtx.addRef("afterResponse");
  res.perfCtx.print();
});

function handleHttpError(req, res, e) {
  const err = new Error(e.message || "unknown", { cause: e });
  
  // Determine appropriate HTTP status code
  if (httpErrors[e.code]) {
    // Error has a valid HTTP status code
    err.code = e.code;
  } else if (e.retryable === false) {
    // Explicitly marked as non-retryable - use 422 (Unprocessable Entity)
    err.code = 422;
  } else {
    // Default to 500 for unknown/retryable errors
    err.code = 500;
  }
  
  err.messageId = req.body?.message?.messageId || "unknown";
  res.status(err.code).json({ code: err.code, messageId: err.messageId, reason: err.message });
  logStructured("error", "http.error", {
    statusCode: err.code,
    messageId: err.messageId,
    error: normalizeErrorForLog(e),
    path: req.originalUrl,
    method: req.method,
  });
}

class HttpServer {
  constructor(port = 8080) {
    this.port = port;
    this.listening = false;
  }

  start() {
    this.server = app.listen(this.port, () => {
      logStructured("info", "server.started", {
        port: this.port,
        version: pkg.version,
        debug: DEBUG_MODE,
      });
      if (DEBUG_MODE) {
        logStructured("info", "server.config", { config: config.get() });
      }
      this.listening = true;
    });

    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (socket, request) => {
      const connectionId = createWsConnectionId();
      const remoteAddress = request?.socket?.remoteAddress || "unknown";
      logStructured("info", "ws.connection.open", { connectionId, remoteAddress });

      socket.on("close", (code) => {
        logStructured("info", "ws.connection.close", { connectionId, remoteAddress, code });
      });

      socket.on("message", async (message) => {
        const startNs = process.hrtime.bigint();
        if (typeof message === "string") {
          logStructured("warn", "ws.message.invalid_frame", {
            connectionId,
            remoteAddress,
            error: { message: "Binary frames are required" },
          });
          socket.close(1003, "Binary frames required");
          return;
        }

        let frame;
        try {
          frame = await decodeWsFrame(message);
        } catch (error) {
          logStructured("warn", "ws.message.invalid_frame", {
            connectionId,
            remoteAddress,
            error: normalizeErrorForLog(error),
          });
          socket.close(1003, "Invalid WS frame");
          return;
        }

        const {
          messageId,
          messageIdHex,
          payloadType,
          compression,
          payloadCompressedBytes,
          payloadBuffer,
        } = frame;
        const requestId = messageIdHex;

        const sendProtocolError = async (errorMessage) => {
          const durationMs = Number(formatDurationMs(startNs).toFixed(1));
          const { frame: outgoingFrame } = await encodeWsFrame({
            messageId,
            compression: WS_COMPRESSION.none,
            payloadType: WS_PAYLOAD_TYPE.json,
            payloadBuffer: Buffer.from(
              JSON.stringify({
                type: "error",
                action: "unknown",
                error: errorMessage,
                code: 400,
              }),
              "utf8",
            ),
          });
          if (socket.readyState === 1) {
            socket.send(outgoingFrame);
            logStructured("info", "ws.message.sent", {
              connectionId,
              remoteAddress,
              action: "unknown",
              requestId,
              type: "error",
              status: "error",
              durationMs,
              payloadType: "json",
              compression: "none",
            });
          }
        };

        if (payloadType !== WS_PAYLOAD_TYPE.json) {
          await sendProtocolError("Unsupported payload type");
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(payloadBuffer.toString("utf8"));
        } catch (error) {
          await sendProtocolError("Invalid JSON payload");
          return;
        }

        const action = typeof parsed?.action === "string" ? parsed.action : "";
        const payload = parsed?.payload || {};
        if (!action) {
          await sendProtocolError("Missing websocket action");
          return;
        }

        const payloadSummary = summarizeWsPayloadForLog(payload);
        logStructured("info", "ws.message.received", {
          connectionId,
          remoteAddress,
          action,
          requestId,
          payloadType: getWsPayloadTypeLabel(payloadType),
          compression: getWsCompressionLabel(compression),
          payloadBytes: payloadBuffer.length,
          payloadCompressedBytes,
          ...(payloadSummary || {}),
        });

        const sendJson = async (type, data = {}, overrides = {}) => {
          if (socket.readyState !== 1) return;
          const outgoing = {
            type,
            action: overrides.action ?? action,
            ...data,
          };
          const outgoingBuffer = Buffer.from(JSON.stringify(outgoing), "utf8");
          const compressionValue = overrides.compression ?? chooseWsCompression(outgoingBuffer.length);
          const { frame: outgoingFrame, compressedBytes } = await encodeWsFrame({
            messageId: overrides.messageId ?? messageId,
            compression: compressionValue,
            payloadType: WS_PAYLOAD_TYPE.json,
            payloadBuffer: outgoingBuffer,
          });
          socket.send(outgoingFrame);
          const outgoingSummary = summarizeWsPayloadForLog(outgoing);
          logStructured("info", "ws.message.sent", {
            connectionId,
            remoteAddress,
            action: outgoing.action || "unknown",
            requestId: requestId || undefined,
            type,
            status: overrides.status,
            durationMs: overrides.durationMs,
            payloadType: "json",
            compression: getWsCompressionLabel(compressionValue),
            payloadBytes: outgoingBuffer.length,
            payloadCompressedBytes: compressedBytes,
            ...(outgoingSummary || {}),
          });
        };

        const sendBinary = async (meta, dataBuffer, overrides = {}) => {
          if (socket.readyState !== 1) return;
          const payloadBuffer = buildBinaryPayload(meta, dataBuffer);
          const compressionValue = overrides.compression ?? chooseWsCompression(payloadBuffer.length, meta);
          const { frame: outgoingFrame, compressedBytes } = await encodeWsFrame({
            messageId: overrides.messageId ?? messageId,
            compression: compressionValue,
            payloadType: WS_PAYLOAD_TYPE.binary,
            payloadBuffer,
          });
          socket.send(outgoingFrame);
          const outgoingSummary = summarizeWsPayloadForLog(meta);
          logStructured("info", "ws.message.sent", {
            connectionId,
            remoteAddress,
            action: meta?.action || action || "unknown",
            requestId: requestId || undefined,
            type: meta?.type || "result",
            status: overrides.status,
            durationMs: overrides.durationMs,
            payloadType: "binary",
            compression: getWsCompressionLabel(compressionValue),
            payloadBytes: payloadBuffer.length,
            payloadCompressedBytes: compressedBytes,
            dataBytes: dataBuffer.length,
            ...(outgoingSummary || {}),
          });
        };

        const sendText = async (text, overrides = {}) => {
          if (socket.readyState !== 1) return;
          const payloadBuffer = Buffer.from(text || "", "utf8");
          const compressionValue = overrides.compression ?? chooseWsCompression(payloadBuffer.length);
          const { frame: outgoingFrame, compressedBytes } = await encodeWsFrame({
            messageId: overrides.messageId ?? messageId,
            compression: compressionValue,
            payloadType: WS_PAYLOAD_TYPE.text,
            payloadBuffer,
          });
          socket.send(outgoingFrame);
          logStructured("info", "ws.message.sent", {
            connectionId,
            remoteAddress,
            action: overrides.action ?? action,
            requestId: requestId || undefined,
            type: overrides.type || "result",
            status: overrides.status,
            durationMs: overrides.durationMs,
            payloadType: "text",
            compression: getWsCompressionLabel(compressionValue),
            payloadBytes: payloadBuffer.length,
            payloadCompressedBytes: compressedBytes,
          });
        };

        try {
          if (action === "process.run") {
            const result = await runProcessRequest(payload, (stage, detail = {}) => {
              void sendJson("progress", { stage, detail });
            });
            const durationMs = Number(formatDurationMs(startNs).toFixed(1));
            await sendJson("result", { data: result }, { status: "ok", durationMs });
            return;
          }

          const address = this.server.address();
          const localPort = address && typeof address === "object" ? address.port : this.port;
          const data = await proxyApiThroughHttp(localPort, action, payload, requestId, connectionId);
          const durationMs = Number(formatDurationMs(startNs).toFixed(1));
          if (action === "instances.content" && data?.contentType === "image" && data?.dataBase64) {
            const meta = {
              type: "result",
              action,
              contentType: "image",
              mimeType: data.mimeType || "application/octet-stream",
            };
            const binaryData = Buffer.from(data.dataBase64, "base64");
            await sendBinary(meta, binaryData, { status: "ok", durationMs });
            return;
          }
          if (action === "instances.content" && data?.contentType === "text" && typeof data.text === "string") {
            const mimeType = data.mimeType || "text/plain";
            const textPayload = `${mimeType}\n\n${data.text}`;
            await sendText(textPayload, { status: "ok", durationMs });
            return;
          }
          await sendJson("result", { data }, { status: "ok", durationMs });
        } catch (error) {
          const durationMs = Number(formatDurationMs(startNs).toFixed(1));
          logStructured("error", "ws.message.failed", {
            connectionId,
            remoteAddress,
            action: action || "unknown",
            requestId: requestId || undefined,
            durationMs,
            error: normalizeErrorForLog(error),
          });
          await sendJson("error", {
            error: error.message || "Unknown websocket error",
            code: error.code || 500,
          }, { status: "error", durationMs });
        }
      });
    });
  }

  stop() {
    if (this.listening) {
      if (this.wss) {
        this.wss.close();
      }
      this.server.close();
    }
  }
}

module.exports = { HttpServer };
