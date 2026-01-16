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
const { insert } = require("./bigquery");
const gcs = require("./gcs");
const hcapi = require("./hcapi");
const { createVectorEmbedding, createEmbeddingInput } = require("./embeddings");
const { deepAssign, DEBUG_MODE } = require("./utils");
const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const AdmZip = require("adm-zip");
const { gcpConfig } = config.get();
const embeddingInputConfig = gcpConfig.embedding?.input;

// TODO: Include the metaHash for all files

/**
 * Process and persist a single DICOM file.
 * @param {number} version The version identifier
 * @param {Date} timestamp The timestamp of the event
 * @param {Buffer} dicomBuffer The DICOM file content
 * @param {string} uriPath The URI path for this file (uniquely identifies the file)
 * @param {string} eventType The event type
 * @param {number} fileSize The size of the file
 * @param {string} storageType The type of storage (GCS, DICOMWEB, etc)
 * @returns {Promise<void>}
 */
async function processAndPersistDicom(version, timestamp, dicomBuffer, uriPath, eventType, fileSize, storageType) {
  if (DEBUG_MODE) {
    console.log(`Processing DICOM: ${uriPath} (size: ${fileSize} bytes)`);
  }
  
  const { metadata, embeddings } = await processDicom(dicomBuffer, uriPath);
  
  const objectMetadata = embeddings && (embeddings.objectPath || embeddings.objectSize || embeddings.objectMimeType)
    ? { path: embeddings.objectPath, size: embeddings.objectSize, mimeType: embeddings.objectMimeType }
    : null;
  
  const embeddingVectorModel = embeddingInputConfig?.vector?.model;
  
  const infoObj = {
    event: eventType,
    input: { size: fileSize, type: storageType },
    embedding: {
      model: embeddingVectorModel || null,
      input: objectMetadata,
    },
  };
  
  const writeObj = {
    timestamp,
    path: uriPath,
    version,
  };
  
  if (DEBUG_MODE) {
    console.log(`Persisting DICOM: ${uriPath}, embedding: ${embeddings ? 'yes' : 'no'}`);
  }
  
  await persistRow(writeObj, infoObj, metadata, embeddings);
}

/**
 * Processes a DICOM file buffer to extract metadata and optionally generate embedding input and vector embedding.
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
  
  let embeddingsResult = null;
  
  // Check if we should create embedding input (extract and save text/images)
  const shouldCreateInput = embeddingInputConfig?.gcsBucketPath;
  // Check if we should generate actual embeddings (call Vertex AI)
  const shouldGenerateEmbedding = embeddingInputConfig?.vector?.model;
  
  if (shouldGenerateEmbedding) {
    // Generate full embedding (includes input creation + vector generation)
    embeddingsResult = await createVectorEmbedding(json, buffer);
  } else if (shouldCreateInput) {
    // Only create embedding input (extract and save, but don't generate vector)
    embeddingsResult = await createEmbeddingInput(json, buffer);
  }
  
  return {
    metadata: JSON.stringify(json),
    size: buffer.length,
    embeddings: embeddingsResult,
  };
}

/**
 * Persist metadata and embeddings in a single row.
 * writeBase should contain timestamp, path, version.
 * infoObj is a structured object with event, input, and embedding info.
 * metadata is the JSON string (or null).
 * embeddingsData is an object with { embedding: array } (or null).
 */
async function persistRow(writeBase, infoObj, metadata, embeddingsData) {
  // Compute deterministic id from path + version
  const idSource = `${writeBase.path}|${String(writeBase.version)}`;
  const id = crypto.createHash("sha256").update(idSource).digest("hex");

  // Ensure info object is never null (required by BigQuery schema)
  const info = infoObj || { event: null, input: null, embedding: null };

  const row = Object.assign({}, writeBase, {
    id,
    info,
    metadata: metadata || null,
    // Ensure schema type compatibility
    version: String(writeBase.version),
  });

  // Only add embeddingVector if it has data (REPEATED fields cannot be null)
  if (embeddingsData && embeddingsData.embedding && Array.isArray(embeddingsData.embedding) && embeddingsData.embedding.length > 0) {
    row.embeddingVector = embeddingsData.embedding;
  }

  await insert(row);
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
 * @param {string} bucketId The GCS bucket ID
 * @param {string} objectId The GCS object ID (zip file name)
 * @param {Date} timestamp The timestamp of the event
 * @param {number} version The version identifier
 * @param {string} eventType The event type
 */
async function handleZipFile(zipBuffer, bucketId, objectId, timestamp, version, eventType) {
  let tempDir = null;
  const zipUriPath = gcs.createUriPath(bucketId, objectId);
  try {
    // Extract zip to temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dcm2bq-'));
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(tempDir, true);
    
    // Find all .dcm files
    const dcmFiles = await findDcmFiles(tempDir);
    
    if (DEBUG_MODE) {
      console.log(`Found ${dcmFiles.length} DICOM files in zip: ${zipUriPath}`);
    }
    
    // Process each DICOM file; continue on per-file failure
    let successCount = 0;
    let errorCount = 0;
    
    for (const dcmFile of dcmFiles) {
      try {
        const fileBuffer = await fs.readFile(dcmFile);
        const fileName = path.basename(dcmFile);
        const uriPath = `${zipUriPath}#${fileName}`;
        
        await processAndPersistDicom(
          version,
          timestamp,
          fileBuffer,
          uriPath,
          eventType,
          fileBuffer.length,
          consts.STORAGE_TYPE_GCS
        );
        successCount++;
      } catch (error) {
        errorCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';
        console.error(`Error processing DICOM ${path.basename(dcmFile)}: ${errorMsg}${errorStack ? '\n' + errorStack : ''}`);
      }
    }
    
    if (DEBUG_MODE) {
      console.log(`Zip processing complete for ${zipUriPath}: ${successCount} succeeded, ${errorCount} failed out of ${dcmFiles.length} total`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    console.error(`Error processing zip file ${zipUriPath}: ${errorMsg}${errorStack ? '\n' + errorStack : ''}`);
  } finally {
    // Clean up temporary directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`Error cleaning up temp directory ${tempDir}: ${errorMsg}`);
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
        input: { type: consts.STORAGE_TYPE_GCS },
      };
      const writeObj = { timestamp, path: basePath, version };
      await persistRow(writeObj, infoObj, null, null);
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
        await handleZipFile(buffer, bucketId, objectId, timestamp, version, eventType);
      } else {
        const uriPath = gcs.createUriPath(bucketId, objectId);
        await processAndPersistDicom(version, timestamp, buffer, uriPath, eventType, buffer.length, consts.STORAGE_TYPE_GCS);
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

  await processAndPersistDicom(version, timestamp, buffer, uriPath, consts.HCAPI_FINALIZE, buffer.length, consts.STORAGE_TYPE_DICOMWEB);
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

module.exports = { handleEvent, handleGcsPubSubUnwrap };
