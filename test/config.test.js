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

describe("config", () => {
  let originalConfigEnv;
  let originalConfigFileEnv;

  beforeEach(() => {
    originalConfigEnv = process.env.DCM2BQ_CONFIG;
    originalConfigFileEnv = process.env.DCM2BQ_CONFIG_FILE;
    // Clear require cache to ensure config is reloaded
    delete require.cache[require.resolve("../config")];
  });

  afterEach(() => {
    if (originalConfigEnv) {
      process.env.DCM2BQ_CONFIG = originalConfigEnv;
    } else {
      delete process.env.DCM2BQ_CONFIG;
    }
    if (originalConfigFileEnv) {
      process.env.DCM2BQ_CONFIG_FILE = originalConfigFileEnv;
    } else {
      delete process.env.DCM2BQ_CONFIG_FILE;
    }
  });

  it("DEFAULTS", () => {
    process.env.DCM2BQ_CONFIG = "";
    process.env.DCM2BQ_CONFIG_FILE = "";
    const conf = require("../config").get();
    assert.ok(conf);
    assert.strictEqual(conf.src, "DEFAULTS");
  });

  it("ENV_VAR", () => {
    const configContent = {
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", tableId: "metadata" },
        embeddings: { enabled: true, model: "multimodalembedding@001" },
      },
      jsonOutput: { ignoreBinary: true },
      src: "ENV_VAR",
    };
    process.env.DCM2BQ_CONFIG = JSON.stringify(configContent);
    const conf = require("../config").get();
    assert.ok(conf);
    assert.strictEqual(conf.src, "ENV_VAR");
    assert.strictEqual(conf.jsonOutput.ignoreBinary, true);
  });

  it("ENV_VAR_FILE", () => {
    const CONFIG_FILE_NAME = "./config.test.json";
    const configContent = {
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", tableId: "metadata" },
        embeddings: { enabled: true, model: "multimodalembedding@001" },
      },
      jsonOutput: { ignoreBinary: true },
      src: "ENV_VAR_FILE",
    };
    fs.writeFileSync(CONFIG_FILE_NAME, JSON.stringify(configContent));
    process.env.DCM2BQ_CONFIG_FILE = CONFIG_FILE_NAME;
    const conf = require("../config").get();
    assert.ok(conf);
    assert.strictEqual(conf.src, "ENV_VAR_FILE");
    assert.strictEqual(conf.jsonOutput.ignoreBinary, true);
    fs.rmSync(CONFIG_FILE_NAME);
  });
});
