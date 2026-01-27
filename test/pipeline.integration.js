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

/*
 Integration test: End-to-end pipeline testing with real GCP services
 
 Prerequisites:
 - Run ./helpers/deploy.sh to create GCP resources and test/testconfig.json
 - Authenticate with GCP: gcloud auth application-default login
 
 Run with: DCM2BQ_CONFIG_FILE=test/testconfig.json mocha test/pipeline.integration.js
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const { BigQuery } = require("@google-cloud/bigquery");
const crypto = require("crypto");
const config = require("../src/config");
const { handleEvent } = require("../src/eventhandlers");
const consts = require("../src/consts");
const { DicomInMemory } = require("../src/dicomtojson");

describe("End-to-End Pipeline Integration Tests", function () {
  this.timeout(60000); // Allow time for API calls and processing

  let storage;
  let bigquery;
  let gcpConfig;
  let testBucket;
  let testDataset;
  let testTable;
  let uploadedFiles = [];

  before(async function () {
    const conf = config.get();
    gcpConfig = conf.gcpConfig;
    
    // Verify we have a real config (not test config)
    if (gcpConfig.projectId === "test-project-12345") {
      this.skip(); // Skip if running with mock config
    }

    storage = new Storage({ projectId: gcpConfig.projectId });
    bigquery = new BigQuery({ projectId: gcpConfig.projectId });

    // Extract bucket name from gcsBucketPath if configured
    if (gcpConfig.embedding?.input?.gcsBucketPath) {
      const match = gcpConfig.embedding.input.gcsBucketPath.match(/^gs:\/\/([^\/]+)/);
      if (match) {
        testBucket = storage.bucket(match[1]);
      }
    }

    testDataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
    testTable = testDataset.table(gcpConfig.bigQuery.instancesTableId);

    // Verify resources exist
    const [datasetExists] = await testDataset.exists();
    const [tableExists] = await testTable.exists();
    
    assert.ok(datasetExists, `Dataset ${gcpConfig.bigQuery.datasetId} should exist`);
    assert.ok(tableExists, `Table ${gcpConfig.bigQuery.instancesTableId} should exist`);
  });

  after(async function () {
    // Clean up uploaded test files
    if (testBucket && uploadedFiles.length > 0) {
      console.log(`\nCleaning up ${uploadedFiles.length} test files...`);
      for (const fileName of uploadedFiles) {
        try {
          await testBucket.file(fileName).delete();
          console.log(`  Deleted: ${fileName}`);
        } catch (err) {
          console.error(`  Failed to delete ${fileName}:`, err.message);
        }
      }
    }
  });

  describe("GCS Upload and Processing", function () {
    it("should upload a DICOM file to GCS", async function () {
      if (!testBucket) {
        this.skip();
      }

      const testFile = path.join(__dirname, "files/dcm/ct.dcm");
      const buffer = fs.readFileSync(testFile);
      const fileName = `test-upload-${Date.now()}-ct.dcm`;
      
      const file = testBucket.file(fileName);
      await file.save(buffer, {
        metadata: {
          contentType: "application/dicom",
        },
      });

      uploadedFiles.push(fileName);

      // Verify file exists
      const [exists] = await file.exists();
      assert.ok(exists, "File should exist in GCS after upload");

      // Verify we can download it
      const [downloadedBuffer] = await file.download();
      assert.strictEqual(downloadedBuffer.length, buffer.length, "Downloaded file should match uploaded file");
    });

    it("should process uploaded DICOM file through event handler", async function () {
      if (!testBucket) {
        this.skip();
      }

      const testFile = path.join(__dirname, "files/dcm/dx.dcm");
      const buffer = fs.readFileSync(testFile);
      const fileName = `test-process-${Date.now()}-dx.dcm`;
      
      const file = testBucket.file(fileName);
      await file.save(buffer, {
        metadata: {
          contentType: "application/dicom",
        },
      });

      uploadedFiles.push(fileName);

      // Create a mock GCS Pub/Sub event
      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: testBucket.name,
            objectId: fileName,
          },
          data: Buffer.from(JSON.stringify({
            bucket: testBucket.name,
            name: fileName,
            generation: "123456",
          })).toString("base64"),
        },
      };

      const perfCtx = {
        addRef: () => {},
      };

      // Process the event
      await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Wait a moment for async operations
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Query BigQuery to verify the row was inserted
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });
      const sopInstanceUID = metadata.SOPInstanceUID;

      const query = `
        SELECT id, path, metadata, embeddingVector
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE JSON_VALUE(metadata, '$.SOPInstanceUID') = @sopInstanceUID
        ORDER BY timestamp DESC
        LIMIT 1
      `;

      const options = {
        query: query,
        params: { sopInstanceUID: sopInstanceUID },
      };

      const [rows] = await bigquery.query(options);
      assert.ok(rows.length > 0, "Should find inserted row in BigQuery");
      
      const row = rows[0];
      assert.ok(row.id, "Row should have an id");
      assert.ok(row.path, "Row should have a path");
      assert.ok(row.metadata, "Row should have metadata");

      // Check if embeddings are configured and verify embedding vector
      if (gcpConfig.embedding?.input?.vector?.model) {
        assert.ok(row.embeddingVector, "Row should have embedding vector when configured");
        assert.ok(Array.isArray(row.embeddingVector), "Embedding vector should be an array");
        assert.strictEqual(row.embeddingVector.length, 1408, "Embedding vector should have 1408 dimensions");
      }

      console.log(`  ✓ Found row in BigQuery with id: ${row.id}`);
    });
  });

  describe("BigQuery Schema Validation", function () {
    it("should have correct table schema", async function () {
      const [metadata] = await testTable.getMetadata();
      const schema = metadata.schema;

      assert.ok(schema, "Table should have a schema");
      assert.ok(schema.fields, "Schema should have fields");

      // Verify key fields exist
      const fieldNames = schema.fields.map(f => f.name);
      const requiredFields = ["id", "timestamp", "path", "version", "info", "metadata"];
      
      for (const field of requiredFields) {
        assert.ok(fieldNames.includes(field), `Schema should include field: ${field}`);
      }

      // Verify info is a RECORD type with nested fields
      const infoField = schema.fields.find(f => f.name === "info");
      assert.ok(infoField, "Should have info field");
      assert.strictEqual(infoField.type, "RECORD", "info should be a RECORD type");
      assert.ok(infoField.fields, "info should have nested fields");

      const infoFieldNames = infoField.fields.map(f => f.name);
      assert.ok(infoFieldNames.includes("event"), "info should have event field");
      assert.ok(infoFieldNames.includes("input"), "info should have input field");

      console.log(`  ✓ Table schema validated with ${schema.fields.length} top-level fields`);
    });

    it("should query recent entries from BigQuery", async function () {
      const query = `
        SELECT id, timestamp, path, JSON_VALUE(metadata, '$.Modality') as modality
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        ORDER BY timestamp DESC
        LIMIT 5
      `;

      const [rows] = await bigquery.query(query);
      
      if (rows.length > 0) {
        console.log(`  ✓ Found ${rows.length} recent entries in BigQuery`);
        rows.forEach((row, idx) => {
          console.log(`    ${idx + 1}. ${row.modality || 'Unknown'} - ${row.path}`);
        });
      } else {
        console.log("  ⚠ No entries found in BigQuery (table may be empty)");
      }
    });
  });

  describe("Multiple File Processing", function () {
    it("should process multiple DICOM files with different modalities", async function () {
      if (!testBucket) {
        this.skip();
      }

      const testFiles = [
        { file: "ct.dcm", modality: "CT" },
        { file: "mr.dcm", modality: "MR" },
        { file: "us.dcm", modality: "US" },
      ];

      const timestamp = Date.now();
      const processedIds = [];

      for (const { file: filename, modality } of testFiles) {
        const testFile = path.join(__dirname, "files/dcm", filename);
        const buffer = fs.readFileSync(testFile);
        const gcsFileName = `test-multi-${timestamp}-${filename}`;
        
        const file = testBucket.file(gcsFileName);
        await file.save(buffer, {
          metadata: {
            contentType: "application/dicom",
          },
        });

        uploadedFiles.push(gcsFileName);

        // Create event and process
        const ctx = {
          message: {
            attributes: {
              eventType: "OBJECT_FINALIZE",
              bucketId: testBucket.name,
              objectId: gcsFileName,
            },
            data: Buffer.from(JSON.stringify({
              bucket: testBucket.name,
              name: gcsFileName,
              generation: Date.now().toString(),
            })).toString("base64"),
          },
        };

        const perfCtx = { addRef: () => {} };
        await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

        console.log(`  ✓ Processed ${modality} file: ${gcsFileName}`);
      }

      // Wait for processing to complete
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify all files were processed
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE path LIKE @pattern
      `;

      const [rows] = await bigquery.query({
        query: query,
        params: { pattern: `%test-multi-${timestamp}%` },
      });

      assert.ok(rows[0].count >= testFiles.length, 
        `Should have processed at least ${testFiles.length} files, found ${rows[0].count}`);
    });

    it("should process zip files containing DICOM files", async function () {
      if (!testBucket) {
        this.skip();
      }

      const zipPath = path.join(__dirname, "files/zip/study.zip");
      const zipBuffer = fs.readFileSync(zipPath);
      
      const timestamp = Date.now();
      const zipFileName = `test-zip-${timestamp}.zip`;

      // Upload zip file to GCS
      await testBucket.upload(zipPath, {
        destination: zipFileName,
        metadata: {
          contentType: "application/zip",
        },
      });

      uploadedFiles.push(zipFileName);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: testBucket.name,
            objectId: zipFileName,
          },
          data: Buffer.from(JSON.stringify({
            bucket: testBucket.name,
            name: zipFileName,
            generation: Date.now().toString(),
          })).toString("base64"),
        },
      };

      const perfCtx = { addRef: () => {} };

      // Process the zip file
      await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Query BigQuery to verify DICOM files from zip were processed
      // Zip files are stored with format: gs://bucket/zipfile.zip#filename.dcm
      const query = `
        SELECT path, metadata
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE path LIKE @pattern
        ORDER BY timestamp DESC
      `;

      const [rows] = await bigquery.query({
        query: query,
        params: { pattern: `%${zipFileName}#%` },
      });

      // The zip contains 12 DICOM files (excluding notdicom.txt)
      // Verify at least some were processed
      assert.ok(rows.length > 0, "Should have processed DICOM files from zip");
      
      // Verify path format includes the # separator for zip contents
      rows.forEach(row => {
        assert.ok(row.path.includes("#"), `Path should include # separator for zip contents: ${row.path}`);
        assert.ok(row.path.includes(zipFileName), `Path should include zip file name: ${row.path}`);
      });

      console.log(`  ✓ Processed ${rows.length} DICOM files from zip archive`);
    });

    it("should process tar.gz and tgz files containing DICOM files", async function () {
      if (!testBucket) {
        this.skip();
      }

      const tarPath = path.join(__dirname, "files/tar/study.tar.gz");
      const timestamp = Date.now();
      const tarFileName = `test-tar-${timestamp}.tgz`;

      // Upload tar.gz file to GCS with tgz extension
      await testBucket.upload(tarPath, {
        destination: tarFileName,
        metadata: {
          contentType: "application/gzip",
        },
      });

      uploadedFiles.push(tarFileName);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: testBucket.name,
            objectId: tarFileName,
          },
          data: Buffer.from(JSON.stringify({
            bucket: testBucket.name,
            name: tarFileName,
            generation: Date.now().toString(),
          })).toString("base64"),
        },
      };

      const perfCtx = { addRef: () => {} };

      // Process the archive file
      await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Query BigQuery to verify DICOM files from archive were processed
      const query = `
        SELECT path
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE path LIKE @pattern
        ORDER BY timestamp DESC
      `;

      const [rows] = await bigquery.query({
        query: query,
        params: { pattern: `%${tarFileName}#%` },
      });

      assert.ok(rows.length > 0, "Should have processed DICOM files from tar.gz/tgz archive");
      rows.forEach(row => {
        assert.ok(row.path.includes("#"), `Path should include # separator for archive contents: ${row.path}`);
        assert.ok(row.path.includes(tarFileName), `Path should include archive file name: ${row.path}`);
      });

      console.log(`  ✓ Processed ${rows.length} DICOM files from tar.gz/tgz archive`);
    });
  });

  describe("Error Handling", function () {
    it("should handle non-DICOM files gracefully", async function () {
      if (!testBucket) {
        this.skip();
      }

      const fileName = `test-invalid-${Date.now()}.txt`;
      const file = testBucket.file(fileName);
      await file.save("This is not a DICOM file", {
        metadata: {
          contentType: "text/plain",
        },
      });

      uploadedFiles.push(fileName);

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_FINALIZE",
            bucketId: testBucket.name,
            objectId: fileName,
          },
          data: Buffer.from(JSON.stringify({
            bucket: testBucket.name,
            name: fileName,
            generation: "123456",
          })).toString("base64"),
        },
      };

      const perfCtx = { addRef: () => {} };

      // Should throw non-retryable error but with 422 status (graceful error handling)
      try {
        await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });
        assert.fail("Expected error for non-DICOM file");
      } catch (error) {
        // Expected: non-DICOM files should result in a non-retryable error
        assert.strictEqual(error.code, 422, "Should return 422 Unprocessable Entity for non-DICOM files");
        assert(error.message.includes("Failed to parse DICOM file"), "Should include parsing error message");
      }

      console.log("  ✓ Non-DICOM file handled with appropriate error code");
    });

    it("should handle OBJECT_DELETE events", async function () {
      if (!testBucket) {
        this.skip();
      }

      const fileName = `test-delete-${Date.now()}.dcm`;

      const ctx = {
        message: {
          attributes: {
            eventType: "OBJECT_DELETE",
            bucketId: testBucket.name,
            objectId: fileName,
          },
          data: Buffer.from(JSON.stringify({
            bucket: testBucket.name,
            name: fileName,
            generation: "123456",
          })).toString("base64"),
        },
      };

      const perfCtx = { addRef: () => {} };

      // Should process delete event and insert row with null metadata
      await handleEvent(consts.GCS_PUBSUB_UNWRAP, { body: ctx }, { perfCtx });

      await new Promise(resolve => setTimeout(resolve, 1000));

      // Query for the delete event
      const query = `
        SELECT id, path, metadata, info.event as event
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE path = @path
        ORDER BY timestamp DESC
        LIMIT 1
      `;

      const [rows] = await bigquery.query({
        query: query,
        params: { path: `gs://${testBucket.name}/${fileName}` },
      });

      if (rows.length > 0) {
        assert.strictEqual(rows[0].event, "OBJECT_DELETE", "Event should be OBJECT_DELETE");
        assert.strictEqual(rows[0].metadata, null, "Metadata should be null for delete events");
        console.log("  ✓ Delete event processed and inserted to BigQuery");
      }
    });
  });
});
