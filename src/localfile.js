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

const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const { createNonRetryableError } = require("./utils");

const FILE_URI_PREFIX = "file://";

function createLocalTmpFilePath() {
  const tmpFileName = crypto.randomBytes(16).toString("hex");
  return `${os.tmpdir()}/${tmpFileName}.dcm`;
}

async function deleteLocalFile(filePath) {
  await fs.rm(filePath);
}

function isFileUri(uri) {
  return typeof uri === "string" && uri.startsWith(FILE_URI_PREFIX);
}

/**
 * Create a file:// URI path for a local file (the local analogue of gcs.createUriPath).
 * @param {string} filePath Absolute local file path
 * @returns {string} file:// URI
 */
function createUriPath(filePath) {
  return url.pathToFileURL(filePath).href;
}

/**
 * Convert a file:// URI back to a local filesystem path.
 * @param {string} uri file:// URI
 * @returns {string} Absolute local file path
 */
function uriToPath(uri) {
  return url.fileURLToPath(uri);
}

/**
 * Resolve a local file path, optionally verifying it falls under a configured root.
 * When rootPath is set, the path must resolve under it (containment enforced).
 * When rootPath is unset, the path is resolved and verified to exist with no containment check.
 * @param {string} rootPath Optional root to constrain paths to (localConfig.rootPath / DCM2BQ_LOCAL_ROOT)
 * @param {string} filePath The path from the event (absolute)
 * @returns {Promise<string>} The resolved absolute path
 * @throws {Error} Non-retryable error if the path is inaccessible or escapes the root
 */
async function resolveUnderRoot(rootPath, filePath) {
  if (!rootPath) {
    try {
      return await fs.realpath(path.resolve(filePath));
    } catch (e) {
      throw createNonRetryableError(`Local file is not accessible: ${filePath}: ${e.message}`);
    }
  }
  let resolvedRoot;
  try {
    resolvedRoot = await fs.realpath(path.resolve(rootPath));
  } catch (e) {
    throw createNonRetryableError(`localConfig.rootPath is not accessible: ${rootPath}: ${e.message}`);
  }
  let resolvedFile;
  try {
    resolvedFile = await fs.realpath(path.resolve(resolvedRoot, filePath));
  } catch (e) {
    throw createNonRetryableError(`Local file is not accessible: ${filePath}: ${e.message}`);
  }
  if (resolvedFile !== resolvedRoot && !resolvedFile.startsWith(resolvedRoot + path.sep)) {
    throw createNonRetryableError(`Local file path escapes the configured root (${rootPath}): ${filePath}`);
  }
  return resolvedFile;
}

/**
 * Save data under a file:// base path (the local analogue of saving to a GCS bucket path).
 * Creates intermediate directories as needed.
 * @param {string} baseFileUri file:// URI of the output root (e.g. 'file:///data/extract')
 * @param {Buffer|string} data The data to save
 * @param {string} relativePath The file path under the base (e.g. 'study/series/instance.jpg')
 * @returns {Promise<string>} The file:// URI of the saved file
 */
async function saveToLocalPath(baseFileUri, data, relativePath) {
  const basePath = uriToPath(baseFileUri);
  const fullPath = path.resolve(basePath, relativePath);
  if (fullPath !== basePath && !fullPath.startsWith(path.resolve(basePath) + path.sep)) {
    throw createNonRetryableError(`Output file path escapes the configured output root (${baseFileUri}): ${relativePath}`);
  }
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, data);
  return createUriPath(fullPath);
}

module.exports = {
  createLocalTmpFilePath,
  deleteLocalFile,
  isFileUri,
  createUriPath,
  uriToPath,
  resolveUnderRoot,
  saveToLocalPath,
};
