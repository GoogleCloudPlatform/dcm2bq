const Ajv = require("ajv");
const ajv = new Ajv();
const consts = require("./consts");
const utils = require("./utils");

const schemaKeys = [];

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
              objectId: { type: "string", pattern: ".(dcm|DCM|dicom)$" },
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
