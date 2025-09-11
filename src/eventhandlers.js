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
const embedConfig = config.get().gcpConfig.embeddings;

// TODO: Include the metaHash for all files

/**
 * Processes a DICOM file buffer to extract metadata and optionally generate a vector embedding.
 * @param {Buffer} buffer The DICOM file content as a buffer.
 * @param {string} uriPath The URI of the DICOM file.
 * @returns {Promise<{metadata: string, vectorEmbedding?: string}>} An object containing the stringified JSON metadata and an optional stringified vector embedding.
 */
async function processDicom(buffer, uriPath) {
  const configObject = config.get();
  const configProvidedOptions = configObject.jsonOutput;
  const bulkDataRoot = configProvidedOptions.explicitBulkDataRoot ? uriPath : "";
  const outputOptions = deepAssign({}, configProvidedOptions, { bulkDataRoot });
  const reader = new DicomInMemory(buffer);
  const json = reader.toJson(outputOptions);
  return {
    metadata: JSON.stringify(json),
    embeddings: embedConfig.enabled ? await createVectorEmbedding(json, buffer) : null,
  };
}

/**
 * Persist metadata row and optional embeddings row.
 * writeBase should contain timestamp, path, version.
 * infoObj will be JSON.stringified into the info field.
 * metadata is the JSON string (or null).
 * embeddings is an array of floats (or null).
 */
async function persistRow(writeBase, infoObj, metadata, embeddings) {
  // Compute deterministic id from path + version
  const idSource = `${writeBase.path}|${String(writeBase.version)}`;
  const id = crypto.createHash("sha256").update(idSource).digest("hex");

  const metaRow = Object.assign({}, writeBase, {
    id,
    info: JSON.stringify(infoObj),
    metadata: metadata || null,
  });

  await bq.insertMetadata(metaRow);

  if (embeddings && Array.isArray(embeddings)) {
    const embRow = {
      id,
      embedding: embeddings,
    };
    await bq.insertEmbeddings(embRow);
  }
}

async function handleGcsPubSubUnwrap(ctx, perfCtx) {
  const { eventType, bucketId, objectId } = ctx.message.attributes;
  const msgData = JSON.parse(Buffer.from(ctx.message.data, "base64").toString());
  const writeObj = {
    timestamp: new Date(),
    path: `${msgData.bucket}/${msgData.name}`,
    version: msgData.generation,
  };
  switch (eventType) {
    // The object is no longer current
    case consts.GCS_OBJ_ARCHIVE:
    // The object has been removed
    case consts.GCS_OBJ_DELETE: {
      const infoObj = {
        event: eventType,
        storage: { type: consts.STORAGE_TYPE_GCS },
      };
      await persistRow(writeObj, infoObj, null, null);
      perfCtx.addRef("afterBqInsert");
      break;
    }
    // The object has been replaced with a new version
    case consts.GCS_OBJ_FINALIZE: {
      // Use memory to read, avoiding volume mount in container
      const buffer = await gcs.downloadToMemory(bucketId, objectId);
      perfCtx.addRef("afterGcsDownloadToMemory");
      const infoObj = {
        event: eventType,
        storage: { size: buffer.length, type: consts.STORAGE_TYPE_GCS },
        embeddings: { model: embedConfig.model },
      };
      const uriPath = gcs.createUriPath(bucketId, objectId);
      const { metadata, embeddings } = await processDicom(buffer, uriPath);
      perfCtx.addRef("afterProcessDicom");
      await persistRow(writeObj, infoObj, metadata, embeddings);
      perfCtx.addRef("afterBqInsert");
      break;
    }
    // Metadata has been updated on the object
    case consts.GCS_OBJ_METADATA_UPDATE: {
      // Do nothing
      break;
    }
  }
  if (DEBUG_MODE) {
    console.log(JSON.stringify(writeObj));
  }
}

async function handleHcapiPubSubUnwrap(ctx, perfCtx) {
  const dicomWebPath = Buffer.from(ctx.message.data, "base64").toString();
  const uriPath = hcapi.createUriPath(dicomWebPath);
  const buffer = await hcapi.downloadToMemory(uriPath);
  perfCtx.addRef("afterHcapiDownloadToMemory");

  const { metadata, embeddings } = await processDicom(buffer, uriPath);
  perfCtx.addRef("afterProcessDicom");

  const infoObj = {
    event: consts.HCAPI_FINALIZE,
    storage: { size: buffer.length, type: consts.STORAGE_TYPE_DICOMWEB },
    embeddings: { model: embedConfig.model },
  };

  const writeObj = {
    timestamp: new Date(),
    path: dicomWebPath,
    version: Date.now(), // TODO: Fix when HCAPI supports versions
  };

  await persistRow(writeObj, infoObj, metadata, embeddings);
  perfCtx.addRef("afterBqInsert");
  if (DEBUG_MODE) {
    console.log(JSON.stringify(writeObj));
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
