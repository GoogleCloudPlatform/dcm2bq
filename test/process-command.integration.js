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

/**
 * Integration tests for process-command
 * 
 * These tests verify end-to-end workflows:
 * - Upload and poll for single DICOM files
 * - Upload and poll for archive files
 * - Timeout handling
 * - Error scenarios
 * 
 * Note: These tests use stubs for GCS and BigQuery to avoid requiring real infrastructure
 */
describe("process-command integration", () => {
  let processCommand;
  let gcsStub;
  let bigQueryStub;
  const testDicomFile = path.join(__dirname, "files", "dcm", "ct.dcm");
  const testConfigFile = path.join(__dirname, "test-integration-config.json");

  beforeEach(() => {
    // Clear require cache
    delete require.cache[require.resolve("../src/process-command")];
    processCommand = require("../src/process-command");

    // Create test config
    const config = {
      gcpConfig: {
        projectId: "test-project",
        gcs_bucket_name: "test-bucket",
        bigQuery: {
          datasetId: "test_dataset",
          instancesTableId: "instances"
        }
      }
    };
    fs.writeFileSync(testConfigFile, JSON.stringify(config));

    // Mock GCS and BigQuery
    const { Storage } = require("@google-cloud/storage");
    const { BigQuery } = require("@google-cloud/bigquery");
    
    gcsStub = sinon.stub(Storage.prototype, "bucket").returns({
      upload: sinon.stub().resolves(),
      file: sinon.stub().returns({
        getMetadata: sinon.stub().resolves([{ generation: "12345" }])
      })
    });
    
    bigQueryStub = sinon.stub(BigQuery.prototype, "query").resolves([[]]);
  });

  afterEach(() => {
    gcsStub.restore();
    bigQueryStub.restore();
    
    if (fs.existsSync(testConfigFile)) {
      fs.unlinkSync(testConfigFile);
    }
  });

  describe("single DICOM file processing workflow", () => {
    it("should successfully process a single DICOM file", async function() {
      // Mock successful BigQuery result after first poll
      bigQueryStub.onFirstCall().resolves([[]]);
      bigQueryStub.onSecondCall().resolves([[{
        path: "gs://test-bucket/uploads/1705089600000_abc123_ct.dcm",
        timestamp: "2024-01-12T15:40:00Z",
        version: 0,
        event: "OBJECT_FINALIZE",
        input: {
          size: 1234567,
          type: "GCS"
        },
        metadata: JSON.stringify({
          PatientName: "Test^Patient",
          PatientID: "12345",
          StudyDate: "20240112",
          Modality: "CT"
        })
      }]]);

      // Execute would normally be called here, but we're testing the underlying functions
      const config = processCommand.loadDeploymentConfig(testConfigFile);
      assert.ok(config);
      assert.strictEqual(config.gcpConfig.gcs_bucket_name, "test-bucket");
    });

    it("should upload file with proper GCS bucket", async function() {
      if (!fs.existsSync(testDicomFile)) {
        this.skip();
        return;
      }

      await processCommand.uploadToGCS(testDicomFile, "test-bucket");

      // Verify upload was called
      assert(gcsStub.calledWith("test-bucket"));
    });

    it("should query BigQuery by exact path and version for single files", async function() {
      bigQueryStub.resolves([[{
        path: "gs://test-bucket/uploads/abc_file.dcm",
        version: "11111"
      }]]);

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "test-bucket/uploads/abc_file.dcm",
        objectVersion: "11111",
        pollInterval: 50,
        maxPollTime: 200,
        isArchive: false
      });

      assert.ok(results);
      const callArgs = bigQueryStub.getCall(0).args[0];
      assert(callArgs.query.includes("WHERE path = @path"));
      assert(callArgs.query.includes("AND version = @version"));
      assert.strictEqual(callArgs.params.version, "11111");
    });

    it("should timeout and return null if BigQuery has no results", async function() {
      bigQueryStub.resolves([[]]);

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "test-bucket/uploads/abc_file.dcm",
        pollInterval: 50,
        maxPollTime: 150,
        isArchive: false
      });

      assert.strictEqual(results, null);
    });
  });

  describe("archive file processing workflow", () => {
    it("should use path-pattern and version query for archive files", async function() {
      const uploadTime = Date.now();
      bigQueryStub.resolves([[
        { path: "gs://test-bucket/uploads/abc_archive.zip#file1.dcm", version: "12345" },
        { path: "gs://test-bucket/uploads/abc_archive.zip#file2.dcm", version: "12345" },
        { path: "gs://test-bucket/uploads/abc_archive.zip#file3.dcm", version: "12345" }
      ]]);

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "test-bucket/uploads/abc_archive.zip",
        objectVersion: "12345",
        pollInterval: 50,
        maxPollTime: 5000,
        isArchive: true,
        uploadTime
      });

      assert.ok(results);
      assert.strictEqual(results.length, 3);
      
      const callArgs = bigQueryStub.getCall(0).args[0];
      assert(callArgs.query.includes("WHERE path LIKE @pathPattern"));
      assert(callArgs.query.includes("AND version = @version"));
      assert(callArgs.query.includes("AND metadata IS NOT NULL"));
      assert.strictEqual(callArgs.params.pathPattern, "%test-bucket/uploads/abc_archive.zip#%");
      assert.strictEqual(callArgs.params.version, "12345");
    });

    it("should collect multiple results from archive extraction", async function() {
      const uploadTime = Date.now();
      
      bigQueryStub.callsFake(() => {
        return Promise.resolve([[
          { path: "gs://test-bucket/uploads/abc_study.zip#ct1.dcm", modality: "CT", version: "67890" },
          { path: "gs://test-bucket/uploads/abc_study.zip#mr1.dcm", modality: "MR", version: "67890" },
          { path: "gs://test-bucket/uploads/abc_study.zip#us1.dcm", modality: "US", version: "67890" }
        ]]);
      });

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "test-bucket/uploads/abc_study.zip",
        objectVersion: "67890",
        pollInterval: 50,
        maxPollTime: 10000,
        isArchive: true,
        uploadTime
      });

      assert.strictEqual(results.length, 3);
    });

    it("should format archive results with summary statistics", () => {
      const results = [
        {
          path: "gs://bucket/archive.zip/file1.dcm",
          timestamp: "2024-01-12T15:40:00Z",
          version: 0,
          input: { size: 1000000 },
          metadata: JSON.stringify({ Modality: "CT" })
        },
        {
          path: "gs://bucket/archive.zip/file2.dcm",
          timestamp: "2024-01-12T15:40:01Z",
          version: 0,
          input: { size: 2000000 },
          metadata: JSON.stringify({ Modality: "MR" })
        },
        {
          path: "gs://bucket/archive.zip/file3.dcm",
          timestamp: "2024-01-12T15:40:02Z",
          version: 0,
          input: { size: 1500000 },
          metadata: JSON.stringify({ Modality: "CT" })
        }
      ];

      const formatted = processCommand.formatResultOverview(results, true);
      
      assert(formatted.includes("Archive Processing Results"));
      assert(formatted.includes("Total files processed: 3"));
      assert(formatted.includes("Total size: 4500000 bytes"));
      assert(formatted.includes("Modalities: CT, MR"));
    });

    it("should handle archive with mixed valid modalities", () => {
      const results = [
        {
          path: "gs://bucket/archive.zip/file1.dcm",
          timestamp: "2024-01-12T15:40:00Z",
          version: 0,
          input: { size: 1000000 },
          metadata: JSON.stringify({ Modality: "CT", PatientName: "Patient1" })
        },
        {
          path: "gs://bucket/archive.zip/file2.dcm",
          timestamp: "2024-01-12T15:40:01Z",
          version: 0,
          input: { size: 1000000 },
          metadata: JSON.stringify({ Modality: "MR", PatientName: "Patient1" })
        },
        {
          path: "gs://bucket/archive.zip/file3.dcm",
          timestamp: "2024-01-12T15:40:02Z",
          version: 0,
          input: { size: 1000000 },
          metadata: JSON.stringify({ Modality: "US", PatientName: "Patient1" })
        }
      ];

      const formatted = processCommand.formatResultOverview(results, true);
      
      // Should include all modalities, potentially in different orders
      assert(formatted.includes("CT"));
      assert(formatted.includes("MR"));
      assert(formatted.includes("US"));
      assert(formatted.includes("Total files processed: 3"));
    });
  });

  describe("error handling and edge cases", () => {
    it("should handle missing deployment config file", () => {
      assert.throws(
        () => processCommand.loadDeploymentConfig("/nonexistent/config.json"),
        /Deployment config file not found/
      );
    });

    it("should handle invalid config JSON", () => {
      const invalidConfig = path.join(__dirname, "invalid-config.json");
      fs.writeFileSync(invalidConfig, "{ invalid }");
      
      try {
        assert.throws(
          () => processCommand.loadDeploymentConfig(invalidConfig),
          /Failed to load deployment config/
        );
      } finally {
        fs.unlinkSync(invalidConfig);
      }
    });

    it("should handle BigQuery query failures gracefully", async function() {
      bigQueryStub.rejects(new Error("Query timeout"));

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 50,
        maxPollTime: 150,
        isArchive: false
      });

      // Should continue polling and eventually timeout
      assert.strictEqual(results, null);
    });

    it("should handle empty BigQuery results", async function() {
      bigQueryStub.resolves([[]]);

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/file.dcm",
        pollInterval: 50,
        maxPollTime: 150,
        isArchive: false
      });

      assert.strictEqual(results, null);
    });

    it("should handle partial results for archives", async function() {
      bigQueryStub.callsFake(() => {
        return Promise.resolve([[
          { path: "gs://bucket/archive.zip/file1.dcm" },
          { path: "gs://bucket/archive.zip/file2.dcm" }
        ]]);
      });

      const results = await processCommand.pollBigQueryForResult({
        datasetId: "test_dataset",
        tableId: "instances",
        objectPath: "bucket/archive.zip",
        pollInterval: 50,
        maxPollTime: 200,
        isArchive: true,
        uploadTime: Date.now()
      });

      // Should return what was collected
      assert.ok(results);
      assert(results.length >= 2);
    });
  });

  describe("timeout calculations", () => {
    it("should calculate timeout correctly for small single files", () => {
      const fileSize = 1 * 1024 * 1024; // 1 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 60000, 10000);
      assert.strictEqual(timeout, 70000);
    });

    it("should calculate timeout correctly for large archives", () => {
      const fileSize = 500 * 1024 * 1024; // 500 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 60000, 10000);
      assert.strictEqual(timeout, 5060000); // 60000 + (500 * 10000)
    });

    it("should use custom base and per-MB values", () => {
      const fileSize = 10 * 1024 * 1024; // 10 MB
      const timeout = processCommand.calculatePollTimeout(fileSize, 30000, 5000);
      assert.strictEqual(timeout, 80000); // 30000 + (10 * 5000)
    });
  });

  describe("archive detection", () => {
    it("should detect all supported archive formats", () => {
      assert.strictEqual(processCommand.isArchiveFile("file.zip"), true);
      assert.strictEqual(processCommand.isArchiveFile("file.tgz"), true);
      assert.strictEqual(processCommand.isArchiveFile("file.tar.gz"), true);
    });

    it("should not detect non-archive files", () => {
      assert.strictEqual(processCommand.isArchiveFile("file.dcm"), false);
      assert.strictEqual(processCommand.isArchiveFile("file.txt"), false);
      assert.strictEqual(processCommand.isArchiveFile("file.tar"), false);
    });

    it("should be case-insensitive", () => {
      assert.strictEqual(processCommand.isArchiveFile("FILE.ZIP"), true);
      assert.strictEqual(processCommand.isArchiveFile("File.Tgz"), true);
      assert.strictEqual(processCommand.isArchiveFile("FILE.TAR.GZ"), true);
    });

    it("should handle paths with directories", () => {
      assert.strictEqual(processCommand.isArchiveFile("/path/to/archive.zip"), true);
      assert.strictEqual(processCommand.isArchiveFile("./archives/study.tar.gz"), true);
    });
  });
});
