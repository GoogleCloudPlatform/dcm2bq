const assert = require("assert");
const glob = require("glob").globSync;
const fs = require("fs");
const config = require("../config");
const consts = require("../consts");
const utils = require("../utils");

const testFiles = glob("./test/files/dcm/*.dcm");
const notDicomFile = glob("./test/files/dcm/notdicom.txt")[0];
const gcsPubSubUnwrapExample = require("./files/json/gcs_pubsub_unwrap.json");
const gcsPubSubUnwrapMetaExample = require("./files/json/gcs_pubsub_unwrap_meta.json");
const hcapiPubSubUnwrapExample = require("./files/json/hcapi_pubsub.json");

describe("dcmtojson", () => {
  const url = require("url");
  const { DicomFile, DicomInMemory } = require("../dicomtojson");
  describe("DicomInMemory#toJson()", () => {
    testFiles.forEach((file) => {
      it(`Testing ${file} (default)`, () => {
        const conf = config.get();
        const fileUrl = new URL(url.pathToFileURL(file));
        const buffer = fs.readFileSync(fileUrl);
        const reader = new DicomInMemory(buffer, conf.jsonOutputOptions);
        const json = reader.toJson();
        assert.ok(json);
      });
      it(`Testing notdicom.txt (default)`, () => {
        const conf = config.get();
        const fileUrl = new URL(url.pathToFileURL(notDicomFile));
        const buffer = fs.readFileSync(fileUrl);
        const reader = new DicomInMemory(buffer, conf.jsonOutputOptions);
        try {
          reader.toJson();
          assert.fail();
        } catch {}
      });
    });
  });
  describe("DicomFile#toJson()", () => {
    testFiles.forEach((file) => {
      it(`Testing ${file} (default)`, () => {
        const conf = config.get();
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl, conf.jsonOutputOptions);
        const json = reader.toJson();
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (minimum)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            useArrayWithSingleValue: false,
            ignoreMetaHeader: true,
            ignorePrivate: true,
            ignoreBinary: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (useArrayWithSingleValue)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            useArrayWithSingleValue: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (ignoreMetaHeader)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            ignoreMetaHeader: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (ignorePrivate)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            ignorePrivate: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (ignoreBinary)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            ignoreBinary: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (useCommonNames)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            useCommonNames: true,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
    testFiles.forEach((file) => {
      it(`Testing ${file} (bulkDataRoot)`, () => {
        const fileUrl = new URL(url.pathToFileURL(file));
        const reader = new DicomFile(fileUrl);
        const overrides = {
          jsonOutputOptions: {
            bulkDataRoot: fileUrl,
          },
        };
        const conf = config.get(overrides);
        const json = reader.toJson(conf.jsonOutputOptions);
        assert.ok(json);
      });
    });
  });
});

describe("schemas", () => {
  const schemas = require("../schemas");
  it("getSchema", () => {
    const eventHandlerSchemas = consts.EVENT_HANDLER_NAMES;
    assert.ok(eventHandlerSchemas.length == 2);
    const result = schemas.getSchema(eventHandlerSchemas[0]);
    assert.ok(result);
  });
  it("matchEventSchema", () => {
    const data = gcsPubSubUnwrapExample;
    const result = schemas.matchEventSchema(data);
    assert.ok(result);
  });
  it("matchEventSchema", () => {
    const data = hcapiPubSubUnwrapExample;
    const result = schemas.matchEventSchema(data);
    assert.ok(result);
  });
  it("matchEventSchema (fail)", () => {
    const data = utils.deepClone(gcsPubSubUnwrapExample);
    data.message.attributes.objectId = "test.jpg";
    try {
      schemas.matchEventSchema(data);
      assert.fail();
    } catch (e) {}
  });
});

describe("config", () => {
  it("DEFAULTS", () => {
    const oldVal = process.env.DCM2BQ_CONFIG;
    process.env.DCM2BQ_CONFIG = "";
    const conf = config.get();
    assert.ok(conf);
    assert.ok(conf.src == "DEFAULTS");
    process.env.DCM2BQ_CONFIG_FILE = oldVal;
  });
  it("ENV_VAR", () => {
    const oldVal = process.env.DCM2BQ_CONFIG;
    process.env.DCM2BQ_CONFIG = JSON.stringify({ jsonOutputOptions: { ignoreBinary: true } });
    const conf = config.get();
    assert.ok(conf);
    assert.ok(conf.src == "ENV_VAR");
    assert.ok(conf.jsonOutputOptions.ignoreBinary);
    process.env.DCM2BQ_CONFIG = oldVal;
  });
  it("ENV_VAR_FILE", () => {
    const oldVal = process.env.DCM2BQ_CONFIG_FILE;
    const CONFIG_FILE_NAME = "./config.json";
    const content = JSON.stringify({ jsonOutputOptions: { ignoreBinary: true } });
    fs.writeFileSync(CONFIG_FILE_NAME, content);
    process.env.DCM2BQ_CONFIG_FILE = CONFIG_FILE_NAME;
    const conf = config.get();
    assert.ok(conf);
    assert.ok(conf.src == "ENV_VAR_FILE");
    assert.ok(conf.jsonOutputOptions.ignoreBinary);
    process.env.DCM2BQ_CONFIG_FILE = oldVal;
    fs.rmSync(CONFIG_FILE_NAME);
  });
});

describe("httpserver", () => {
  const axios = require("axios");
  const { HttpServer } = require("../server");
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
