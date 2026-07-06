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

const assert = require("assert");
const consts = require("../src/consts");
const utils = require("../src/utils");
const { getSchema, matchEventSchema } = require("../src/schemas");

const gcsPubSubUnwrapExample = require("./files/json/gcs_pubsub_unwrap.json");
const hcapiPubSubUnwrapExample = require("./files/json/hcapi_pubsub.json");

describe("schemas", () => {
  it("getSchema", () => {
    const eventHandlerSchemas = consts.EVENT_HANDLER_NAMES;
    assert.ok(eventHandlerSchemas.length == 3);
    for (const name of eventHandlerSchemas) {
      assert.ok(getSchema(name));
    }
  });

  it("matchEventSchema (GCS Pub/Sub unwrap)", () => {
    const data = gcsPubSubUnwrapExample;
    const result = matchEventSchema(data);
    assert.ok(result);
  });

  it("matchEventSchema (HCAPI Pub/Sub unwrap)", () => {
    const data = hcapiPubSubUnwrapExample;
    const result = matchEventSchema(data);
    assert.ok(result);
  });

  it("matchEventSchema (local Pub/Sub unwrap)", () => {
    const data = {
      message: {
        messageId: "local-123",
        attributes: { eventType: consts.LOCAL_FINALIZE },
        data: Buffer.from(JSON.stringify({ name: "/data/dicom/file.dcm", size: 1234, generation: "1700000000000000" })).toString("base64"),
      },
      subscription: "local",
    };
    const result = matchEventSchema(data);
    assert.equal(result, consts.LOCAL_PUBSUB_UNWRAP);
  });

  it("matchEventSchema (HCAPI not shadowed by local schema)", () => {
    // HCAPI messages have no eventType attribute and must still route to HCAPI.
    const result = matchEventSchema(hcapiPubSubUnwrapExample);
    assert.equal(result, consts.HCAPI_PUBSUB_UNWRAP);
  });

  it("matchEventSchema (fail)", () => {
    const data = utils.deepClone(gcsPubSubUnwrapExample);
    data.message.attributes.payloadFormat = "INVALID_FORMAT";
    try {
      matchEventSchema(data);
      assert.fail("Should have thrown an error for invalid payload format");
    } catch (e) {
      assert.ok(String(e.message || e).includes("GCS_PUBSUB_UNWRAP"), "Should fail GCS schema, not route to HCAPI schema");
      assert.ok(e, "Should throw an error for schema validation failure");
    }
  });
});
