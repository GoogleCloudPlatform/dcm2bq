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
const path = require("path");

/**
 * Validate the row object against expected BigQuery schema constraints.
 * This is a light-weight validator matching tf/init.schema.json structure.
 */
function validateRow(row) {
  // Top-level fields
  assert.strictEqual(typeof row.id, "string", "id must be a string");
  assert.ok(row.id.length >= 16, "id must be a SHA-derived string");
  assert.ok(row.timestamp instanceof Date || typeof row.timestamp === "string", "timestamp must be Date or string");
  assert.strictEqual(typeof row.path, "string", "path must be a string");
  assert.strictEqual(typeof row.version, "string", "version must be a string");

  // info record
  assert.strictEqual(typeof row.info, "object", "info must be an object");
  assert.strictEqual(typeof row.info.event, "string", "info.event must be a string");
  assert.strictEqual(typeof row.info.input, "object", "info.input must be an object");
  assert.strictEqual(row.info.embedding, undefined, "info.embedding should not be present on instances rows");

  // metadata JSON string or null
  assert.ok(row.metadata === null || typeof row.metadata === "string", "metadata must be a JSON string or null");
  if (typeof row.metadata === "string") {
    // ensure valid JSON
    JSON.parse(row.metadata);
  }

  // embeddingVector should no longer be present on instances rows (moved to embeddings table)
  assert.strictEqual(row.embeddingVector, undefined, "embeddingVector should not be present on instances rows");
}

describe("BigQuery insert payload matches schema", () => {
  let originalEnv;
  let insertStub;
  let originalBigQueryModule;
  const validDicomBuffer = fs.readFileSync(path.join(__dirname, "files", "dcm", "ct.dcm"));

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

    // Save original bigquery module and clear require cache for fresh load
    const bigqueryPath = require.resolve("../src/bigquery");
    originalBigQueryModule = require.cache[bigqueryPath];
    try { delete require.cache[bigqueryPath]; } catch (err) {
      // Ignore errors if module was not previously loaded
    }
    
    // Stub modules before requiring eventhandlers
    delete require.cache[bigqueryPath];
    insertStub = sinon.stub().callsFake((row) => {
      validateRow(row);
      return Promise.resolve();
    });
    require.cache[bigqueryPath] = {
      exports: { insert: insertStub, insertEmbeddings: sinon.stub().resolves() },
    };

    const dicomToJsonPath = require.resolve("../src/dicomtojson");
    delete require.cache[dicomToJsonPath];
    class FakeDicomFile {
      constructor(fileUrl) { this.fileUrl = fileUrl; }
      toJson() { return { SOPInstanceUID: "1.2.3", PatientID: "P1" }; }
    }
    require.cache[dicomToJsonPath] = {
      exports: { DicomFile: FakeDicomFile },
    };

    const embeddingsPath = require.resolve("../src/embeddings");
    delete require.cache[embeddingsPath];
    require.cache[embeddingsPath] = {
      exports: {
        createVectorEmbedding: async () => null,
        createEmbeddingInput: async () => null,
      },
    };

    // Ensure gcs module is reloaded fresh per test to avoid cross-suite cache bleed.
    const gcsPath = require.resolve("../src/gcs");
    delete require.cache[gcsPath];

    // Ensure eventhandlers is reloaded fresh so it binds to current test stubs.
    const eventhandlersPath = require.resolve("../src/eventhandlers");
    delete require.cache[eventhandlersPath];
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
    if (gcsModule.downloadToFile && gcsModule.downloadToFile.restore) gcsModule.downloadToFile.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    // Clear caches to avoid cross-suite state contamination.
    ["../src/dicomtojson", "../src/embeddings", "../src/eventhandlers", "../src/gcs"].forEach((m) => {
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
    if (gcsModule.downloadToFile && gcsModule.downloadToFile.restore) gcsModule.downloadToFile.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    sinon.stub(gcsModule, "downloadToFile").callsFake(async (_bucket, _object, destinationPath) => {
      await fs.promises.writeFile(destinationPath, validDicomBuffer);
      return destinationPath;
    });
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
      if (gcsModule.downloadToFile && gcsModule.downloadToFile.restore) gcsModule.downloadToFile.restore();
      if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
      sinon.stub(gcsModule, "downloadToFile").callsFake(async (_bucket, _object, destinationPath) => {
        await fs.promises.writeFile(destinationPath, validDicomBuffer);
        return destinationPath;
      });
      sinon.stub(gcsModule, "createUriPath").callsFake((bucket, object) => `gs://${bucket}/${object}`);

      await eventhandlers.handleGcsPubSubUnwrap(ctx, perfCtx);

      assert.ok(insertStub.calledOnce, `Insert should be called for ${eventType}`);
      const row = insertStub.firstCall.args[0];
      validateRow(row);
      assert.strictEqual(row.metadata, null, "metadata should be null for archive/delete");
      assert.strictEqual(row.embeddingVector, undefined, "embeddingVector should be undefined (omitted) for archive/delete");
      assert.strictEqual(row.info.event, eventType, "info.event should reflect event type");
      assert.strictEqual(row.info.input.type, "GCS", "input.type should be GCS");
    }
  });

  it("inserts instance row and embeddings to separate table when vector model is configured", async () => {
    // Update config to enable embeddings
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: { datasetId: "dicom", instancesTableId: "instances", embeddingsTableId: "embeddings" },
        embedding: { input: { vector: { model: "multimodalembedding@001" } } },
      },
      jsonOutput: { explicitBulkDataRoot: false },
      src: "TEST",
    });

    // Refresh config and eventhandlers with current config
    delete require.cache[require.resolve("../src/config")];
    delete require.cache[require.resolve("../src/eventhandlers")];

    // Re-create bigquery stub with insertEmbeddings tracking
    const bigqueryPath = require.resolve("../src/bigquery");
    delete require.cache[bigqueryPath];
    const insertEmbeddingsStub = sinon.stub().resolves();
    insertStub.resetHistory();
    require.cache[bigqueryPath] = {
      exports: { insert: insertStub, insertEmbeddings: insertEmbeddingsStub },
    };

    // Stub embeddings BEFORE requiring eventhandlers so it binds to the stubbed function
    const embeddingsModule = require("../src/embeddings");
    const vec = Array.from({ length: 16 }, (_, i) => i * 0.01);
    const stub = sinon.stub(embeddingsModule, "createVectorEmbedding").resolves([{
      embedding: vec,
      objectPath: "gs://bkt/obj.jpg",
      objectSize: 123,
      objectMimeType: "image/jpeg",
      frameNumber: null,
    }]);
    const eventhandlers = require("../src/eventhandlers");

    // Stub GCS
    const gcsModule = require("../src/gcs");
    if (gcsModule.downloadToFile && gcsModule.downloadToFile.restore) gcsModule.downloadToFile.restore();
    if (gcsModule.createUriPath && gcsModule.createUriPath.restore) gcsModule.createUriPath.restore();
    sinon.stub(gcsModule, "downloadToFile").callsFake(async (_bucket, _object, destinationPath) => {
      await fs.promises.writeFile(destinationPath, validDicomBuffer);
      return destinationPath;
    });
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

    await eventhandlers.handleGcsPubSubUnwrap(ctx, perfCtx);

    // Instances row should NOT have embeddingVector or info.embedding
    assert.ok(insertStub.calledOnce, "Insert should be called when embeddings enabled");
    const row = insertStub.firstCall.args[0];
    assert.ok(stub.called, "createVectorEmbedding should be called when vector model configured");
    validateRow(row);

    // Embeddings should be written to the separate embeddings table
    assert.ok(insertEmbeddingsStub.calledOnce, "insertEmbeddings should be called");
    const embeddingRows = insertEmbeddingsStub.firstCall.args[0];
    assert.ok(Array.isArray(embeddingRows), "embedding rows should be an array");
    assert.strictEqual(embeddingRows.length, 1, "should have one embedding row");
    assert.ok(Array.isArray(embeddingRows[0].embeddingVector), "embedding row should have embeddingVector array");
    assert.strictEqual(embeddingRows[0].embeddingVector.length, vec.length, "embedding vector length should match");
    assert.strictEqual(embeddingRows[0].instanceId, row.id, "embedding row instanceId should match instances row id");

    // Restore stub
    stub.restore();
  });
});
