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
 Integration test: Configuration and validation tests
 
 Prerequisites:
 - Run ./helpers/deploy.sh to create GCP resources and test/testconfig.json
 
 Run with: DCM2BQ_CONFIG_FILE=test/testconfig.json mocha test/config-validation.integration.js
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { BigQuery } = require("@google-cloud/bigquery");
const { Storage } = require("@google-cloud/storage");
const config = require("../src/config");
const { getSchema } = require("../src/schemas");
const consts = require("../src/consts");

describe("Configuration and Validation Integration Tests", function () {
  this.timeout(30000);

  let gcpConfig;
  let bigquery;
  let storage;

  before(function () {
    const conf = config.get();
    gcpConfig = conf.gcpConfig;
    
    // Verify we have a real config (not test config)
    if (gcpConfig.projectId === "test-project-12345") {
      this.skip(); // Skip if running with mock config
    }

    bigquery = new BigQuery({ projectId: gcpConfig.projectId });
    storage = new Storage({ projectId: gcpConfig.projectId });
  });

  describe("Configuration Validation", function () {
    it("should load configuration from test/testconfig.json", function () {
      assert.ok(gcpConfig, "Should have GCP config");
      assert.ok(gcpConfig.projectId, "Should have project ID");
      assert.ok(gcpConfig.location, "Should have location");
      assert.ok(gcpConfig.bigQuery, "Should have BigQuery config");
      assert.ok(gcpConfig.bigQuery.datasetId, "Should have dataset ID");
      assert.ok(gcpConfig.bigQuery.instancesTableId, "Should have table ID");

      console.log(`  ✓ Project: ${gcpConfig.projectId}`);
      console.log(`  ✓ Location: ${gcpConfig.location}`);
      console.log(`  ✓ Dataset: ${gcpConfig.bigQuery.datasetId}`);
      console.log(`  ✓ Table: ${gcpConfig.bigQuery.instancesTableId}`);
    });

    it("should have valid embedding configuration", function () {
      if (!gcpConfig.embedding) {
        this.skip();
      }

      assert.ok(gcpConfig.embedding.input, "Should have embedding.input config");
      
      if (gcpConfig.embedding.input.vector) {
        assert.ok(gcpConfig.embedding.input.vector.model, "Should have vector model");
        console.log(`  ✓ Embedding model: ${gcpConfig.embedding.input.vector.model}`);
      }

      if (gcpConfig.embedding.input.gcsBucketPath) {
        assert.ok(gcpConfig.embedding.input.gcsBucketPath.startsWith("gs://"), 
          "GCS bucket path should start with gs://");
        console.log(`  ✓ GCS bucket: ${gcpConfig.embedding.input.gcsBucketPath}`);
      }

      if (gcpConfig.embedding.input.summarizeText) {
        assert.ok(gcpConfig.embedding.input.summarizeText.model, "Should have summarization model");
        console.log(`  ✓ Summarization model: ${gcpConfig.embedding.input.summarizeText.model}`);
      }
    });

    it("should have valid JSON output configuration", function () {
      const conf = config.get();
      assert.ok(conf.jsonOutput, "Should have jsonOutput config");
      assert.strictEqual(typeof conf.jsonOutput.useCommonNames, "boolean", 
        "useCommonNames should be boolean");
      assert.strictEqual(typeof conf.jsonOutput.ignorePrivate, "boolean", 
        "ignorePrivate should be boolean");

      console.log(`  ✓ JSON output configured with ${Object.keys(conf.jsonOutput).length} options`);
    });
  });

  describe("GCP Resource Validation", function () {
    it("should verify BigQuery dataset exists", async function () {
      const dataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
      const [exists] = await dataset.exists();
      
      assert.ok(exists, `Dataset ${gcpConfig.bigQuery.datasetId} should exist`);
      
      const [metadata] = await dataset.getMetadata();
      console.log(`  ✓ Dataset exists: ${metadata.id}`);
      console.log(`  ✓ Location: ${metadata.location}`);
    });

    it("should verify BigQuery table exists and has correct schema", async function () {
      const dataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
      const table = dataset.table(gcpConfig.bigQuery.instancesTableId);
      
      const [exists] = await table.exists();
      assert.ok(exists, `Table ${gcpConfig.bigQuery.instancesTableId} should exist`);
      
      const [metadata] = await table.getMetadata();
      assert.ok(metadata.schema, "Table should have a schema");
      assert.ok(metadata.schema.fields, "Schema should have fields");
      
      console.log(`  ✓ Table exists: ${metadata.id}`);
      console.log(`  ✓ Schema has ${metadata.schema.fields.length} fields`);
      console.log(`  ✓ Row count: ${metadata.numRows || 0}`);
    });

    it("should verify GCS bucket exists (if configured)", async function () {
      if (!gcpConfig.embedding?.input?.gcsBucketPath) {
        this.skip();
      }

      const match = gcpConfig.embedding.input.gcsBucketPath.match(/^gs:\/\/([^\/]+)/);
      assert.ok(match, "Should be able to parse bucket name from path");
      
      const bucketName = match[1];
      const bucket = storage.bucket(bucketName);
      
      const [exists] = await bucket.exists();
      assert.ok(exists, `Bucket ${bucketName} should exist`);
      
      const [metadata] = await bucket.getMetadata();
      console.log(`  ✓ Bucket exists: ${metadata.id}`);
      console.log(`  ✓ Location: ${metadata.location}`);
      console.log(`  ✓ Storage class: ${metadata.storageClass}`);
    });
  });

  describe("Schema Validation", function () {
    it("should have valid event handler schemas", function () {
      const eventHandlers = consts.EVENT_HANDLER_NAMES;
      assert.ok(Array.isArray(eventHandlers), "Event handlers should be an array");
      assert.ok(eventHandlers.length > 0, "Should have at least one event handler");

      for (const handlerName of eventHandlers) {
        const schema = getSchema(handlerName);
        assert.ok(schema, `Should have schema for ${handlerName}`);
        assert.strictEqual(typeof schema, "function", "Schema should be a validation function");
        console.log(`  ✓ Schema loaded: ${handlerName}`);
      }
    });

    it("should have valid config schema", function () {
      const configSchema = getSchema(consts.CONFIG_SCHEMA);
      assert.ok(configSchema, "Should have config schema");
      assert.strictEqual(typeof configSchema, "function", "Config schema should be a validation function");

      // Validate current config against schema
      const conf = config.get();
      const isValid = configSchema(conf);
      
      if (!isValid) {
        console.error("Config validation errors:", configSchema.errors);
      }
      
      assert.ok(isValid, "Current config should pass schema validation");
      console.log(`  ✓ Config schema validated`);
    });
  });

  describe("Table Schema Compatibility", function () {
    it("should verify BigQuery table schema matches expected structure", async function () {
      const dataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
      const table = dataset.table(gcpConfig.bigQuery.instancesTableId);
      
      const [metadata] = await table.getMetadata();
      const schema = metadata.schema;

      // Required top-level fields
      const requiredFields = {
        id: "STRING",
        timestamp: "TIMESTAMP",
        path: "STRING",
        version: "STRING",
        info: "RECORD",
        metadata: "STRING"
      };

      for (const [fieldName, expectedType] of Object.entries(requiredFields)) {
        const field = schema.fields.find(f => f.name === fieldName);
        assert.ok(field, `Schema should have ${fieldName} field`);
        assert.strictEqual(field.type, expectedType, 
          `Field ${fieldName} should be type ${expectedType}`);
        console.log(`  ✓ Field verified: ${fieldName} (${expectedType})`);
      }

      // Verify info record structure
      const infoField = schema.fields.find(f => f.name === "info");
      assert.ok(infoField.fields, "info should have nested fields");
      
      const infoSubFields = infoField.fields.map(f => f.name);
      assert.ok(infoSubFields.includes("event"), "info should have event field");
      assert.ok(infoSubFields.includes("input"), "info should have input field");
      
      console.log(`  ✓ Info record has ${infoField.fields.length} nested fields`);
    });

    it("should verify embeddingVector field exists when embeddings are configured", async function () {
      if (!gcpConfig.embedding?.input?.vector?.model) {
        this.skip();
      }

      const dataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
      const table = dataset.table(gcpConfig.bigQuery.instancesTableId);
      
      const [metadata] = await table.getMetadata();
      const schema = metadata.schema;

      const embeddingField = schema.fields.find(f => f.name === "embeddingVector");
      assert.ok(embeddingField, "Schema should have embeddingVector field when embeddings are configured");
      assert.strictEqual(embeddingField.type, "FLOAT", "embeddingVector should be FLOAT type");
      assert.strictEqual(embeddingField.mode, "REPEATED", "embeddingVector should be REPEATED mode");
      
      console.log(`  ✓ Embedding vector field configured correctly`);
    });
  });

  describe("Permissions and Access", function () {
    it("should be able to query BigQuery", async function () {
      const query = `
        SELECT COUNT(*) as count
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
      `;

      const [rows] = await bigquery.query(query);
      assert.ok(rows, "Should get query results");
      assert.ok(rows.length > 0, "Should have at least one row in results");
      
      console.log(`  ✓ Successfully queried BigQuery (${rows[0].count} total rows)`);
    });

    it("should be able to list GCS buckets", async function () {
      const [buckets] = await storage.getBuckets();
      assert.ok(buckets, "Should get bucket list");
      assert.ok(Array.isArray(buckets), "Buckets should be an array");
      
      console.log(`  ✓ Successfully listed ${buckets.length} GCS buckets`);
    });

    it("should be able to write to BigQuery", async function () {
      const dataset = bigquery.dataset(gcpConfig.bigQuery.datasetId);
      const table = dataset.table(gcpConfig.bigQuery.instancesTableId);

      // Create a test row (we'll delete it later)
      const testRow = {
        id: `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        path: `gs://test-bucket/test-${Date.now()}.dcm`,
        version: "test",
        info: {
          event: "TEST",
          input: {
            type: "TEST",
            bucket: "test-bucket",
            object: "test.dcm"
          }
        },
        metadata: null
      };

      // Insert the test row
      await table.insert([testRow]);

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Verify it was inserted
      const query = `
        SELECT id
        FROM \`${gcpConfig.projectId}.${gcpConfig.bigQuery.datasetId}.${gcpConfig.bigQuery.instancesTableId}\`
        WHERE id = @id
        LIMIT 1
      `;

      const [rows] = await bigquery.query({
        query: query,
        params: { id: testRow.id }
      });

      assert.ok(rows.length > 0, "Should find the test row");
      assert.strictEqual(rows[0].id, testRow.id, "Row ID should match");

      console.log(`  ✓ Successfully inserted and verified test row`);

      // Note: BigQuery doesn't support DELETE, so the test row will remain
      // It will be identifiable by the "TEST" event type if cleanup is needed
    });
  });
});
