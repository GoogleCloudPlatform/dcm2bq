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
const fs = require("fs");

/**
 * Validate the row object against expected BigQuery schema constraints.
 * This is a light-weight validator matching tf/init.schema.json structure.
 */
function validateRow(row) {
  // Top-level fields
  assert.strictEqual(typeof row.id, "string", "id must be a string");
  assert.ok(row.id.length >= 32, "id must be a SHA-derived string");
  assert.ok(row.timestamp instanceof Date || typeof row.timestamp === "string", "timestamp must be Date or string");
  assert.strictEqual(typeof row.path, "string", "path must be a string");
  assert.strictEqual(typeof row.version, "string", "version must be a string");

  // info record
  assert.strictEqual(typeof row.info, "object", "info must be an object");
  assert.strictEqual(typeof row.info.event, "string", "info.event must be a string");
  assert.strictEqual(typeof row.info.input, "object", "info.input must be an object");
  if (row.info.embedding != null) {
    assert.strictEqual(typeof row.info.embedding, "object", "info.embedding must be an object");
    if (row.info.embedding.model != null) {
      assert.strictEqual(typeof row.info.embedding.model, "string", "info.embedding.model must be a string when present");
    }
    if (row.info.embedding.input != null) {
      assert.strictEqual(typeof row.info.embedding.input, "object", "info.embedding.input must be an object when present");
      if (row.info.embedding.input.path != null) assert.strictEqual(typeof row.info.embedding.input.path, "string", "embedding.input.path must be a string");
      if (row.info.embedding.input.size != null) assert.strictEqual(typeof row.info.embedding.input.size, "number", "embedding.input.size must be a number");
      if (row.info.embedding.input.mimeType != null) assert.strictEqual(typeof row.info.embedding.input.mimeType, "string", "embedding.input.mimeType must be a string");
    }
  }

  // metadata JSON string or null
  assert.ok(row.metadata === null || typeof row.metadata === "string", "metadata must be a JSON string or null");
  if (typeof row.metadata === "string") {
    // ensure valid JSON
    JSON.parse(row.metadata);
  }

  // embeddingVector array of numbers or null
  if (row.embeddingVector != null) {
    assert.ok(Array.isArray(row.embeddingVector), "embeddingVector must be an array when present");
    assert.ok(row.embeddingVector.every((v) => typeof v === "number"), "embeddingVector values must be numbers");
  }
}

describe("BigQuery insert payload matches schema", () => {
  let originalEnv;
  let insertStub;
  let originalBigQueryModule;

  beforeEach(() => {
    originalEnv = process.env.DCM2BQ_CONFIG;
    // Provide minimal config
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: { input: {} },
      },
      jsonOutput: { explicitBulkDataRoot: false },
      src: "TEST",
    });

    // Save original bigquery module
    const bigqueryPath = require.resolve("../src/bigquery");
    originalBigQueryModule = require.cache[bigqueryPath];
    
    // Stub modules before requiring eventhandlers
    delete require.cache[bigqueryPath];
    insertStub = sinon.stub().callsFake((row) => {
      validateRow(row);
      return Promise.resolve();
    });
    require.cache[bigqueryPath] = {
      exports: { insert: insertStub },
    };

    const dicomToJsonPath = require.resolve("../src/dicomtojson");
    delete require.cache[dicomToJsonPath];
    class FakeDicomInMemory {
      constructor(buffer) { this.buffer = buffer; }
      toJson() { return { SOPInstanceUID: "1.2.3", PatientID: "P1" }; }
    }
    require.cache[dicomToJsonPath] = {
      exports: { DicomInMemory: FakeDicomInMemory },
    };

    const embeddingsPath = require.resolve("../src/embeddings");
    delete require.cache[embeddingsPath];
    require.cache[embeddingsPath] = {
      exports: {
        createVectorEmbedding: async () => null,
        createEmbeddingInput: async () => null,
      },
    };
  });

  afterEach(() => {
    if (originalEnv) process.env.DCM2BQ_CONFIG = originalEnv; else delete process.env.DCM2BQ_CONFIG;
    
    // Restore original bigquery module
    const bigqueryPath = require.resolve("../src/bigquery");
    if (originalBigQueryModule) {
      require.cache[bigqueryPath] = originalBigQueryModule;
    } else {
      delete require.cache[bigqueryPath];
    }
    
    // Restore all GCS stubs to prevent double-wrap errors
    const gcsModule = require("../src/gcs");
    if (gcsModule.downloadToMemory && gcsModule.downloadToMemory.restore) gcsModule.downloadToMemory.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    // Clear caches (but NOT gcs to preserve Storage stub from eventhandlers.test.js)
    ["../src/dicomtojson", "../src/embeddings", "../src/eventhandlers"].forEach((m) => {
      try { delete require.cache[require.resolve(m)]; } catch {}
    });
  });

  it("inserts payload conforming to schema via GCS finalize path", async () => {
    const eventhandlers = require("../src/eventhandlers");
    // Build fake request context
    const ctx = {
      message: {
        attributes: {
          eventType: "OBJECT_FINALIZE",
          bucketId: "bkt",
          objectId: "obj.dcm",
        },
        data: Buffer.from(JSON.stringify({ bucket: "bkt", name: "obj.dcm", generation: 123 })).toString("base64"),
      },
    };
    const perfCtx = { addRef: () => {} };

    // Stub GCS module used inside eventhandlers after require
    const gcsPath = require.resolve("../src/gcs");
    const gcsModule = require(gcsPath);
    if (gcsModule.downloadToMemory && gcsModule.downloadToMemory.restore) gcsModule.downloadToMemory.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    sinon.stub(gcsModule, "downloadToMemory").resolves(Buffer.from("fake-dcm"));
    sinon.stub(gcsModule, "createUriPath").callsFake((bucket, object) => `gs://${bucket}/${object}`);

    await eventhandlers.handleGcsPubSubUnwrap(ctx, perfCtx);

    assert.ok(insertStub.called, "BigQuery insert should be called");
  });

  it("inserts payload conforming to schema via GCS archive/delete paths (no metadata, no embeddingVector)", async () => {
    const eventhandlers = require("../src/eventhandlers");
    const perfCtx = { addRef: () => {} };

    for (const eventType of ["OBJECT_ARCHIVE", "OBJECT_DELETE"]) {
      insertStub.resetHistory();
      const ctx = {
        message: {
          attributes: {
            eventType,
            bucketId: "bkt",
            objectId: "obj.dcm",
          },
          data: Buffer.from(JSON.stringify({ bucket: "bkt", name: "obj.dcm", generation: 456 })).toString("base64"),
        },
      };

      // Stub GCS per test safely
      const gcsPath = require.resolve("../src/gcs");
      const gcsModule = require(gcsPath);
      if (gcsModule.downloadToMemory && gcsModule.downloadToMemory.restore) gcsModule.downloadToMemory.restore();
      if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
      sinon.stub(gcsModule, "downloadToMemory").resolves(Buffer.from("fake-dcm"));
      sinon.stub(gcsModule, "createUriPath").callsFake((bucket, object) => `gs://${bucket}/${object}`);

      await eventhandlers.handleGcsPubSubUnwrap(ctx, perfCtx);

      assert.ok(insertStub.calledOnce, `Insert should be called for ${eventType}`);
      const row = insertStub.firstCall.args[0];
      validateRow(row);
      assert.strictEqual(row.metadata, null, "metadata should be null for archive/delete");
      assert.strictEqual(row.embeddingVector, null, "embeddingVector should be null for archive/delete");
      assert.strictEqual(row.info.event, eventType, "info.event should reflect event type");
      assert.strictEqual(row.info.input.type, "GCS", "input.type should be GCS");
    }
  });

  it("inserts payload with populated embeddingVector when vector model is configured", async () => {
    // Update config to enable embeddings
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances" },
        embedding: { input: { vector: { model: "multimodalembedding@001" } } },
      },
      jsonOutput: { explicitBulkDataRoot: false },
      src: "TEST",
    });

    // Refresh config and eventhandlers with current config
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/eventhandlers")];
    // Stub embeddings BEFORE requiring eventhandlers so it binds to the stubbed function
    const embeddingsModule = require("../src/embeddings");
    const vec = Array.from({ length: 16 }, (_, i) => i * 0.01); // small vector for test
    const stub = sinon.stub(embeddingsModule, "createVectorEmbedding").resolves({
      embedding: vec,
      objectPath: "gs://bkt/obj.jpg",
      objectSize: 123,
      objectMimeType: "image/jpeg",
    });
    const eventhandlers = require("../src/eventhandlers");

    // Stub GCS
    const gcsModule = require("../src/gcs");
    if (gcsModule.downloadToMemory && gcsModule.downloadToMemory.restore) gcsModule.downloadToMemory.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    sinon.stub(gcsModule, "downloadToMemory").resolves(Buffer.from("fake-dcm"));
    sinon.stub(gcsModule, "createUriPath").callsFake((bucket, object) => `gs://${bucket}/${object}`);

    const ctx = {
      message: {
        attributes: {
          eventType: "OBJECT_FINALIZE",
          bucketId: "bkt",
          objectId: "obj.dcm",
        },
        data: Buffer.from(JSON.stringify({ bucket: "bkt", name: "obj.dcm", generation: 789 })).toString("base64"),
      },
    };
    const perfCtx = { addRef: () => {} };

    insertStub.resetHistory();
    await eventhandlers.handleGcsPubSubUnwrap(ctx, perfCtx);

    assert.ok(insertStub.calledOnce, "Insert should be called when embeddings enabled");
    const row = insertStub.firstCall.args[0];
    // Ensure model propagated into info
    assert.strictEqual(row.info.embedding.model, "multimodalembedding@001", "embedding model should be set in row info");
    // Verify embedding was attempted
    assert.ok(stub.called, "createVectorEmbedding should be called when vector model configured");
    validateRow(row);
    assert.ok(Array.isArray(row.embeddingVector), "embeddingVector should be an array");
    assert.strictEqual(row.embeddingVector.length, vec.length, "embeddingVector length should match stubbed vector");
    assert.ok(row.embeddingVector.every((v) => typeof v === "number"), "embeddingVector should contain numbers");

    // Check embedding info object metadata presence
    assert.strictEqual(row.info.embedding.model, "multimodalembedding@001");
    assert.ok(row.info.embedding.input);
    assert.strictEqual(row.info.embedding.input.path, "gs://bkt/obj.jpg");
    assert.strictEqual(row.info.embedding.input.size, 123);
    assert.strictEqual(row.info.embedding.input.mimeType, "image/jpeg");

    // Restore stub
    stub.restore();
  });
});
