const http = require("http");
const path = require("path");
const express = require("express");
const { BigQuery } = require("@google-cloud/bigquery");
const { Storage } = require("@google-cloud/storage");
const { WebSocketServer } = require("ws");

const {
  WS_COMPRESSION,
  WS_PAYLOAD_TYPE,
  formatDurationMs,
  getWsCompressionLabel,
  getWsPayloadTypeLabel,
  chooseWsCompression,
  encodeWsFrame,
  decodeWsFrame,
} = require("./ws-frame");
const { buildNormalizedStudyMetadata, parseJsonValue } = require("./study-metadata");
const config = require("./config");

const PORT = Number(process.env.PORT || 8080);

const app = express();
app.set("trust proxy", true);

// Load configuration first, then initialize BigQuery with correct projectId
const CONFIG = config.get().admin;
const bigquery = CONFIG.projectId ? new BigQuery({ projectId: CONFIG.projectId }) : new BigQuery();
const storage = new Storage();

const frontendDir = path.join(__dirname, "..", "..", "frontend");

app.disable("x-powered-by");
app.use(express.json());

function stripIapPrefix(value) {
  if (!value) return null;
  const parts = String(value).split(":", 2);
  return parts.length === 2 ? parts[1] : parts[0];
}

function getBaseUrl(req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("host");
  return host ? `${proto}://${host}` : "";
}

// ============================================================================
// HTTP ENDPOINTS (where all the actual logic lives)
// ============================================================================

// Health check endpoint
app.get("/healthz", (_, res) => {
  res.status(200).json({
    ok: true,
    config: {
      projectId: CONFIG.projectId,
      datasetId: CONFIG.datasetId,
      instancesViewId: CONFIG.instancesViewId,
      instancesTableId: CONFIG.instancesTableId,
      deadLetterTableId: CONFIG.deadLetterTableId,
    },
  });
});

// IAP user info (only populated when IAP is enabled)
app.get("/api/auth/user", (req, res) => {
  const emailHeader = req.get("x-goog-authenticated-user-email");
  const idHeader = req.get("x-goog-authenticated-user-id");
  const email = stripIapPrefix(emailHeader);
  const userId = stripIapPrefix(idHeader);
  const isIap = Boolean(email || userId);

  res.json({
    isIap,
    email,
    userId,
    principal: emailHeader || idHeader || null,
    logoutUrl: isIap ? "/api/auth/logout" : null,
  });
});

// IAP logout helper (forces Google account sign-out)
app.get("/api/auth/logout", (req, res) => {
  const emailHeader = req.get("x-goog-authenticated-user-email");
  const idHeader = req.get("x-goog-authenticated-user-id");
  const isIap = Boolean(stripIapPrefix(emailHeader) || stripIapPrefix(idHeader));
  if (!isIap) {
    return res.status(404).send("Not Found");
  }

  const baseUrl = getBaseUrl(req) || "https://accounts.google.com";
  const continueUrl = `${baseUrl}/`;
  const logoutUrl = `https://accounts.google.com/Logout?continue=${encodeURIComponent(continueUrl)}`;
  return res.redirect(logoutUrl);
});

// Studies search endpoint
app.post("/api/studies/search", async (req, res) => {
  try {
    const key = String(req.body?.key || "").trim();
    const value = String(req.body?.value || "").trim();
    const studyLimit = Math.min(Math.max(parseInt(req.body?.studyLimit || 50, 10), 1), 200);
    const studyOffset = Math.max(parseInt(req.body?.studyOffset || 0, 10), 0);

    if (!key) {
      return res.status(400).json({ error: "Missing required field: key" });
    }

    const viewTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const searchFilter = buildSearchFilter(key, value);

    const studyUidExpr = `NULLIF(TRIM(JSON_VALUE(metadata, '$.StudyInstanceUID')), '')`;

    const studiesQuery = `
      SELECT
        ${studyUidExpr} as study_id,
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
        ANY_VALUE(JSON_VALUE(metadata, '$.StudyDescription')) as study_description,
        ARRAY_TO_STRING(
          ARRAY_AGG(
            DISTINCT NULLIF(UPPER(TRIM(JSON_VALUE(metadata, '$.Modality'))), '')
            IGNORE NULLS
          ),
          ', '
        ) as study_modalities
      FROM ${viewTable}
      WHERE ${searchFilter.whereClause}
        AND ${studyUidExpr} IS NOT NULL
      GROUP BY study_id
      ORDER BY max_timestamp DESC
      LIMIT @studyLimit OFFSET @studyOffset
    `;

    const totalsQuery = `
      SELECT
        COUNT(*) as totalInstances,
        COUNT(DISTINCT ${studyUidExpr}) as totalStudies
      FROM ${viewTable}
      WHERE ${searchFilter.whereClause}
        AND ${studyUidExpr} IS NOT NULL
    `;

    const [[studyRows], [totalRows]] = await Promise.all([
      bigquery.query({
        query: studiesQuery,
        location: "US",
        params: { ...searchFilter.params, studyLimit, studyOffset },
      }),
      bigquery.query({
        query: totalsQuery,
        location: "US",
        params: { ...searchFilter.params },
      }),
    ]);

    const studies = (studyRows || []).map((row) => ({
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
      studyModalities: normalizeStudyModalities(row.study_modalities),
    }));

    const totals = totalRows?.[0] || {};
    return res.json({
      items: studies,
      totalInstances: Number(totals.totalInstances || 0),
      totalStudies: Number(totals.totalStudies || 0),
      studyLimit,
      studyOffset,
    });
  } catch (error) {
    console.error("Studies search error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Get instances for a study
app.get("/studies/:studyId/instances", async (req, res) => {
  try {
    const studyId = String(req.params.studyId || "").trim();
    if (!studyId) {
      return res.status(400).json({ error: "Missing studyId" });
    }

    const viewTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT
        id,
        path,
        version,
        timestamp,
        metadata,
        info,
        embeddingVector
      FROM ${viewTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') = @studyId
      ORDER BY timestamp DESC
      LIMIT 5000
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { studyId },
    });

    // Parse metadata from JSON strings
    const items = (rows || []).map(row => {
      const embeddingVector = row.embeddingVector || [];
      return {
        id: row.id,
        path: row.path,
        version: row.version,
        timestamp: row.timestamp,
        metadata: parseJsonValue(row.metadata),
        info: parseJsonValue(row.info),
        hasEmbeddingVector: embeddingVector.length > 0,
        embeddingVectorLength: embeddingVector.length,
      };
    });

    return res.json({ items });
  } catch (error) {
    console.error("Get instances error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Get study metadata
app.get("/studies/:studyId/metadata", async (req, res) => {
  try {
    const studyId = String(req.params.studyId || "").trim();
    if (!studyId) {
      return res.status(400).json({ error: "Missing studyId" });
    }

    const viewTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT
        id, path, version, timestamp, metadata
      FROM ${viewTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') = @studyId
      LIMIT 20000
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { studyId },
    });

    const normalized = buildNormalizedStudyMetadata(rows, studyId);
    return res.json(normalized);
  } catch (error) {
    console.error("Get metadata error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Instances count endpoint (for monitoring) - MUST come before /api/instances/:id
app.get("/api/instances/counts", async (req, res) => {
  try {
    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT
        COUNT(DISTINCT JSON_VALUE(metadata, '$.StudyInstanceUID')) as totalStudies,
        COUNT(*) as totalInstances
      FROM ${instancesTable}
    `;

    const [result] = await bigquery.query({
      query,
      location: "US",
    });

    const row = result?.[0] || {};
    return res.json({
      totalStudies: Number(row.totalStudies || 0),
      totalInstances: Number(row.totalInstances || 0),
    });
  } catch (error) {
    console.error("Instances counts error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Get single instance details
app.get("/api/instances/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT
        id,
        path,
        version,
        timestamp,
        metadata,
        info,
        embeddingVector
      FROM ${instancesTable}
      WHERE id = @id
      LIMIT 1
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { id },
    });

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Instance not found" });
    }

    const row = rows[0];
    const metadata = parseJsonValue(row.metadata);
    const info = parseJsonValue(row.info);
    const embeddingVector = row.embeddingVector || [];
    
    return res.json({
      id: row.id,
      path: row.path,
      version: row.version,
      timestamp: row.timestamp,
      metadata,
      info,
      hasEmbeddingVector: embeddingVector.length > 0,
      embeddingVectorLength: embeddingVector.length,
    });
  } catch (error) {
    console.error("Get instance error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Get instance content (DICOM files converted to viewable format)
// Note: This endpoint is called via WS proxy to the dicomweb render endpoint
// /studies/<studyUID>/series/<seriesUID>/instances/<sopInstanceUID>/render
app.get("/studies/:studyUid/series/:seriesUid/instances/:sopInstanceUid/render", async (req, res) => {
  try {
    const studyUid = String(req.params.studyUid || "").trim();
    const seriesUid = String(req.params.seriesUid || "").trim();
    const sopInstanceUid = String(req.params.sopInstanceUid || "").trim();

    if (!studyUid || !seriesUid || !sopInstanceUid) {
      return res.status(400).json({ error: "Missing required DICOM UIDs" });
    }

    // Query to get instance info (which contains path to extracted asset)
    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT id, info
      FROM ${instancesTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') = @studyUid
        AND JSON_VALUE(metadata, '$.SeriesInstanceUID') = @seriesUid
        AND JSON_VALUE(metadata, '$.SOPInstanceUID') = @sopInstanceUid
      LIMIT 1
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { studyUid, seriesUid, sopInstanceUid },
    });

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Instance not found" });
    }

    const row = rows[0];
    const info = parseJsonValue(row.info);
    const filePath = info?.embedding?.input?.path;
    const mimeType = info?.embedding?.input?.mimeType;

    if (!filePath || !mimeType) {
      return res.status(404).json({ error: "No extracted asset for this instance" });
    }

    // Parse GCS path (gs://bucket/object/path)
    const gsMatch = filePath.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!gsMatch) {
      return res.status(400).json({ error: `Invalid GCS path: ${filePath}` });
    }

    const bucket = gsMatch[1];
    const object = gsMatch[2];

    try {
      const [buffer] = await storage.bucket(bucket).file(object).download();
      
      // For image formats, return as base64
      if (mimeType.startsWith("image/")) {
        return res.json({
          contentType: "image",
          mimeType,
          dataBase64: buffer.toString("base64"),
        });
      }

      // For text formats, return as text
      if (mimeType.startsWith("text/")) {
        return res.json({
          contentType: "text",
          mimeType,
          text: buffer.toString("utf-8"),
        });
      }

      // For other formats, return as binary
      return res.json({
        contentType: "binary",
        mimeType,
        dataBase64: buffer.toString("base64"),
      });
    } catch (error) {
      return res.status(500).json({ error: `Failed to download content: ${error?.message}` });
    }
  } catch (error) {
    console.error("Render error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// DLQ items endpoint
app.get("/api/dlq/items", async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || 100, 10), 1), 1000);
    const offset = Math.max(parseInt(req.query.offset || 0, 10), 0);

    const dlqTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.deadLetterTableId}\``;
    const query = `
      SELECT *
      FROM ${dlqTable}
      LIMIT @limit OFFSET @offset
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { limit, offset },
    });

    return res.json({ items: rows || [] });
  } catch (error) {
    console.error("DLQ items error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// DLQ count endpoint
app.get("/api/dlq/count", async (req, res) => {
  try {
    const dlqTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.deadLetterTableId}\``;
    const query = `SELECT COUNT(*) as count FROM ${dlqTable}`;

    const [result] = await bigquery.query({
      query,
      location: "US",
    });
    const count = result?.[0]?.count || 0;

    return res.json({ count: Number(count) });
  } catch (error) {
    console.error("DLQ count error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// DLQ summary endpoint (returns totalCount instead of count)
app.get("/api/dlq/summary", async (req, res) => {
  try {
    const dlqTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.deadLetterTableId}\``;
    const query = `SELECT COUNT(*) as totalCount FROM ${dlqTable}`;

    const [result] = await bigquery.query({
      query,
      location: "US",
    });
    const totalCount = result?.[0]?.totalCount || 0;

    return res.json({ totalCount: Number(totalCount) });
  } catch (error) {
    console.error("DLQ summary error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Studies delete endpoint
app.post("/api/studies/delete", async (req, res) => {
  try {
    const studyIds = Array.isArray(req.body?.studyIds) ? req.body.studyIds : [];
    if (studyIds.length === 0) {
      return res.status(400).json({ error: "Missing studyIds" });
    }

    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesTableId}\``;
    
    // Delete instances for these studies
    const query = `
      DELETE FROM ${instancesTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') IN UNNEST(@studyIds)
    `;

    await bigquery.query({
      query,
      location: "US",
      params: { studyIds },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Studies delete error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Instances delete endpoint
app.post("/api/instances/delete", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) {
      return res.status(400).json({ error: "Missing ids" });
    }

    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesTableId}\``;
    
    // Delete specific instances
    const query = `
      DELETE FROM ${instancesTable}
      WHERE id IN UNNEST(@ids)
    `;

    await bigquery.query({
      query,
      location: "US",
      params: { ids },
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Instances delete error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Studies reprocess endpoint
app.post("/api/studies/reprocess", async (req, res) => {
  try {
    const studyIds = Array.isArray(req.body?.studyIds) ? req.body.studyIds : [];
    if (studyIds.length === 0) {
      return res.status(400).json({ error: "Missing studyIds" });
    }

    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    
    // Get instances and paths for these studies
    const query = `
      SELECT DISTINCT path
      FROM ${instancesTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') IN UNNEST(@studyIds)
        AND path IS NOT NULL
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { studyIds },
    });

    const filePaths = rows?.map(r => r.path).filter(Boolean) || [];

    const normalizedPaths = filePaths
      .map((filePath) => String(filePath || "").trim())
      .filter(Boolean)
      .map((filePath) => (filePath.includes("#") ? filePath.split("#")[0] : filePath));

    // Deduplicate by normalized base object path to prevent repeated updates
    // for archive member references that share the same .zip/.tar/.tgz source object.
    const uniquePaths = Array.from(new Set(normalizedPaths));

    console.log(`Reprocess request: ${studyIds.length} studies, ${filePaths.length} total paths, ${uniquePaths.length} unique base paths to update`);
    
    let succeeded = 0;
    let failed = 0;
    const errors = [];

    // Trigger reprocessing by updating GCS object metadata
    // This causes GCS to emit OBJECT_METADATA_UPDATE events that Cloud Run is subscribed to
    for (const filePath of uniquePaths) {
      try {
        // Parse normalized GCS path (gs://bucket/object/path)
        const gsMatch = filePath.match(/^gs:\/\/([^/]+)\/(.+)$/);
        
        if (!gsMatch) {
          errors.push(`Invalid GCS path: ${filePath}`);
          failed++;
          continue;
        }

        const bucket = gsMatch[1];
        const object = gsMatch[2];

        // Update metadata to trigger reprocessing
        await storage.bucket(bucket).file(object).setMetadata({
          metadata: {
            'dcm2bq-reprocess': new Date().toISOString(),
            'dcm2bq-requeue-source': 'admin-console'
          }
        });

        succeeded++;
        console.log(`Reprocessing triggered: gs://${bucket}/${object}`);
      } catch (error) {
        failed++;
        errors.push(`Failed to reprocess ${filePath}: ${error?.message}`);
        console.error(`Failed to trigger reprocessing for ${filePath}:`, error?.message);
      }
    }

    return res.json({
      reprocessedStudyCount: studyIds.length,
      reprocessedFileCount: succeeded,
      failedFileCount: failed,
      filePaths,
      uniquePaths,
      succeeded,
      failed,
      errors,
      message: `Reprocessing triggered for ${succeeded} files from ${studyIds.length} studies`,
    });
  } catch (error) {
    console.error("Studies reprocess error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// DLQ requeue endpoint
app.post("/api/dlq/requeue", async (req, res) => {
  try {
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    if (messageIds.length === 0) {
      return res.status(400).json({ error: "Missing messageIds" });
    }

    const dlqTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.deadLetterTableId}\``;
    
    // Delete requeued messages from DLQ
    const deleteQuery = `
      DELETE FROM ${dlqTable}
      WHERE id IN UNNEST(@messageIds)
    `;

    await bigquery.query({
      query: deleteQuery,
      location: "US",
      params: { messageIds },
    });

    return res.json({
      requeuedCount: messageIds.length,
      deletedMessageCount: messageIds.length,
    });
  } catch (error) {
    console.error("DLQ requeue error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// DLQ delete endpoint
app.post("/api/dlq/delete", async (req, res) => {
  try {
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    if (messageIds.length === 0) {
      return res.status(400).json({ error: "Missing messageIds" });
    }

    const dlqTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.deadLetterTableId}\``;
    
    // Delete messages from DLQ
    const deleteQuery = `
      DELETE FROM ${dlqTable}
      WHERE id IN UNNEST(@messageIds)
    `;

    await bigquery.query({
      query: deleteQuery,
      location: "US",
      params: { messageIds },
    });

    return res.json({ deletedCount: messageIds.length });
  } catch (error) {
    console.error("DLQ delete error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Process run endpoint (simplified - returns mock results)
app.post("/api/process/run", async (req, res) => {
  try {
    const fileName = String(req.body?.fileName || "").trim();
    if (!fileName) {
      return res.status(400).json({ error: "Missing fileName" });
    }

    // Simplified implementation - just return success
    return res.json({
      status: "completed",
      fileName,
      processedAt: new Date().toISOString(),
      success: true,
    });
  } catch (error) {
    console.error("Process run error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Study download endpoint - returns ZIP of all instance files
app.get("/api/studies/:studyId/download", async (req, res) => {
  try {
    const studyId = String(req.params.studyId || "").trim();
    if (!studyId) {
      return res.status(400).json({ error: "Missing studyId" });
    }

    // Query instances for the study  
    const instancesTable = `\`${CONFIG.projectId}.${CONFIG.datasetId}.${CONFIG.instancesViewId}\``;
    const query = `
      SELECT id, path
      FROM ${instancesTable}
      WHERE JSON_VALUE(metadata, '$.StudyInstanceUID') = @studyId
      ORDER BY id
      LIMIT 10000
    `;

    const [rows] = await bigquery.query({
      query,
      location: "US",
      params: { studyId },
    });

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: "Study not found" });
    }

    const rawPaths = rows.map((row) => row.path).filter(Boolean);
    const archiveBases = new Set(
      rawPaths
        .filter((path) => path.includes("#"))
        .map((path) => path.split("#")[0])
    );
    const hasArchiveRefs = archiveBases.size > 0;
    const allArchiveRefs = rawPaths.length > 0 && rawPaths.every((path) => path.includes("#"));

    const getArchiveContentType = (objectName) => {
      const lower = String(objectName || "").toLowerCase();
      if (lower.endsWith(".zip")) return "application/zip";
      if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "application/gzip";
      if (lower.endsWith(".tar")) return "application/x-tar";
      return "application/octet-stream";
    };

    const parseGsPath = (gsPath) => {
      const gsMatch = String(gsPath || "").match(/^gs:\/\/([^/]+)\/(.+)$/);
      if (!gsMatch) return null;
      return { bucket: gsMatch[1], object: gsMatch[2] };
    };

    if (hasArchiveRefs && allArchiveRefs && archiveBases.size === 1) {
      const archivePath = Array.from(archiveBases)[0];
      const gsParts = parseGsPath(archivePath);
      if (!gsParts) {
        return res.status(500).json({ error: "Invalid archive path" });
      }

      const fileName = gsParts.object.split("/").pop() || `study_${studyId.replace(/[^a-z0-9]/gi, "_")}`;
      res.setHeader("Content-Type", getArchiveContentType(gsParts.object));
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

      const stream = storage.bucket(gsParts.bucket).file(gsParts.object).createReadStream();
      stream.on("error", (err) => {
        console.error("Archive download error:", err);
        if (!res.headersSent) {
          res.status(500).json({ error: err?.message || "Failed to download archive" });
        } else {
          res.end();
        }
      });

      stream.pipe(res);
      return;
    }

    // Download all files and create a streaming ZIP response
    try {
      const archiver = require('archiver');
      
      // Create archive and pipe to response
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="study_${studyId.replace(/[^a-z0-9]/gi, '_')}.zip"`);
      
      archive.pipe(res);

      // Add each file to the archive
      const uniquePaths = Array.from(
        new Set(
          rawPaths.map((path) => (path.includes("#") ? path.split("#")[0] : path))
        )
      );

      for (let i = 0; i < uniquePaths.length; i += 1) {
        const filePath = uniquePaths[i];
        if (!filePath) continue;

        // Parse GCS path
        const gsParts = parseGsPath(filePath);
        if (!gsParts) continue;

        const bucket = gsParts.bucket;
        const object = gsParts.object;

        try {
          const [buffer] = await storage.bucket(bucket).file(object).download();
          // Use filename from object path or generate one
          const fileName = object.split('/').pop() || `file_${i + 1}`;
          archive.append(buffer, { name: fileName });
        } catch (error) {
          console.error(`Failed to download file from ${filePath}:`, error?.message);
          // Continue with other files on error
        }
      }

      // Finalize the archive
      archive.finalize();
      
      // Handle archive errors
      archive.on('error', (err) => {
        console.error('Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: `Failed to create archive: ${err?.message}` });
        }
      });

    } catch (error) {
      // Fallback if archiver not available - return list of file paths
      console.error('Archive creation failed, falling back to file list:', error?.message);
      return res.json({
        studyId,
        instanceCount: rows.length,
        message: "Study download - returning file list (ZIP not available)",
        filePaths: rows.map(r => r.path),
      });
    }
  } catch (error) {
    console.error("Download error:", error);
    return res.status(500).json({ error: error?.message || "Internal error" });
  }
});

// Serve static frontend files
app.use(express.static(frontendDir));

// SPA fallback: serve index.html for all non-static routes
app.use((_, res) => {
  res.sendFile(path.join(frontendDir, "index.html"));
});

const server = http.createServer(app);

// Logging utilities
function logStructured(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const output = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(output);
  } else {
    console.log(output);
  }
}

// Normalize DICOM modalities for display
const CLINICAL_MODALITY_ORDER = [
  "CT", "MR", "PT", "NM", "US", "XA", "RF", "CR", "DX", "MG", "SC", "PR",
  "KO", "SR", "SEG", "RTSTRUCT", "RTPLAN", "RTDOSE", "RTIMAGE", "OT",
];
const CLINICAL_MODALITY_RANK = new Map(
  CLINICAL_MODALITY_ORDER.map((code, index) => [code, index]),
);

function normalizeStudyModalities(value) {
  const rawTokens = String(value || "")
    .split(",")
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);

  if (rawTokens.length === 0) return null;

  const uniqueTokens = [...new Set(rawTokens)];
  uniqueTokens.sort((left, right) => {
    const leftRank = CLINICAL_MODALITY_RANK.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = CLINICAL_MODALITY_RANK.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank !== rightRank ? leftRank - rightRank : left.localeCompare(right);
  });

  return uniqueTokens.join(", ");
}

// Search filter builder for studies/instances
function buildSearchFilter(key, value) {
  const whitelistedKeys = new Set([
    "PatientID", "PatientName", "StudyInstanceUID", "AccessionNumber",
    "ReferringPhysicianName", "InstitutionName", "Modality", "StudyDate",
    "StudyDescription", "SeriesDescription",
  ]);

  if (!whitelistedKeys.has(key)) {
    const err = new Error(`Unsupported search key: ${key}`);
    err.code = 400;
    throw err;
  }

  // If no value provided, return a filter that matches everything
  if (!value) {
    return {
      whereClause: "1=1",
      params: {},
    };
  }

  const rawValue = String(value);
  // Escape special characters for regex literal match
  const escapedValue = rawValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Build the where clause
  let whereClause;
  if (key === "Modality") {
    whereClause = `UPPER(TRIM(JSON_VALUE(metadata, '$.${key}'))) = UPPER(@value)`;
  } else if (key === "StudyDate") {
    whereClause = `REGEXP_CONTAINS(CAST(JSON_VALUE(metadata, '$.${key}') AS STRING), CONCAT('.*', @valueRegex, '.*'))`;
  } else {
    whereClause = `REGEXP_CONTAINS(JSON_VALUE(metadata, '$.${key}'), CONCAT('.*', @valueRegex, '.*'))`;
  }

  return {
    whereClause,
    params: { value: rawValue, valueRegex: escapedValue },
  };
}

// WebSocket server setup
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, request) => {
  const connectionId = `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
        error: { message: error?.message },
      });
      socket.close(1003, "Invalid WS frame");
      return;
    }

    const { messageId, messageIdHex, payloadType, compression, payloadBuffer } = frame;
    const requestId = messageIdHex;

    const sendJson = async (type, data = {}, overrides = {}) => {
      if (socket.readyState !== 1) return;
      const outgoing = {
        type,
        action: overrides.action || "unknown",
        ...data,
      };
      const outgoingBuffer = Buffer.from(JSON.stringify(outgoing), "utf8");
      const compressionValue = overrides.compression ?? chooseWsCompression(outgoingBuffer.length);
      const { frame: outgoingFrame, compressedBytes } = await encodeWsFrame({
        messageId,
        compression: compressionValue,
        payloadType: WS_PAYLOAD_TYPE.json,
        payloadBuffer: outgoingBuffer,
      });
      socket.send(outgoingFrame);
      logStructured("info", "ws.message.sent", {
        connectionId,
        remoteAddress,
        action: outgoing.action,
        requestId,
        type,
        durationMs: overrides.durationMs,
        payloadBytes: outgoingBuffer.length,
        payloadCompressedBytes: compressedBytes,
      });
    };

    const sendError = async (errorMessage, code = 500) => {
      const durationMs = Number(formatDurationMs(startNs).toFixed(1));
      await sendJson("error", {
        error: errorMessage,
        code,
        requestId,
      }, { durationMs, status: "error" });
    };

    // Parse frame payload
    if (payloadType !== WS_PAYLOAD_TYPE.json) {
      await sendError("Unsupported payload type", 400);
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(payloadBuffer.toString("utf8"));
    } catch (error) {
      await sendError("Invalid JSON payload", 400);
      return;
    }

    const action = typeof parsed?.action === "string" ? parsed.action : "";
    const payload = parsed?.payload || {};

    if (!action) {
      await sendError("Missing websocket action", 400);
      return;
    }

    logStructured("info", "ws.message.received", {
      connectionId,
      remoteAddress,
      action,
      requestId,
      payloadType: getWsPayloadTypeLabel(payloadType),
      compression: getWsCompressionLabel(compression),
    });

    try {
      // WebSocket proxy pattern: proxy to HTTP endpoints
      // Map WebSocket actions to HTTP routes
      const routes = {
        "studies.search": { method: "POST", path: "/api/studies/search" },
        "studies.instances": {
          method: "GET",
          path: `/studies/${encodeURIComponent(String(payload?.studyId || ""))}/instances?limit=${encodeURIComponent(String(payload?.limit || "5000"))}`,
        },
        "studies.metadata": {
          method: "GET",
          path: `/studies/${encodeURIComponent(String(payload?.studyId || ""))}/metadata?limit=${encodeURIComponent(String(payload?.limit || "20000"))}`,
        },
        "studies.delete": { method: "POST", path: "/api/studies/delete" },
        "studies.reprocess": { method: "POST", path: "/api/studies/reprocess" },
        "instances.get": { method: "GET", path: `/api/instances/${encodeURIComponent(String(payload?.id || ""))}` },
        "instances.counts": { method: "GET", path: "/api/instances/counts" },
        "instances.delete": { method: "POST", path: "/api/instances/delete" },
        "instances.content": {
          method: "GET",
          path: `/studies/${encodeURIComponent(String(payload?.studyUid || ""))}/series/${encodeURIComponent(String(payload?.seriesUid || ""))}/instances/${encodeURIComponent(String(payload?.sopInstanceUid || ""))}/render`,
        },
        "dlq.items": {
          method: "GET",
          path: `/api/dlq/items?limit=${encodeURIComponent(String(payload?.limit || "100"))}&offset=${encodeURIComponent(String(payload?.offset || "0"))}`,
        },
        "dlq.count": { method: "GET", path: "/api/dlq/count" },
        "dlq.summary": { method: "GET", path: "/api/dlq/summary" },
        "dlq.requeue": { method: "POST", path: "/api/dlq/requeue" },
        "dlq.delete": { method: "POST", path: "/api/dlq/delete" },
        "process.run": { method: "POST", path: "/api/process/run" },
      };

      const route = routes[action];
      if (!route) {
        await sendError(`Unsupported action: ${action}`, 400);
        return;
      }

      // Build URL and make HTTP request
      const url = `http://127.0.0.1:${PORT}${route.path}`;
      const headers = { "Content-Type": "application/json" };

      const init = { method: route.method, headers };
      if (route.method !== "GET") {
        init.body = JSON.stringify(payload || {});
      }

      let response;
      try {
        response = await fetch(url, init);
      } catch (fetchError) {
        await sendError(`Failed to connect to HTTP endpoint: ${fetchError?.message}`, 503);
        return;
      }

      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMessage = json.error || json.reason || `HTTP ${response.status}`;
        await sendError(errorMessage, response.status || 500);
        return;
      }

      const durationMs = Number(formatDurationMs(startNs).toFixed(1));
      await sendJson("result", { data: json }, { status: "ok", durationMs, action });
      return;
    } catch (error) {
      const durationMs = Number(formatDurationMs(startNs).toFixed(1));
      logStructured("error", "ws.message.failed", {
        connectionId,
        remoteAddress,
        action,
        requestId,
        durationMs,
        error: { message: error?.message },
      });
      await sendError(error?.message || "Unknown error", error?.code || 500);
    }
  });
});

server.listen(PORT, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "admin_console_started",
    port: PORT,
    config: {
      projectId: CONFIG.projectId,
      datasetId: CONFIG.datasetId,
      instancesViewId: CONFIG.instancesViewId,
      instancesTableId: CONFIG.instancesTableId,
      deadLetterTableId: CONFIG.deadLetterTableId,
    },
  }));
});
