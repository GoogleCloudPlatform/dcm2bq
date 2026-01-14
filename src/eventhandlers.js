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

const consts = require("./consts");
const config = require("./config");
const { DicomInMemory } = require("./dicomtojson");
const bq = require("./bigquery");
const gcs = require("./gcs");
const hcapi = require("./hcapi");
const { createVectorEmbedding } = require("./embeddings");
const { deepAssign, DEBUG_MODE } = require("./utils");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");
const embedConfig = config.get().gcpConfig.embeddings;

// TODO: Include the metaHash for all files

/**
 * Process and persist a single DICOM file.
 * @param {string} basePath The original path of the source file (used for file ID)
 * @param {number} version The version identifier
 * @param {Date} timestamp The timestamp of the event
 * @param {Buffer} dicomBuffer The DICOM file content
 * @param {string} uriPath The URI path for this file
 * @param {string} eventType The event type
 * @param {number} fileSize The size of the file
 * @param {string} storageType The type of storage (GCS, DICOMWEB, etc)
 * @returns {Promise<void>}
 */
async function processAndPersistDicom(basePath, version, timestamp, dicomBuffer, uriPath, eventType, fileSize, storageType) {
  const { metadata, embeddings } = await processDicom(dicomBuffer, uriPath);
  
  const infoObj = {
    event: eventType,
    storage: { size: fileSize, type: storageType },
    embeddings: { model: embedConfig.model },
  };
  
  const writeObj = {
    timestamp,
    path: basePath,
    version,
  };
  
  const objectMetadata = embeddings && (embeddings.objectPath || embeddings.objectSize || embeddings.objectMimeType)
    ? { path: embeddings.objectPath, size: embeddings.objectSize, mimeType: embeddings.objectMimeType }
    : null;
  
  await persistRow(writeObj, infoObj, metadata, embeddings, objectMetadata);
}

/**
 * Processes a DICOM file buffer to extract metadata and optionally generate a vector embedding.
 * @param {Buffer} buffer The DICOM file content as a buffer.
 * @param {string} uriPath The URI of the DICOM file.
 * @returns {Promise<{metadata: string, size: number, embeddings?: object}>} An object containing the stringified JSON metadata, buffer size, and optional embeddings.
 */
async function processDicom(buffer, uriPath) {
  const configObject = config.get();
  const configProvidedOptions = configObject.jsonOutput;
  const bulkDataRoot = configProvidedOptions.explicitBulkDataRoot ? uriPath : "";
  const outputOptions = deepAssign({}, configProvidedOptions, { bulkDataRoot });
  const reader = new DicomInMemory(buffer);
  const json = reader.toJson(outputOptions);
  const embeddingsResult = embedConfig.enabled ? await createVectorEmbedding(json, buffer) : null;
  return {
    metadata: JSON.stringify(json),
    size: buffer.length,
    embeddings: embeddingsResult,
  };
}

/**
 * Persist metadata row and optional embeddings row.
 * writeBase should contain timestamp, path, version.
 * infoObj will be JSON.stringified into the info field.
 * metadata is the JSON string (or null).
 * embeddingsData is an object with { embedding: array } (or null).
 * objectMetadata is an object with { path, size, mimeType } for the embedding's associated object (or null).
 */
async function persistRow(writeBase, infoObj, metadata, embeddingsData, objectMetadata) {
  // Compute deterministic id from path + version
  const idSource = `${writeBase.path}|${String(writeBase.version)}`;
  const id = crypto.createHash("sha256").update(idSource).digest("hex");

  const metaRow = Object.assign({}, writeBase, {
    id,
    info: JSON.stringify(infoObj),
    metadata: metadata || null,
  });

  await bq.insertMetadata(metaRow);

  if (embeddingsData && embeddingsData.embedding && Array.isArray(embeddingsData.embedding)) {
    const embRow = {
      id,
      embedding: embeddingsData.embedding,
      object: objectMetadata
        ? {
            path: objectMetadata.path || null,
            size: objectMetadata.size || null,
            mimeType: objectMetadata.mimeType || null,
          }
        : null,
    };
    await bq.insertEmbeddings(embRow);
  }
}

/**
 * Recursively find all .dcm files in a directory.
 * @param {string} dir The directory to search
 * @returns {Promise<string[]>} Array of absolute paths to .dcm files
 */
async function findDcmFiles(dir) {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await findDcmFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.name.toLowerCase().endsWith('.dcm')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

/**
 * Handle a zip file containing DICOM files.
 * @param {Buffer} zipBuffer The zip file content
 * @param {string} basePath The original path of the zip file
 * @param {Date} timestamp The timestamp of the event
 * @param {number} version The version identifier
 * @param {string} eventType The event type
 */
async function handleZipFile(zipBuffer, basePath, timestamp, version, eventType) {
  let tempDir = null;
  try {
    // Extract zip to temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm2bq-'));
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tempDir, true);
    
    // Find all .dcm files
    const dcmFiles = await findDcmFiles(tempDir);
    
    if (DEBUG_MODE) {
      console.log(`Found ${dcmFiles.length} DICOM files in zip: ${basePath}`);
    }
    
    // Process each DICOM file
    for (const dcmFile of dcmFiles) {
      const fileBuffer = await fs.readFile(dcmFile);
      const fileName = path.basename(dcmFile);
      const uriPath = `${basePath}#${fileName}`;
      
      await processAndPersistDicom(
        basePath,
        version,
        timestamp,
        fileBuffer,
        uriPath,
        eventType,
        fileBuffer.length,
        consts.STORAGE_TYPE_GCS
      );
    }
  } catch (error) {
    console.error(`Error processing zip file ${basePath}: ${error.message}`);
  } finally {
    // Clean up temporary directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        console.error(`Error cleaning up temp directory ${tempDir}: ${error.message}`);
      }
    }
  }
}

async function handleGcsPubSubUnwrap(ctx, perfCtx) {
  const { eventType, bucketId, objectId } = ctx.message.attributes;
  const msgData = JSON.parse(Buffer.from(ctx.message.data, "base64").toString());
  const basePath = `${msgData.bucket}/${msgData.name}`;
  const timestamp = new Date();
  const version = msgData.generation;
  
  switch (eventType) {
    // The object is no longer current
    case consts.GCS_OBJ_ARCHIVE:
    // The object has been removed
    case consts.GCS_OBJ_DELETE: {
      const infoObj = {
        event: eventType,
        storage: { type: consts.STORAGE_TYPE_GCS },
      };
      const writeObj = { timestamp, path: basePath, version };
      await persistRow(writeObj, infoObj, null, null, null);
      perfCtx.addRef("afterBqInsert");
      break;
    }
    // Metadata has been updated on the object (HACK: treat same as finalize)
    case consts.GCS_OBJ_METADATA_UPDATE:
    // The object has been replaced with a new version
    case consts.GCS_OBJ_FINALIZE: {
      // Use memory to read, avoiding volume mount in container
      const buffer = await gcs.downloadToMemory(bucketId, objectId);
      perfCtx.addRef("afterGcsDownloadToMemory");
      
      if (objectId.toLowerCase().endsWith('.zip')) {
        await handleZipFile(buffer, basePath, timestamp, version, eventType);
      } else {
        const uriPath = gcs.createUriPath(bucketId, objectId);
        await processAndPersistDicom(basePath, version, timestamp, buffer, uriPath, eventType, buffer.length, consts.STORAGE_TYPE_GCS);
      }
      perfCtx.addRef("afterProcessDicom");
      perfCtx.addRef("afterBqInsert");
      break;
    }
  }
  if (DEBUG_MODE) {
    console.log(JSON.stringify({ path: basePath }));
  }
}

async function handleHcapiPubSubUnwrap(ctx, perfCtx) {
  const dicomWebPath = Buffer.from(ctx.message.data, "base64").toString();
  const uriPath = hcapi.createUriPath(dicomWebPath);
  const buffer = await hcapi.downloadToMemory(uriPath);
  perfCtx.addRef("afterHcapiDownloadToMemory");

  const timestamp = new Date();
  const version = Date.now(); // TODO: Fix when HCAPI supports versions

  await processAndPersistDicom(dicomWebPath, version, timestamp, buffer, uriPath, consts.HCAPI_FINALIZE, buffer.length, consts.STORAGE_TYPE_DICOMWEB);
  perfCtx.addRef("afterProcessDicom");
  perfCtx.addRef("afterBqInsert");
  if (DEBUG_MODE) {
    console.log(JSON.stringify({ path: dicomWebPath }));
  }
}

async function handleEvent(name, req, res) {
  switch (name) {
    case consts.GCS_PUBSUB_UNWRAP: {
      await handleGcsPubSubUnwrap(req.body, res.perfCtx);
      break;
    }
    case consts.HCAPI_PUBSUB_UNWRAP: {
      await handleHcapiPubSubUnwrap(req.body, res.perfCtx);
      break;
    }
  }
}

module.exports = { handleEvent };
