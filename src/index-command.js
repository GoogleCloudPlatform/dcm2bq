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

/**
 * `dcm2bq index` — ingest local DICOM files by synthesizing LOCAL_FINALIZE push
 * envelopes (the same shape Pub/Sub push would deliver) and POSTing them to a
 * running dcm2bq service. This exercises the full pipeline locally: schema
 * matching, parsing, visual extraction, embeddings, and BigQuery persistence.
 * The service must be started with localConfig.rootPath (or DCM2BQ_LOCAL_ROOT)
 * covering the indexed path.
 */

const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const crypto = require("crypto");
const consts = require("./consts");

const SUPPORTED_EXTENSIONS = [".dcm", ".dicom", ".zip", ".tar.gz", ".tgz"];

function isSupportedFile(filePath) {
  const lower = filePath.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Recursively collect supported DICOM/archive files under a path.
 * @param {string} inputPath File or directory path
 * @returns {Promise<string[]>} Absolute paths of supported files
 */
async function collectFiles(inputPath) {
  const stats = await fsp.stat(inputPath);
  if (stats.isFile()) {
    if (!isSupportedFile(inputPath)) {
      throw new Error(`Unsupported file type: ${inputPath} (expected one of: ${SUPPORTED_EXTENSIONS.join(", ")})`);
    }
    return [path.resolve(inputPath)];
  }

  const files = [];
  const entries = await fsp.readdir(inputPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(inputPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      files.push(path.resolve(fullPath));
    }
  }
  return files;
}

/**
 * Build the generation (version) for a file. Defaults to the file mtime in
 * microseconds, mirroring GCS generation semantics: re-indexing an unchanged
 * file yields the same insertId and is absorbed by BigQuery streaming dedup,
 * while a modified file lands as a new row. --force synthesizes a fresh
 * generation so an unchanged file is deliberately reprocessed as a new row.
 */
function buildGeneration(stats, force) {
  if (force) {
    const nonce = Math.random().toString(36).slice(2, 8);
    return `index-${Date.now()}-${nonce}`;
  }
  return String(Math.floor(stats.mtimeMs * 1000));
}

/**
 * Build the synthetic Pub/Sub push envelope for a local file event.
 */
function buildLocalEnvelope(filePath, stats, generation) {
  const data = {
    name: filePath,
    size: stats.size,
    generation,
  };
  return {
    message: {
      messageId: `local-${crypto.randomBytes(8).toString("hex")}`,
      publishTime: new Date().toISOString(),
      attributes: {
        eventType: consts.LOCAL_FINALIZE,
      },
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
    },
    subscription: "local-index",
  };
}

/**
 * POST one file's envelope to the service. Returns { ok, status, reason }.
 */
async function postFile(serviceUrl, filePath, force) {
  const stats = await fsp.stat(filePath);
  if (stats.size === 0) {
    return { ok: false, status: null, reason: "empty file (0 bytes), skipped" };
  }
  const generation = buildGeneration(stats, force);
  const envelope = buildLocalEnvelope(filePath, stats, generation);
  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (response.ok) {
    return { ok: true, status: response.status, generation };
  }
  let reason = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.reason) reason += `: ${body.reason}`;
  } catch (e) {
    // Non-JSON error body; status alone is enough
  }
  return { ok: false, status: response.status, reason };
}

/**
 * Verify the service is reachable and looks like dcm2bq.
 */
async function checkService(serviceUrl) {
  let response;
  try {
    response = await fetch(serviceUrl, { method: "GET" });
  } catch (e) {
    throw new Error(
      `Cannot reach dcm2bq service at ${serviceUrl}: ${e.message}. ` +
        `Start it with 'dcm2bq service' (with DCM2BQ_LOCAL_ROOT set), or pass --service-url.`
    );
  }
  try {
    const body = await response.json();
    if (body?.name) {
      console.log(`Connected to ${body.name} v${body.version} at ${serviceUrl}`);
    }
  } catch (e) {
    console.warn(`Warning: service at ${serviceUrl} did not return the expected version response.`);
  }
}

async function indexFiles(serviceUrl, files, force) {
  let succeeded = 0;
  let failed = 0;
  for (const filePath of files) {
    try {
      const result = await postFile(serviceUrl, filePath, force);
      if (result.ok) {
        succeeded++;
        console.log(`OK   ${filePath}`);
      } else {
        failed++;
        console.error(`FAIL ${filePath}: ${result.reason}`);
      }
    } catch (error) {
      failed++;
      console.error(`FAIL ${filePath}: ${error.message}`);
    }
  }
  return { succeeded, failed };
}

/**
 * Watch a directory (or a single file's directory) and index new/changed
 * supported files. Events are debounced per path so a file is only posted
 * once its writes have settled.
 */
function watchAndIndex(serviceUrl, inputPath, isDirectory, force) {
  const watchDir = isDirectory ? inputPath : path.dirname(inputPath);
  const pendingTimers = new Map();
  const postedGenerations = new Map();
  const DEBOUNCE_MS = 1000;

  console.log(`Watching ${watchDir} for new or changed files (Ctrl+C to stop)...`);

  const watcher = fs.watch(watchDir, { recursive: true }, (eventType, relativePath) => {
    if (!relativePath) return;
    const fullPath = path.resolve(watchDir, relativePath);
    if (!isSupportedFile(fullPath)) return;
    if (!isDirectory && fullPath !== path.resolve(inputPath)) return;

    // Debounce: restart the timer on every event for this path
    clearTimeout(pendingTimers.get(fullPath));
    pendingTimers.set(
      fullPath,
      setTimeout(async () => {
        pendingTimers.delete(fullPath);
        let stats;
        try {
          stats = await fsp.stat(fullPath);
        } catch (e) {
          return; // Deleted or unreadable; nothing to index
        }
        if (!stats.isFile() || stats.size === 0) return;
        const generation = buildGeneration(stats, false);
        if (postedGenerations.get(fullPath) === generation) return;
        try {
          const result = await postFile(serviceUrl, fullPath, force);
          if (result.ok) {
            postedGenerations.set(fullPath, generation);
            console.log(`OK   ${fullPath}`);
          } else {
            console.error(`FAIL ${fullPath}: ${result.reason}`);
          }
        } catch (error) {
          console.error(`FAIL ${fullPath}: ${error.message}`);
        }
      }, DEBOUNCE_MS)
    );
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

async function execute(inputPath, options) {
  const serviceUrl = options.serviceUrl || process.env.DCM2BQ_SERVICE_URL || "http://localhost:8080";
  const force = !!options.force;

  const resolvedPath = path.resolve(inputPath);
  const stats = await fsp.stat(resolvedPath).catch(() => {
    throw new Error(`Path not found: ${resolvedPath}`);
  });

  await checkService(serviceUrl);

  const files = await collectFiles(resolvedPath);
  if (files.length === 0 && !options.watch) {
    throw new Error(`No supported DICOM files found under ${resolvedPath} (looked for: ${SUPPORTED_EXTENSIONS.join(", ")})`);
  }

  if (files.length > 0) {
    console.log(`Indexing ${files.length} file(s)...`);
    const { succeeded, failed } = await indexFiles(serviceUrl, files, force);
    console.log(`Done: ${succeeded} succeeded, ${failed} failed.`);
    if (failed > 0 && !options.watch) {
      process.exitCode = 1;
    }
  }

  if (options.watch) {
    watchAndIndex(serviceUrl, resolvedPath, stats.isDirectory(), force);
  }
}

module.exports = { execute, collectFiles, buildGeneration, buildLocalEnvelope, isSupportedFile };
