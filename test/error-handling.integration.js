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
const request = require("supertest");
const fs = require("fs");
const path = require("path");
const sinon = require("sinon");

/**
 * Integration tests for error handling and HTTP status codes
 * 
 * Tests that non-retryable processing errors are acknowledged (200)
 * while retryable errors (transient failures) return 5xx for Pub/Sub retry.
 */
describe("error-handling integration", () => {
  let app;
  let server;
  let gcsStub;
  let hcapiStub;
  let bigqueryStub;
  const testDicomFile = path.join(__dirname, "files", "dcm", "ct.dcm");
  const invalidFile = path.join(__dirname, "files", "dcm", "notdicom.txt");

  before(() => {
    // Set up test environment
    process.env.DCM2BQ_CONFIG = JSON.stringify({
      gcpConfig: {
        projectId: "test-project",
        location: "us-central1",
        bigQuery: {
          datasetId: "test_dataset",
          instancesTableId: "instances"
        }
      },
      dicomParser: {},
      jsonOutput: {
        useArrayWithSingleValue: false,
        ignoreGroupLength: true,
        ignoreMetaHeader: false,
        ignorePrivate: false,
        ignoreBinary: false,
        useCommonNames: true,
        explicitBulkDataRoot: false
      }
    });

    // Mock GCS and BigQuery before loading server
    const gcs = require("../src/gcs");
    const hcapi = require("../src/hcapi");
    const bigquery = require("../src/bigquery");
    
    gcsStub = sinon.stub(gcs, "downloadToMemory");
    hcapiStub = sinon.stub(hcapi, "downloadToMemory");
    bigqueryStub = sinon.stub(bigquery, "insert").resolves();

    // Clear require cache and load server
    delete require.cache[require.resolve("../src/server")];
    const { HttpServer } = require("../src/server");
    server = new HttpServer(0);
    server.start();
    app = server.server;
  });

  after(() => {
    // Restore stubs
    if (gcsStub) gcsStub.restore();
    if (hcapiStub) hcapiStub.restore();
    if (bigqueryStub) bigqueryStub.restore();
    
    if (server) {
      server.stop();
    }
    delete process.env.DCM2BQ_CONFIG;
  });

  describe("non-retryable processing errors (200)", () => {
    it("should return 400 for invalid Pub/Sub message schema", async () => {
      const invalidMessage = {
        // Completely missing message property - fails schema validation
        subscription: "test",
        deliveryAttempt: 1
      };

      const response = await request(app)
        .post("/")
        .send(invalidMessage)
        .expect(400);

      assert(response.body.reason);
      assert(response.body.reason.includes("No match to supported schemas"));
    });

    it("should return 200 for invalid DICOM file", async () => {
      const invalidDicomData = fs.readFileSync(invalidFile);
      
      // Mock GCS to return invalid DICOM data
      gcsStub.resolves(invalidDicomData);
      
      const message = {
        message: {
          attributes: {
            payloadFormat: "JSON_API_V1",
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "test.dcm",
            objectGeneration: "12345"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "test.dcm",
            generation: "12345",
            size: invalidDicomData.length.toString()
          })).toString("base64")
        }
      };

      // Mock GCS download
      const gcs = require("../src/gcs");
      const originalDownload = gcs.downloadToMemory;
      gcs.downloadToMemory = async () => invalidDicomData;

      try {
        await request(app)
          .post("/")
          .send(message)
          .expect(200);

        assert.strictEqual(bigqueryStub.called, false, "Should not persist synthetic non-retryable failure rows");
      } finally {
        gcs.downloadToMemory = originalDownload;
      }
    });
  });

  describe("retryable errors (5xx)", () => {
    it("should return 500 for unknown errors without retryable flag", async () => {
      // Mock GCS to throw a generic error (network timeout, etc)
      gcsStub.rejects(new Error("Network timeout"));
      
      const message = {
        message: {
          attributes: {
            payloadFormat: "JSON_API_V1",
            eventType: "OBJECT_FINALIZE",
            bucketId: "test-bucket",
            objectId: "test.dcm",
            objectGeneration: "12345"
          },
          data: Buffer.from(JSON.stringify({
            bucket: "test-bucket",
            name: "test.dcm",
            generation: "12345",
            size: "1000"
          })).toString("base64")
        }
      };

      const response = await request(app)
        .post("/")
        .send(message)
        .expect(500);

      assert(response.body.reason);
      assert(response.body.reason.includes("Network timeout"));
    });
  });

  describe("error response format", () => {
    it("should include messageId and code in error response", async () => {
      const invalidMessage = {
        subscription: "test",
        deliveryAttempt: 1,
        message: {
          messageId: "test-message-123",
          publishTime: "2024-01-01T00:00:00.000Z"
          // Missing data and attributes - schema validation fails
        }
      };

      const response = await request(app)
        .post("/")
        .send(invalidMessage)
        .expect(400);

      assert.strictEqual(response.body.messageId, "test-message-123");
      assert.strictEqual(response.body.code, 400);
      assert(response.body.reason);
    });

    it("should use 'unknown' messageId when not provided", async () => {
      const invalidMessage = {
        invalid: "structure"
      };

      const response = await request(app)
        .post("/")
        .send(invalidMessage);

      assert.strictEqual(response.body.messageId, "unknown");
    });
  });
});
