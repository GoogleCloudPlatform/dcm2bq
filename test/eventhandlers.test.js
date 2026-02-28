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
const { createNonRetryableError } = require("../src/utils");

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
    createVectorEmbeddingStub.resetHistory();
    createVectorEmbeddingStub.resetBehavior();
    createVectorEmbeddingStub.resolves({
      embedding: Array.from({ length: 1408 }, (_, i) => Math.sin(i) * 0.001),
    });
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

    it("should persist metadata when embedding fails with non-retryable error", async function() {
      this.timeout(5000);

      const dcmPath = path.join(__dirname, "files/dcm/ct.dcm");
      const dcmBuffer = fs.readFileSync(dcmPath);
      mockFile.download.resetHistory();
      mockFile.download.resolves([dcmBuffer]);

      createVectorEmbeddingStub.rejects(
        createNonRetryableError("Unsupported SOP for embedding", 422)
      );

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

      assert.strictEqual(bqInsertStub.callCount, 1, "Should persist row even on non-retryable embedding error");
      const row = bqInsertStub.getCall(0).args[0];
      assert.ok(row.metadata, "Should persist metadata");
      assert.ok(!row.embeddingVector, "Should not persist embedding vector when embedding generation fails");
    });

    it("should fail and not persist when embedding fails with retryable error", async function() {
      this.timeout(5000);

      const dcmPath = path.join(__dirname, "files/dcm/ct.dcm");
      const dcmBuffer = fs.readFileSync(dcmPath);
      mockFile.download.resetHistory();
      mockFile.download.resolves([dcmBuffer]);

      const retryableError = new Error("Too many requests");
      retryableError.code = 429;
      createVectorEmbeddingStub.rejects(retryableError);

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

      await assert.rejects(
        eventhandlers.handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx }),
        (error) => error && error.code === 429
      );

      assert.strictEqual(bqInsertStub.callCount, 0, "Should not persist row when embedding error is retryable");
    });
  });

  describe("Hash Generation for Instance IDs", () => {
    let crypto;

    before(() => {
      crypto = require("crypto");
    });

    function generateHash(studyUid, seriesUid, sopInstanceUid) {
      const idSource = `${studyUid}|${seriesUid}|${sopInstanceUid}`;
      return crypto.createHash("sha256").update(idSource).digest("hex").substring(0, 16);
    }

    it("should generate deterministic hash from DICOM UIDs", () => {
      const studyUid = "1.2.840.113619.2.408.2024.1";
      const seriesUid = "1.2.840.113619.2.408.2024.1.1";
      const sopInstanceUid = "1.2.840.113619.2.408.2024.1.1.1";

      const hash1 = generateHash(studyUid, seriesUid, sopInstanceUid);
      const hash2 = generateHash(studyUid, seriesUid, sopInstanceUid);

      assert.strictEqual(hash1, hash2, 
        "Same UIDs should always produce the same hash (deterministic)");
      assert.strictEqual(hash1.length, 16, 
        "Hash should be 16 hex characters (64 bits)");
    });

    it("should produce different hashes for different SOP Instance UIDs", () => {
      const studyUid = "1.2.840.113619.2.408.2024.1";
      const seriesUid = "1.2.840.113619.2.408.2024.1.1";
      const sopInstanceUid1 = "1.2.840.113619.2.408.2024.1.1.1";
      const sopInstanceUid2 = "1.2.840.113619.2.408.2024.1.1.2";

      const hash1 = generateHash(studyUid, seriesUid, sopInstanceUid1);
      const hash2 = generateHash(studyUid, seriesUid, sopInstanceUid2);

      assert.notStrictEqual(hash1, hash2, 
        "Different SOPInstanceUIDs should produce different hashes");
    });

    it("should produce different hashes for different Series UIDs", () => {
      const studyUid = "1.2.840.113619.2.408.2024.1";
      const seriesUid1 = "1.2.840.113619.2.408.2024.1.1";
      const seriesUid2 = "1.2.840.113619.2.408.2024.1.2";
      const sopInstanceUid = "1.2.840.113619.2.408.2024.1.1.1";

      const hash1 = generateHash(studyUid, seriesUid1, sopInstanceUid);
      const hash2 = generateHash(studyUid, seriesUid2, sopInstanceUid);

      assert.notStrictEqual(hash1, hash2, 
        "Different SeriesInstanceUIDs should produce different hashes");
    });

    it("should produce different hashes for different Study UIDs", () => {
      const studyUid1 = "1.2.840.113619.2.408.2024.1";
      const studyUid2 = "1.2.840.113619.2.408.2024.2";
      const seriesUid = "1.2.840.113619.2.408.2024.1.1";
      const sopInstanceUid = "1.2.840.113619.2.408.2024.1.1.1";

      const hash1 = generateHash(studyUid1, seriesUid, sopInstanceUid);
      const hash2 = generateHash(studyUid2, seriesUid, sopInstanceUid);

      assert.notStrictEqual(hash1, hash2, 
        "Different StudyInstanceUIDs should produce different hashes");
    });

    it("should handle empty UIDs gracefully", () => {
      const hash1 = generateHash("", "", "");
      const hash2 = generateHash("", "", "");

      assert.strictEqual(hash1, hash2, 
        "Empty UIDs should still produce consistent (though identical) hashes");
      assert.strictEqual(hash1.length, 16, 
        "Hash should still be 16 characters");
    });

    it("should handle missing UIDs (undefined/null)", () => {
      const hash1 = generateHash(undefined || "", undefined || "", undefined || "");
      const hash2 = generateHash(null || "", null || "", null || "");

      assert.strictEqual(hash1, hash2, 
        "Missing UIDs should produce the same hash as empty strings");
      assert.strictEqual(hash1.length, 16, 
        "Hash should still be valid");
    });

    it("should process metadata string correctly in persistRow", async function() {
      this.timeout(10000);

      const dicomPath = path.join(__dirname, "files/dcm/ct.dcm");
      const dicomBuffer = fs.readFileSync(dicomPath);

      // Reset the stub
      bqInsertStub.resetHistory();
      mockFile.download.resetHistory();
      mockFile.download.resolves([dicomBuffer]);

      // Create mock pub/sub message
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

      // Verify that BigQuery insert was called
      assert(bqInsertStub.called, "insert should be called");

      const row = bqInsertStub.getCall(0).args[0];
      assert.ok(row.id, "Should have generated an id");
      assert.strictEqual(row.id.length, 16, "Id should be 16 hex characters");
      
      // Verify that the metadata was parsed correctly to generate the hash
      const metadata = JSON.parse(row.metadata);
      assert.ok(metadata.SOPInstanceUID, "Metadata should contain SOPInstanceUID");
      assert.ok(metadata.SeriesInstanceUID, "Metadata should contain SeriesInstanceUID");
      assert.ok(metadata.StudyInstanceUID, "Metadata should contain StudyInstanceUID");

      // Verify the hash is deterministic
      const expectedHash = generateHash(
        metadata.StudyInstanceUID,
        metadata.SeriesInstanceUID,
        metadata.SOPInstanceUID
      );
      assert.strictEqual(row.id, expectedHash, 
        "Generated id should match hash of actual DICOM UIDs");
    });
  });
});
