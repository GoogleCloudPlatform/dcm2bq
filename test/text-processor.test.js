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
const sinon = require("sinon");

describe("text processor with partial config", () => {
  let originalConfigEnv;
  let originalDebugEnv;
  let consoleLogStub;
  let consoleErrorStub;
  let geminiStub;

  beforeEach(() => {
    originalConfigEnv = process.env.DCM2BQ_CONFIG;
    originalDebugEnv = process.env.DEBUG;
    // Clear require cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/processors/text")];
    delete require.cache[require.resolve("../src/gemini")];
    delete require.cache[require.resolve("../src/utils")];
    
    // Stub console methods
    consoleLogStub = sinon.stub(console, "log");
    consoleErrorStub = sinon.stub(console, "error");
    
    // Stub Gemini API
    geminiStub = sinon.stub();
    require.cache[require.resolve("../src/gemini")] = {
      exports: geminiStub
    };
  });

  afterEach(() => {
    if (originalConfigEnv) {
      process.env.DCM2BQ_CONFIG = originalConfigEnv;
    } else {
      delete process.env.DCM2BQ_CONFIG;
    }
    if (originalDebugEnv) {
      process.env.DEBUG = originalDebugEnv;
    } else {
      delete process.env.DEBUG;
    }
    // Clear require cache
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/processors/text")];
    delete require.cache[require.resolve("../src/gemini")];
    delete require.cache[require.resolve("../src/utils")];
    
    // Restore stubs
    consoleLogStub.restore();
    consoleErrorStub.restore();
  });

  it("should use default maxLength (1024) when no config provided", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    // Short text should not trigger summarization
    const shortText = "X".repeat(100);
    const result1 = await createTextInstance(shortText, true);
    assert.ok(result1);
    assert.strictEqual(result1.text, shortText);
    
    // Text > 1024 with requireEmbeddingCompatible should fail without summarization config
    const longText = "X".repeat(1500);
    const result2 = await createTextInstance(longText, true);
    assert.strictEqual(result2, null);
    assert.ok(consoleErrorStub.calledWith(sinon.match(/Text is too long for embedding/)));
    assert.ok(consoleErrorStub.calledWith(sinon.match(/1024 characters/)));
  });

  it("should work with only embedding section present", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {},
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    const shortText = "X".repeat(100);
    const result = await createTextInstance(shortText, true);
    assert.ok(result);
    assert.strictEqual(result.text, shortText);
    
    const longText = "X".repeat(1500);
    const result2 = await createTextInstance(longText, true);
    assert.strictEqual(result2, null);
  });

  it("should work with only embedding.input section present", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {
          input: {},
        },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    const shortText = "X".repeat(100);
    const result = await createTextInstance(shortText, true);
    assert.ok(result);
    assert.strictEqual(result.text, shortText);
  });

  it("should work with only embedding.input.vector section present", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {
          input: {
            vector: { model: "multimodalembedding@001" },
          },
        },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    const shortText = "X".repeat(100);
    const result = await createTextInstance(shortText, true);
    assert.ok(result);
    assert.strictEqual(result.text, shortText);
    
    // Long text without summarizeText config should fail
    const longText = "X".repeat(1500);
    const result2 = await createTextInstance(longText, true);
    assert.strictEqual(result2, null);
    assert.ok(consoleErrorStub.calledWith(sinon.match(/summarization is disabled/)));
  });

  it("should handle different maxLength values in config", async () => {
    // Test with custom maxLength of 500
    process.env.DEBUG = "true";
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {
          input: {
            summarizeText: {
              model: "gemini-2.5-flash-lite",
              maxLength: 500,
            },
          },
        },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    // Text <= 500 should not trigger summarization attempt
    const shortText = "X".repeat(400);
    const result1 = await createTextInstance(shortText, true);
    assert.ok(result1);
    assert.strictEqual(result1.text, shortText);
    
    // Text > 500 should attempt summarization - stub Gemini to return a summary
    geminiStub.resolves("Summarized text");
    consoleLogStub.resetHistory();
    const longText = "X".repeat(600);
    const result2 = await createTextInstance(longText, true);
    assert.ok(result2);
    assert.strictEqual(result2.text, "Summarized text");
    assert.ok(consoleLogStub.calledWith(sinon.match(/exceeds maxLength \(500\)/)));
    assert.ok(geminiStub.called);
  });

  it("should use default maxLength when summarizeText has model but no maxLength", async () => {
    process.env.DEBUG = "true";
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {
          input: {
            summarizeText: {
              model: "gemini-2.5-flash-lite",
            },
          },
        },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    // Text <= 1024 should not trigger summarization
    const shortText = "X".repeat(1000);
    const result = await createTextInstance(shortText, true);
    assert.ok(result);
    assert.strictEqual(result.text, shortText);
    
    // Text > 1024 should attempt summarization with default maxLength - stub to return success
    geminiStub.resolves("Summarized text for default maxLength");
    consoleLogStub.resetHistory();
    const longText = "X".repeat(1500);
    const result2 = await createTextInstance(longText, true);
    assert.ok(result2);
    assert.strictEqual(result2.text, "Summarized text for default maxLength");
    assert.ok(consoleLogStub.calledWith(sinon.match(/exceeds maxLength \(1024\)/)));
    assert.ok(geminiStub.called);
  });

  it("should return text as-is when requireEmbeddingCompatible is false", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    // Even very long text should be returned as-is when requireEmbeddingCompatible is false
    const longText = "X".repeat(5000);
    const result = await createTextInstance(longText, false);
    assert.ok(result);
    assert.strictEqual(result.text, longText);
  });

  it("should return null when text is empty or null", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    const result1 = await createTextInstance(null);
    assert.strictEqual(result1, null);
    assert.ok(consoleLogStub.calledWith("No text could be extracted from DICOM object."));
    
    consoleLogStub.resetHistory();
    
    const result2 = await createTextInstance("");
    assert.strictEqual(result2, null);
  });

  it("should work with gcsBucketPath but without summarizeText", async () => {
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: {
          input: {
            gcsBucketPath: "gs://test-bucket/extract",
            vector: { model: "multimodalembedding@001" },
          },
        },
      },
      src: "TEST",
    });

    const { createTextInstance } = require("../src/processors/text");
    
    const shortText = "X".repeat(100);
    const result = await createTextInstance(shortText, true);
    assert.ok(result);
    assert.strictEqual(result.text, shortText);
    
    // Long text should fail without summarizeText config
    const longText = "X".repeat(1500);
    const result2 = await createTextInstance(longText, true);
    assert.strictEqual(result2, null);
  });
});
