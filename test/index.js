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
const fs = require("fs");
const axios = require("axios");
const config = require("../config");
const consts = require("../consts");
const utils = require("../utils");
const { HttpServer } = require("../server");
const { getSchema, matchEventSchema } = require("../schemas");

const gcsPubSubUnwrapExample = require("./files/json/gcs_pubsub_unwrap.json");
const gcsPubSubUnwrapMetaExample = require("./files/json/gcs_pubsub_unwrap_meta.json");
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

describe("httpserver", () => {
  const server = new HttpServer(8080);
  
  before(async () => {
    server.start();
  });

  it("version", async () => {
    const res = await axios.get("http://localhost:8080");
    assert(res.status == 200);
  });

  it("pubsub (fail)", async () => {
    try {
      await axios.post("http://localhost:8080", {});
      assert.fail();
    } catch (e) {
      assert(e.status == 400);
    }
  });

  it("GCS pubsub object finalize", async () => {
    const data = gcsPubSubUnwrapExample;
    const res = await axios.post("http://localhost:8080", data);
    assert(res.status == 200);
  });

  it("GCS pubsub object delete", async () => {
    const data = utils.deepClone(gcsPubSubUnwrapExample);
    data.message.attributes.eventType = consts.GCS_OBJ_DELETE;
    const res = await axios.post("http://localhost:8080", data);
    assert(res.status == 200);
  });

  it("GCS pubsub object metadata", async () => {
    const data = gcsPubSubUnwrapMetaExample;
    const res = await axios.post("http://localhost:8080", data);
    assert(res.status == 200);
  });

  it("HCAPI pubsub", async () => {
    const data = hcapiPubSubUnwrapExample;
    const res = await axios.post("http://localhost:8080", data);
    assert(res.status == 200);
  });

  after(() => {
    server.stop();
  });
});
