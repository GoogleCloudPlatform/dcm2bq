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
const path = require("path");
const sinon = require("sinon");

// We need to require these before stubbing
const bq = require("../src/bigquery");
const consts = require("../src/consts");
const { Storage } = require("@google-cloud/storage");

describe("eventhandlers", () => {
  let bqInsertStub;
  let doRequestStub;
  let storageStub;
  let createVectorEmbeddingStub;
  let mockBucket;
  let mockFile;
  let eventhandlers;

  before(() => {
    // Clear modules from cache to ensure fresh load
    const eventhandlersPath = require.resolve("../src/eventhandlers");
    const gcsPath = require.resolve("../src/gcs");
    const httpRetryPath = require.resolve("../src/http-retry");
    const embeddingsPath = require.resolve("../src/embeddings");
    delete require.cache[eventhandlersPath];
    delete require.cache[gcsPath];
    delete require.cache[httpRetryPath];
    delete require.cache[embeddingsPath];
    
    // Stub BigQuery insert method to avoid actual database operations
    bqInsertStub = sinon.stub(bq, "insert").resolves();
    
    // Stub http-retry's doRequest to prevent real API calls to Vertex AI embeddings
    const mockVec = Array.from({ length: 1408 }, (_, i) => Math.sin(i) * 0.001);
    const httpRetryModule = require("../src/http-retry");
    doRequestStub = sinon.stub(httpRetryModule, "doRequest").resolves({
      predictions: [{ imageEmbedding: mockVec, textEmbedding: mockVec }],
    });
    
    // Create mock file and bucket objects that can be reconfigured per test
    mockFile = {
      download: sinon.stub().resolves([Buffer.from("mock-data")]),
      save: sinon.stub().resolves(),
      getSignedUrl: sinon.stub().resolves(["gs://mock-bucket/path/to/file"])
    };
    mockBucket = {
      file: sinon.stub().returns(mockFile)
    };
    
    // Stub Storage.prototype.bucket BEFORE requiring gcs so the singleton Storage instance gets the stub
    storageStub = sinon.stub(Storage.prototype, "bucket").returns(mockBucket);
    
    // NOW require gcs, embeddings, and eventhandlers after stubs are in place
    // This ensures the Storage instance created in gcs.js uses the stubbed bucket method
    // and embeddings module uses the stubbed doRequest from http-retry
    require("../src/gcs");
    const embeddingsModule = require("../src/embeddings");
    // Stub the createVectorEmbedding function directly to ensure embeddings don't make real API calls
    createVectorEmbeddingStub = sinon.stub(embeddingsModule, "createVectorEmbedding").resolves({
      embedding: Array.from({ length: 1408 }, (_, i) => Math.sin(i) * 0.001),
    });
    eventhandlers = require("../src/eventhandlers");
  });

  after(() => {
    // Restore stubs
    bqInsertStub.restore();
    doRequestStub.restore();
    storageStub.restore();
    createVectorEmbeddingStub.restore();
  });

  beforeEach(() => {
    // Reset call history before each test
    bqInsertStub.resetHistory();
  });

  afterEach(() => {
    // Nothing to restore per-test now
  });

  describe("archive file handling", () => {
    it("should process a zip file containing DICOM files", async function() {
      this.timeout(10000);
      
      const zipPath = path.join(__dirname, "files/zip/study.zip");
      const zipBuffer = fs.readFileSync(zipPath);
      
      // Reset and configure the mock to return the zip buffer for this test
      mockFile.download.resetHistory();
      mockFile.download.resolves([zipBuffer]);

      // Create mock pub/sub message for a zip file
      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "test.zip"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "test.zip",
            generation: "123456"
          })).toString("base64")
        }
      };

      const perfCtx = {
        addRef: sinon.stub()
      };

      await eventhandlers.handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Verify that BigQuery insert was called for each DICOM file in the zip
      assert(bqInsertStub.called, 
        `insert should be called. Actual calls: ${bqInsertStub.callCount}`);
      
      // Get the number of times insert was called (one for each DICOM file)
      const callCount = bqInsertStub.callCount;
      assert(callCount > 0, "Should process at least one DICOM file from zip");

      // Check that each call has the correct path format (basePath#fileName.dcm)
      for (let i = 0; i < callCount; i++) {
        const call = bqInsertStub.getCall(i);
        const row = call.args[0];
        
        assert.ok(row.path, "Should have path");
        assert.ok(row.id, "Should have id");
        assert.ok(row.timestamp, "Should have timestamp");
        assert.ok(row.version, "Should have version");
        assert.ok(row.info, "Should have info");
        assert.ok(row.metadata, "Should have metadata");
        
        // Verify the path format is correct for archive files (uriPath = basePath#fileName)
        // The path should start with gs:// for GCS paths or just the bucket/object path
        assert.ok(row.path.includes("#") || row.path.includes(".dcm"), 
          `Path should include # separator for archive files or end with .dcm. Got: ${row.path}`);
      }
    });

    it("should process a tar.gz file containing DICOM files", async function() {
      this.timeout(10000);
      
      const tarPath = path.join(__dirname, "files/tar/study.tar.gz");
      const tarBuffer = fs.readFileSync(tarPath);

      mockFile.download.resetHistory();
      mockFile.download.resolves([tarBuffer]);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "test.tgz"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "test.tgz",
            generation: "123456"
          })).toString("base64")
        }
      };

      const perfCtx = {
        addRef: sinon.stub()
      };

      await eventhandlers.handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      assert(bqInsertStub.called, 
        `insert should be called for tar.gz archive. Actual calls: ${bqInsertStub.callCount}`);
      const callCount = bqInsertStub.callCount;
      assert(callCount > 0, "Should process at least one DICOM file from tar.gz archive");

      for (let i = 0; i < callCount; i++) {
        const call = bqInsertStub.getCall(i);
        const row = call.args[0];
        assert.ok(row.path.includes("#"), `Path should include # separator for archive files. Got: ${row.path}`);
      }
    });

    it("should handle errors when processing invalid zip files", async function() {
      this.timeout(5000);

      // Create a buffer that is not a valid zip file
      const invalidZipBuffer = Buffer.from("not a valid zip file");
      
      // Reset and configure the mock to return invalid zip for this test
      mockFile.download.resetHistory();
      mockFile.download.resolves([invalidZipBuffer]);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "invalid.zip"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "invalid.zip",
            generation: "123456"
          })).toString("base64")
        }
      };

      const perfCtx = {
        addRef: sinon.stub()
      };

      // Should not throw, but should log error
      await eventhandlers.handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Should not have called insert since zip extraction failed
      assert.strictEqual(bqInsertStub.callCount, 0, 
        "Should not process any files when zip extraction fails");
    });

    it("should process regular DICOM files (not zip)", async function() {
      this.timeout(5000);

      const dcmPath = path.join(__dirname, "files/dcm/ct.dcm");
      const dcmBuffer = fs.readFileSync(dcmPath);
      
      // Reset and configure the mock to return DICOM buffer for this test
      mockFile.download.resetHistory();
      mockFile.download.resolves([dcmBuffer]);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "ct.dcm"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "ct.dcm",
            generation: "123456"
          })).toString("base64")
        }
      };

      const perfCtx = {
        addRef: sinon.stub()
      };

      await eventhandlers.handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Verify that BigQuery insert was called once
      assert.strictEqual(bqInsertStub.callCount, 1, 
        "Should process exactly one DICOM file");

      const row = bqInsertStub.getCall(0).args[0];
      assert.strictEqual(row.path, "gs://test-bucket/ct.dcm", 
        "Path should be the DICOM file uriPath");
    });
  });
});
