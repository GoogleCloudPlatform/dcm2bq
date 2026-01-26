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

describe("process-command", () => {
  let processCommand;

  beforeEach(() => {
    // Clear require cache to ensure fresh import
    delete require.cache[require.resolve("../src/process-command")];
    processCommand = require("../src/process-command");
  });

  describe("isArchiveFile", () => {
    it("should detect .zip files", () => {
      assert.strictEqual(processCommand.isArchiveFile("study.zip"), true);
      assert.strictEqual(processCommand.isArchiveFile("/path/to/study.zip"), true);
    });

    it("should detect .tgz files", () => {
      assert.strictEqual(processCommand.isArchiveFile("study.tgz"), true);
      assert.strictEqual(processCommand.isArchiveFile("/path/to/study.tgz"), true);
    });

    it("should detect .tar.gz files", () => {
      assert.strictEqual(processCommand.isArchiveFile("study.tar.gz"), true);
      assert.strictEqual(processCommand.isArchiveFile("/path/to/study.tar.gz"), true);
    });

    it("should not detect .dcm files as archives", () => {
      assert.strictEqual(processCommand.isArchiveFile("file.dcm"), false);
      assert.strictEqual(processCommand.isArchiveFile("/path/to/file.dcm"), false);
    });

    it("should not detect other file types as archives", () => {
      assert.strictEqual(processCommand.isArchiveFile("file.txt"), false);
      assert.strictEqual(processCommand.isArchiveFile("file.tar"), false);
      assert.strictEqual(processCommand.isArchiveFile("file.gz"), false);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(processCommand.isArchiveFile("STUDY.ZIP"), true);
      assert.strictEqual(processCommand.isArchiveFile("Study.TGZ"), true);
      assert.strictEqual(processCommand.isArchiveFile("STUDY.TAR.GZ"), true);
    });
  });

  describe("loadDeploymentConfig", () => {
    const testConfigPath = path.join(__dirname, "test-deployment-config.json");
    const validConfig = {
      gcpConfig: {
        projectId: "test-project",
        gcs_bucket_name: "test-dicom-bucket",
        bigQuery: {
          datasetId: "test_dataset",
          instancesTableId: "instances"
        },
        embedding: {
          input: {
            gcsBucketPath: "gs://test-processed-bucket/processed-data"
          }
        }
      }
    };

    beforeEach(() => {
      // Create a test config file
      fs.writeFileSync(testConfigPath, JSON.stringify(validConfig));
    });

    afterEach(() => {
      // Clean up test config file
      if (fs.existsSync(testConfigPath)) {
        fs.unlinkSync(testConfigPath);
      }
    });

    it("should load valid config file", () => {
      const config = processCommand.loadDeploymentConfig(testConfigPath);
      assert.deepStrictEqual(config, validConfig);
    });

    it("should throw error if file not found", () => {
      assert.throws(
        () => processCommand.loadDeploymentConfig("/nonexistent/path.json"),
        /Deployment config file not found/
      );
    });

    it("should throw error if config has invalid JSON", () => {
      const invalidConfigPath = path.join(__dirname, "invalid-config.json");
      fs.writeFileSync(invalidConfigPath, "{ invalid json }");
      
      try {
        assert.throws(
          () => processCommand.loadDeploymentConfig(invalidConfigPath),
          /Failed to load deployment config/
        );
      } finally {
        fs.unlinkSync(invalidConfigPath);
      }
    });

    it("should throw error if required fields are missing", () => {
      const incompleteConfig = {
        gcpConfig: {
          projectId: "test-project",
          bigQuery: {
            datasetId: "test_dataset"
            // Missing instancesTableId
          }
        }
      };
      const incompleteConfigPath = path.join(__dirname, "incomplete-config.json");
      fs.writeFileSync(incompleteConfigPath, JSON.stringify(incompleteConfig));
      
      try {
        assert.throws(
          () => processCommand.loadDeploymentConfig(incompleteConfigPath),
          /Missing required fields in config/
        );
      } finally {
        fs.unlinkSync(incompleteConfigPath);
      }
    });

    it("should validate all required fields", () => {
      const requiredFields = [
        { path: "gcpConfig.projectId", label: "projectId" },
        { path: "gcpConfig.bigQuery.datasetId", label: "datasetId" },
        { path: "gcpConfig.bigQuery.instancesTableId", label: "instancesTableId" }
      ];
      
      for (const field of requiredFields) {
        const incompleteConfig = JSON.parse(JSON.stringify(validConfig));
        
        // Delete the field at the specified path
        const parts = field.path.split(".");
        let obj = incompleteConfig;
        for (let i = 0; i < parts.length - 1; i++) {
          obj = obj[parts[i]];
        }
        delete obj[parts[parts.length - 1]];
        
        const incompleteConfigPath = path.join(__dirname, `incomplete-${field.label}.json`);
        fs.writeFileSync(incompleteConfigPath, JSON.stringify(incompleteConfig));
        
        try {
          assert.throws(
            () => processCommand.loadDeploymentConfig(incompleteConfigPath),
            /Missing required fields in config/
          );
        } finally {
          fs.unlinkSync(incompleteConfigPath);
        }
      }
    });
  });

  describe("calculatePollTimeout", () => {
    it("should calculate timeout for small files", () => {
      const fileSize = 1024 * 1024; // 1 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 60000, 10000);
      assert.strictEqual(timeout, 70000); // 60000 + (1 * 10000)
    });

    it("should calculate timeout for medium files", () => {
      const fileSize = 10 * 1024 * 1024; // 10 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 60000, 10000);
      assert.strictEqual(timeout, 160000); // 60000 + (10 * 10000)
    });

    it("should calculate timeout for large files", () => {
      const fileSize = 100 * 1024 * 1024; // 100 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 60000, 10000);
      assert.strictEqual(timeout, 1060000); // 60000 + (100 * 10000)
    });

    it("should handle zero file size", () => {
      const timeout = processCommand.calculatePollTimeout(0, 60000, 10000);
      assert.strictEqual(timeout, 60000);
    });

    it("should respect custom base and per-MB timeouts", () => {
      const fileSize = 5 * 1024 * 1024; // 5 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 30000, 5000);
      assert.strictEqual(timeout, 55000); // 30000 + (5 * 5000)
    });
  });

  describe("formatResultRow", () => {
    it("should format basic result row", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("File: file.dcm"));
      assert(formatted.includes("Uploaded: 2024-01-12T15:40:00Z"));
      assert(formatted.includes("Full Path: gs://bucket/file.dcm"));
    });

    it("should include event information if present", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        event: "OBJECT_FINALIZE"
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("File: file.dcm"));
    });

    it("should include input information if present", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        input: {
          size: 1024000,
          type: "GCS"
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Input:"));
      assert(formatted.includes("1000.00 KB"));
      assert(formatted.includes("Type: GCS"));
    });

    it("should include embedding information if present", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        embedding: {
          model: "multimodalembedding@001",
          input: {
            path: "gs://bucket/extracted.jpg",
            size: 50000,
            mimeType: "image/jpeg"
          }
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Embedding:"));
      assert(formatted.includes("Model: multimodalembedding@001"));
      assert(formatted.includes("Path: gs://bucket/extracted.jpg"));
      assert(formatted.includes("Mime Type: image/jpeg"));
    });

    it("should parse and include metadata information", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        metadata: JSON.stringify({
          PatientName: "John^Doe",
          PatientID: "12345",
          StudyDate: "20240112",
          Modality: "CT"
        })
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Patient Name: John^Doe"));
      assert(formatted.includes("Patient ID: 12345"));
      assert(formatted.includes("Study Date: 20240112"));
      assert(formatted.includes("Modality: CT"));
    });

    it("should handle metadata as object", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        metadata: {
          PatientName: "Jane^Smith",
          PatientID: "67890",
          StudyDate: "20240113",
          Modality: "MR"
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Patient Name: Jane^Smith"));
      assert(formatted.includes("Patient ID: 67890"));
    });

    it("should handle invalid metadata gracefully", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        metadata: "{ invalid json }"
      };
      
      // Should not throw, should just skip metadata
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Path:"));
      assert(!formatted.includes("Patient Name:"));
    });

    it("should show N/A for missing optional fields", () => {
      const row = {
        path: undefined,
        timestamp: "2024-01-12T15:40:00Z",
        version: 0
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Path: N/A"));
    });

    it("should display detailed embedding information with input details", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        embedding: {
          model: "multimodalembedding@001",
          input: {
            path: "gs://bucket/extracted.jpg",
            size: 50000,
            mimeType: "image/jpeg"
          }
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Embedding:"));
      assert(formatted.includes("Model: multimodalembedding@001"));
      assert(formatted.includes("Path: gs://bucket/extracted.jpg"));
      assert(formatted.includes("Size: 48.83 KB"));
      assert(formatted.includes("Mime Type: image/jpeg"));
      assert(formatted.includes("Embedding Vector: Not available"));
    });

    it("should display embedding vector status when present", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        embedding: {
          model: "multimodalembedding@001",
          input: {
            path: "gs://bucket/extracted.jpg",
            size: 50000,
            mimeType: "image/jpeg"
          }
        },
        embeddingVector: [0.1, 0.2, 0.3, 0.4, 0.5]
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Embedding:"));
      assert(formatted.includes("Model: multimodalembedding@001"));
      assert(formatted.includes("Embedding Vector: Present (5 values)"));
    });

    it("should display embedding info from info.embedding when no direct embedding", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        info: {
          embedding: {
            model: "multimodalembedding@001",
            input: {
              path: "gs://bucket/extracted.jpg",
              size: 30000,
              mimeType: "image/jpeg"
            }
          }
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Embedding:"));
      assert(formatted.includes("Model: multimodalembedding@001"));
      assert(formatted.includes("Path: gs://bucket/extracted.jpg"));
      assert(formatted.includes("Size: 29.30 KB"));
    });

    it("should show N/A for embedding input when not available", () => {
      const row = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        embedding: {
          model: "multimodalembedding@001"
        }
      };
      
      const formatted = processCommand.formatResultRow(row);
      assert(formatted.includes("Embedding:"));
      assert(formatted.includes("Model: multimodalembedding@001"));
      assert(formatted.includes("Input: Not available"));
      assert(formatted.includes("Embedding Vector: Not available"));
    });
  });

  describe("formatResultOverview", () => {
    it("should format single result overview", () => {
      const result = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0
      };
      
      const formatted = processCommand.formatResultOverview(result, false);
      assert(formatted.includes("Processing Result Overview"));
      assert(formatted.includes("Path: gs://bucket/file.dcm"));
    });

    it("should format archive results with summary", () => {
      const results = [
        {
          path: "gs://bucket/archive.zip/file1.dcm",
          timestamp: "2024-01-12T15:40:00Z",
          version: 0,
          info: { input: { size: 1000000 } },
          metadata: JSON.stringify({ Modality: "CT" })
        },
        {
          path: "gs://bucket/archive.zip/file2.dcm",
          timestamp: "2024-01-12T15:40:01Z",
          version: 0,
          info: { input: { size: 2000000 } },
          metadata: JSON.stringify({ Modality: "MR" })
        }
      ];
      
      const formatted = processCommand.formatResultOverview(results, true);
      assert(formatted.includes("Archive Processing Results"));
      assert(formatted.includes("Total files processed: 2"));
      assert(formatted.includes("Result 1"));
      assert(formatted.includes("Result 2"));
      assert(formatted.includes("Summary"));
      assert(formatted.includes("Total size: 3000000 bytes"));
      assert(formatted.includes("Modalities: CT, MR"));
    });

    it("should handle array input for single file", () => {
      const result = {
        path: "gs://bucket/file.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0
      };
      
      const formatted = processCommand.formatResultOverview([result], false);
      assert(formatted.includes("Processing Result Overview"));
    });

    it("should aggregate modalities correctly", () => {
      const results = [
        {
          path: "gs://bucket/archive.zip/file1.dcm",
          timestamp: "2024-01-12T15:40:00Z",
          version: 0,
          info: { input: { size: 1000000 } },
          metadata: JSON.stringify({ Modality: "CT" })
        },
        {
          path: "gs://bucket/archive.zip/file2.dcm",
          timestamp: "2024-01-12T15:40:01Z",
          version: 0,
          info: { input: { size: 1000000 } },
          metadata: JSON.stringify({ Modality: "CT" })
        },
        {
          path: "gs://bucket/archive.zip/file3.dcm",
          timestamp: "2024-01-12T15:40:02Z",
          version: 0,
          info: { input: { size: 1000000 } },
          metadata: JSON.stringify({ Modality: "MR" })
        }
      ];
      
      const formatted = processCommand.formatResultOverview(results, true);
      assert(formatted.includes("Modalities: CT, MR"));
    });

    it("should calculate total size correctly", () => {
      const results = [
        { path: "file1.dcm", timestamp: "2024-01-12T15:40:00Z", version: 0, info: { input: { size: 1234567 } } },
        { path: "file2.dcm", timestamp: "2024-01-12T15:40:01Z", version: 0, info: { input: { size: 2345678 } } }
      ];
      
      const formatted = processCommand.formatResultOverview(results, true);
      const totalSize = 1234567 + 2345678;
      assert(formatted.includes(`Total size: ${totalSize} bytes`));
    });

    it("should handle missing input sizes", () => {
      const results = [
        { path: "file1.dcm", timestamp: "2024-01-12T15:40:00Z", version: 0, info: { input: { size: 1000000 } } },
        { path: "file2.dcm", timestamp: "2024-01-12T15:40:01Z", version: 0 } // No input
      ];
      
      const formatted = processCommand.formatResultOverview(results, true);
      assert(formatted.includes("Total size: 1000000 bytes"));
    });

    it("should handle results with missing metadata", () => {
      const results = [
        { path: "file1.dcm", timestamp: "2024-01-12T15:40:00Z", version: 0, info: { input: { size: 1000000 } } },
        { path: "file2.dcm", timestamp: "2024-01-12T15:40:01Z", version: 0, info: { input: { size: 1000000 } } }
      ];
      
      // Should not throw
      const formatted = processCommand.formatResultOverview(results, true);
      assert(formatted.includes("Total files processed: 2"));
      assert(formatted.includes("Total size: 2000000 bytes"));
    });
  });

  describe("pollBigQueryForResult", () => {
    let bigQueryStub;

    beforeEach(() => {
      // Mock BigQuery client
      const { BigQuery } = require("@google-cloud/bigquery");
      bigQueryStub = sinon.stub(BigQuery.prototype, "query");
    });

    afterEach(() => {
      bigQueryStub.restore();
    });

    it("should return result for single file when found immediately", async function() {
      bigQueryStub.resolves([
        [{ path: "gs://bucket/file.dcm", timestamp: "2024-01-12T15:40:00Z" }]
      ]);

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 100,
        maxPollTime: 1000,
        isArchive: false
      });

      assert.ok(result);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].path, "gs://bucket/file.dcm");
    });

    it("should use exact path query for single files", async function() {
      bigQueryStub.resolves([[{ path: "gs://bucket/file.dcm" }]]);

      await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        objectVersion: "12345",
        pollInterval: 100,
        maxPollTime: 1000,
        isArchive: false
      });

      const callArgs = bigQueryStub.getCall(0).args[0];
      assert(callArgs.query.includes("WHERE path = @path"));
      assert(callArgs.query.includes("AND version = @version"));
      assert.strictEqual(callArgs.params.path, "gs://bucket/file.dcm");
      assert.strictEqual(callArgs.params.version, "12345");
    });

    it("should use timestamp-based query for archives", async function() {
      const uploadTime = Date.now();
      bigQueryStub.resolves([[{ path: "gs://bucket/archive.zip/file.dcm" }]]);

      await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/archive.zip",
        objectVersion: "67890",
        pollInterval: 100,
        maxPollTime: 1000,
        isArchive: true,
        uploadTime
      });

      const callArgs = bigQueryStub.getCall(0).args[0];
      assert(callArgs.query.includes("WHERE path LIKE @pathPattern"));
      assert(callArgs.query.includes("AND version = @version"));
      assert(callArgs.query.includes("AND metadata IS NOT NULL"));
      assert.ok(callArgs.params.pathPattern);
      assert.strictEqual(callArgs.params.pathPattern, "%bucket/archive.zip#%");
      assert.strictEqual(callArgs.params.version, "67890");
    });

    it("should return null when no results found and timeout occurs", async function() {
      bigQueryStub.resolves([[]]);

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 100,
        maxPollTime: 200,
        isArchive: false
      });

      assert.strictEqual(result, null);
    });

    it("should continue polling until timeout for archives", async function() {
      let callCount = 0;
      bigQueryStub.callsFake(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([[]]); // No results on first call
        }
        return Promise.resolve([[
          { path: "gs://bucket/archive.zip/file1.dcm" },
          { path: "gs://bucket/archive.zip/file2.dcm" }
        ]]);
      });

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/archive.zip",
        pollInterval: 100,
        maxPollTime: 500,
        isArchive: true,
        uploadTime: Date.now()
      });

      assert.ok(result);
      assert.strictEqual(result.length, 2);
      assert(callCount >= 2);
    });

    it("should handle BigQuery query errors gracefully", async function() {
      bigQueryStub.callsFake(() => {
        return Promise.reject(new Error("Query failed"));
      });

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 100,
        maxPollTime: 200,
        isArchive: false
      });

      // Should return null after timeout, not throw
      assert.strictEqual(result, null);
    });

    it("should limit single file results to 1", async function() {
      bigQueryStub.resolves([
        [
          { path: "gs://bucket/file.dcm" },
          { path: "gs://bucket/file.dcm" }
        ]
      ]);

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 100,
        maxPollTime: 1000,
        isArchive: false
      });

      assert.strictEqual(result.length, 1);
    });

    it("should collect multiple results for archives with 5 second wait", async function() {
      this.timeout(15000);
      
      let callCount = 0;
      bigQueryStub.callsFake(() => {
        callCount++;
        return Promise.resolve([[
          { path: "gs://bucket/archive.zip/file1.dcm" },
          { path: "gs://bucket/archive.zip/file2.dcm" },
          { path: "gs://bucket/archive.zip/file3.dcm" }
        ]]);
      });

      const result = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/archive.zip",
        pollInterval: 100,
        maxPollTime: 10000,
        isArchive: true,
        uploadTime: Date.now()
      });

      assert.ok(result);
      assert.strictEqual(result.length, 3);
    });
  });
});
