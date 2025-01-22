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
const { deepAssign, DEBUG_MODE } = require("./utils");

// TODO: Include the metaHash for all files

async function getMetadata(buffer, uriPath) {
  const configProvidedOptions = config.get().jsonOutputOptions;
  const bulkDataRoot = configProvidedOptions.explicitBulkDataRoot ? uriPath : "";
  const outputOptions = deepAssign({}, configProvidedOptions, { bulkDataRoot });
  const reader = new DicomInMemory(buffer);
  const metadata = reader.toJson(outputOptions);
  return JSON.stringify(metadata);
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
      writeObj.info = JSON.stringify({
        event: eventType,
        storage: { type: consts.STORAGE_TYPE_GCS },
      });
      await bq.insert(writeObj);
      perfCtx.addRef("afterBqInsert");
      break;
    }
    // The object has been replaced with a new version
    case consts.GCS_OBJ_FINALIZE: {
      // Use memory to read, avoiding volume mount in container
      const buffer = await gcs.downloadToMemory(bucketId, objectId);
      perfCtx.addRef("afterGcsDownloadToMemory");
      writeObj.info = JSON.stringify({
        event: eventType,
        storage: { size: buffer.length, type: consts.STORAGE_TYPE_GCS },
      });
      const uriPath = gcs.createUriPath(bucketId, objectId);
      writeObj.metadata = await getMetadata(buffer, uriPath);
      perfCtx.addRef("afterGetMetadata");
      await bq.insert(writeObj);
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
  const writeObj = {
    timestamp: new Date(),
    path: dicomWebPath,
    version: null, // TODO: Fix when HCAPI supports versions
    info: JSON.stringify({
      event: consts.GENERIC_INSERT,
      storage: { size: buffer.length, type: consts.STORAGE_TYPE_DICOMWEB },
    }),
    metadata: await getMetadata(buffer, uriPath),
  };
  perfCtx.addRef("afterGetMetadata");
  await bq.insert(writeObj);
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
