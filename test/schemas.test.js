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
const consts = require("../consts");
const utils = require("../utils");
const { getSchema, matchEventSchema } = require("../schemas");

const gcsPubSubUnwrapExample = require("./files/json/gcs_pubsub_unwrap.json");
const hcapiPubSubUnwrapExample = require("./files/json/hcapi_pubsub.json");

describe("schemas", () => {
  it("getSchema", () => {
    const eventHandlerSchemas = consts.EVENT_HANDLER_NAMES;
    assert.ok(eventHandlerSchemas.length == 2);
    const result = getSchema(eventHandlerSchemas[0]);
    assert.ok(result);
  });

  it("matchEventSchema", () => {
    const data = gcsPubSubUnwrapExample;
    const result = matchEventSchema(data);
    assert.ok(result);
  });

  it("matchEventSchema", () => {
    const data = hcapiPubSubUnwrapExample;
    const result = matchEventSchema(data);
    assert.ok(result);
  });

  it("matchEventSchema (fail)", () => {
    const data = utils.deepClone(gcsPubSubUnwrapExample);
    data.message.attributes.objectId = "test.jpg";
    try {
      matchEventSchema(data);
      assert.fail();
    } catch (e) {}
  });
});
