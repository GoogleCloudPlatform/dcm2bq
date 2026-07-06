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

// Helpers for local-mode rows (paths recorded as file:// URIs by `dcm2bq index`).
// Mirrors src/localfile.js in the main package; duplicated because the
// admin-console Docker image only ships the admin-console directory.

const fs = require("fs").promises;
const path = require("path");
const url = require("url");
const crypto = require("crypto");

function isFileUri(value) {
  return typeof value === "string" && value.startsWith("file://");
}

/**
 * Read a file:// asset, optionally verifying it resolves under a configured root.
 * When rootPath is set, containment is enforced. When unset, any accessible path is served.
 * @param {string} rootPath Optional local root (DCM2BQ_LOCAL_ROOT / admin.localRootPath)
 * @param {string} fileUri file:// URI from a BigQuery row
 * @returns {Promise<Buffer>}
 */
async function readLocalAsset(rootPath, fileUri) {
  let resolvedFile;
  try {
    resolvedFile = await fs.realpath(url.fileURLToPath(fileUri));
  } catch (e) {
    const err = new Error(`Local file is not accessible: ${e.message}`);
    err.statusCode = 404;
    throw err;
  }
  if (rootPath) {
    const resolvedRoot = await fs.realpath(path.resolve(rootPath));
    if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
      const err = new Error(`Local file path escapes the configured root: ${fileUri}`);
      err.statusCode = 403;
      throw err;
    }
  }
  return fs.readFile(resolvedFile);
}

/**
 * Build the synthetic LOCAL_FINALIZE push envelope for reprocessing a local file
 * (the same envelope shape `dcm2bq index` produces). Size is intentionally
 * omitted: the service stats the file itself and must not reject reprocessing
 * because the recorded size is stale.
 */
function buildLocalReprocessEnvelope(fileUri, generation) {
  const data = {
    name: url.fileURLToPath(fileUri),
    generation,
  };
  return {
    message: {
      messageId: `local-reprocess-${crypto.randomBytes(8).toString("hex")}`,
      publishTime: new Date().toISOString(),
      attributes: {
        eventType: "LOCAL_FINALIZE",
      },
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
    },
    subscription: "admin-console-reprocess",
  };
}

/**
 * POST a local reprocess event to the dcm2bq service.
 * @returns {Promise<void>} Resolves on 2xx; throws with the service's reason otherwise.
 */
async function postLocalReprocess(serviceUrl, fileUri, generation) {
  if (!serviceUrl) {
    throw new Error("Local reprocess requires DCM2BQ_SERVICE_URL to be configured for the admin console.");
  }
  const envelope = buildLocalReprocessEnvelope(fileUri, generation);
  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body?.reason) reason += `: ${body.reason}`;
    } catch (e) {
      // Non-JSON error body
    }
    throw new Error(`dcm2bq service rejected local reprocess: ${reason}`);
  }
}

module.exports = { isFileUri, readLocalAsset, buildLocalReprocessEnvelope, postLocalReprocess };
