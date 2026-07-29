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

const { fileURLToPath } = require("url");
const { readJson } = require("@pohcee/dcmnorm-node");

const FILE_META_HEADER_KEYS = new Set([
  "FileMetaInformationGroupLength",
  "FileMetaInformationVersion",
  "MediaStorageSOPClassUID",
  "MediaStorageSOPInstanceUID",
  "TransferSyntaxUID",
  "ImplementationClassUID",
  "ImplementationVersionName",
  "SourceApplicationEntityTitle",
  "SendingApplicationEntityTitle",
  "ReceivingApplicationEntityTitle",
  "PrivateInformationCreatorUID",
  "PrivateInformation",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getDcmnormVersion() {
  try {
    const pkg = require("@pohcee/dcmnorm-node/package.json");
    return pkg.version || "unknown";
  } catch (error) {
    return "unavailable";
  }
}

async function parseDicomFileWithDcmnorm(inputPath) {
  try {
    const jsonText = await readJson(inputPath, { format: "flat", bulkData: "uri" });
    return typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText;
  } catch (error) {
    const details = [];
    if (error && typeof error === "object" && error.message) {
      details.push(error.message);
    }
    const detail = details.length > 0 ? ` (${details.join(", ")})` : "";
    throw new Error(`Failed to parse DICOM with dcmnorm${detail}`);
  }
}

function isPrivateTagKey(key) {
  if (!/^x[0-9a-f]{8}$/i.test(key)) {
    return false;
  }
  const group = parseInt(key.substring(1, 5), 16);
  return Number.isInteger(group) && group % 2 === 1;
}

function hasBulkDataUri(value) {
  if (Array.isArray(value)) {
    return value.some((item) => hasBulkDataUri(item));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.BulkDataURI === "string") {
    return true;
  }
  return Object.values(value).some((item) => hasBulkDataUri(item));
}

function applyBulkDataRoot(value, bulkDataRoot) {
  if (!bulkDataRoot) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => applyBulkDataRoot(item, bulkDataRoot));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (key === "BulkDataURI" && typeof itemValue === "string" && itemValue.startsWith("?")) {
      out[key] = `${bulkDataRoot}${itemValue}`;
    } else {
      out[key] = applyBulkDataRoot(itemValue, bulkDataRoot);
    }
  }
  return out;
}

function filterByOutputOptions(json, outputOptions = {}) {
  const out = {};

  for (const [key, rawValue] of Object.entries(json)) {
    if (outputOptions.ignoreGroupLength && /GroupLength$/.test(key)) {
      continue;
    }
    if (outputOptions.ignoreMetaHeader && FILE_META_HEADER_KEYS.has(key)) {
      continue;
    }
    if (outputOptions.ignorePrivate && isPrivateTagKey(key)) {
      continue;
    }
    if (outputOptions.ignoreEmpty && (rawValue === null || rawValue === "" || (Array.isArray(rawValue) && rawValue.length === 0))) {
      continue;
    }
    if (outputOptions.ignoreBinary && hasBulkDataUri(rawValue)) {
      continue;
    }

    let value = applyBulkDataRoot(rawValue, outputOptions.bulkDataRoot || "");
    if (!outputOptions.useArrayWithSingleValue && Array.isArray(value) && value.length === 1) {
      value = value[0];
    }
    out[key] = value;
  }

  return out;
}

class DicomFile {
  constructor(url, parserOptions = {}) {
    if (!(url instanceof URL)) {
      throw "Expected instance of URL for `url` parameter";
    }
    this.url = url;
    this.parserOptions = parserOptions;
  }

  async parse() {
    const inputPath = fileURLToPath(this.url);
    return parseDicomFileWithDcmnorm(inputPath);
  }

  async toJson(outputOptions = {}) {
    const parsed = await this.parse();
    return filterByOutputOptions(parsed, outputOptions);
  }
}

function parseBulkDataUri(bulkDataUri) {
  if (typeof bulkDataUri !== "string") {
    return null;
  }

  try {
    const parsed = new URL(bulkDataUri, "https://dcm2bq.local");
    const offset = Number.parseInt(parsed.searchParams.get("offset"), 10);
    const length = Number.parseInt(parsed.searchParams.get("length"), 10);
    if (Number.isFinite(offset) && Number.isFinite(length)) {
      return { offset, length };
    }
  } catch (error) {
    // Regex fallback for malformed URIs.
  }

  const offsetMatch = bulkDataUri.match(/[?&]offset=(\d+)/);
  const lengthMatch = bulkDataUri.match(/[?&]length=(\d+)/);
  if (!offsetMatch || !lengthMatch) {
    return null;
  }

  return {
    offset: Number.parseInt(offsetMatch[1], 10),
    length: Number.parseInt(lengthMatch[1], 10),
  };
}

module.exports = { DicomFile, parseBulkDataUri };
