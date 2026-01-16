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

const Ajv = require("ajv");
const ajv = new Ajv();
const consts = require("./consts");
const utils = require("./utils");

const schemaKeys = [];

// Configuration schema based on config.defaults.js structure
addSchema(
  {
    type: "object",
    required: ["gcpConfig"],
    properties: {
      gcpConfig: {
        type: "object",
        required: ["projectId", "location", "bigQuery"],
        properties: {
          projectId: { type: "string" },
          location: { type: "string" },
          bigQuery: {
            type: "object",
            required: ["datasetId", "instancesTableId"],
            properties: {
              datasetId: { type: "string" },
              instancesTableId: { type: "string" }
            }
          },
          embedding: {
            type: "object",
            properties: {
              input: {
                type: "object",
                properties: {
                  gcsBucketPath: { type: "string" },
                  summarizeText: {
                    type: "object",
                    properties: {
                      model: { type: "string" }
                    }
                  },
                  vector: {
                    type: "object",
                    properties: {
                      model: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      dicomParser: { type: "object" },
      jsonOutput: {
        type: "object",
        properties: {
          useArrayWithSingleValue: { type: "boolean" },
          ignoreGroupLength: { type: "boolean" },
          ignoreMetaHeader: { type: "boolean" },
          ignorePrivate: { type: "boolean" },
          ignoreBinary: { type: "boolean" },
          useCommonNames: { type: "boolean" },
          explicitBulkDataRoot: { type: "boolean" }
        }
      },
      src: { type: "string" }
    }
  },
  consts.CONFIG_SCHEMA
);

// Conforms to https://cloud.google.com/storage/docs/pubsub-notifications
addSchema(
  {
    type: "object",
    required: ["message"],
    properties: {
      message: {
        type: "object",
        required: ["attributes", "data"],
        properties: {
          attributes: {
            type: "object",
            required: ["payloadFormat", "eventType", "bucketId", "objectId"],
            properties: {
              payloadFormat: { const: consts.GCS_PUBSUB_MSG_V1 },
              eventType: { enum: consts.GCS_EVENT_TYPES },
              objectId: { type: "string", pattern: ".(dcm|DCM|dicom|zip)$" },
            },
          },
          data: {
            type: "string",
          },
        },
      },
    },
  },
  consts.GCS_PUBSUB_UNWRAP
);

// Conforms to https://cloud.google.com/healthcare-api/docs/concepts/pubsub
addSchema(
  {
    type: "object",
    required: ["message"],
    properties: {
      message: {
        type: "object",
        required: ["data"],
        properties: {
          data: {
            type: "string",
          },
        },
      },
    },
  },
  consts.HCAPI_PUBSUB_UNWRAP
);

function addSchema(schema, key) {
  ajv.addSchema(schema, key);
  schemaKeys.push(key);
}

function getSchema(key) {
  return ajv.getSchema(key);
}

function matchEventSchema(obj) {
  const schema = consts.EVENT_HANDLER_NAMES.find((s) => {
    const validate = ajv.getSchema(s);
    return validate(obj);
  });
  if (!schema) {
    throw utils.createHttpError(400, `No match to supported schemas: ${consts.EVENT_HANDLER_NAMES}`);
  }
  return schema;
}

// TODO: Support other schemas (functions framework)

module.exports = { getSchema, matchEventSchema };
