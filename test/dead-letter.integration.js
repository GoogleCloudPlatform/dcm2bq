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
const { PubSub } = require("@google-cloud/pubsub");
const { BigQuery } = require("@google-cloud/bigquery");
const { Storage } = require("@google-cloud/storage");
const fs = require("fs");
const path = require("path");

/**
 * Integration test for dead letter queue functionality
 * 
 * This test verifies that:
 * 1. Messages that fail processing are sent to the dead letter topic
 * 2. Dead letter messages are written to BigQuery
 * 3. The dead letter table contains the expected fields
 * 
 * Prerequisites:
 * - Valid GCP credentials with appropriate permissions
 * - Deployed infrastructure with dead letter configuration
 * - Environment variables set (see test-config.js)
 */
describe("dead-letter integration", function() {
  this.timeout(120000); // 2 minutes for full pipeline

  let projectId;
  let pubsub;
  let bigquery;
  let storage;
  let config;
  let topicName;
  let deadLetterTopicName;
  let deadLetterTableId;
  let bucketName;

  before(function() {
    // Skip if not in integration test mode
    if (!process.env.INTEGRATION_TEST) {
      this.skip();
      return;
    }

    // Load test configuration
    try {
      config = require("./test-config");
    } catch (err) {
      console.error("Failed to load test-config.js:", err);
      this.skip();
      return;
    }

    projectId = config.projectId || process.env.GCP_PROJECT_ID;
    topicName = config.topicName || "dcm2bq-gcs-events";
    deadLetterTopicName = config.deadLetterTopicName || "dcm2bq-dead-letter-events";
    deadLetterTableId = config.deadLetterTableId || `${config.datasetId}.dead_letter`;
    bucketName = config.bucketName;

    if (!projectId || !bucketName) {
      console.error("Missing required configuration: projectId, bucketName");
      this.skip();
      return;
    }

    pubsub = new PubSub({ projectId });
    bigquery = new BigQuery({ projectId });
    storage = new Storage({ projectId });
  });

  describe("dead letter queue", () => {
    let testFileName;
    let messageId;

    after(async function() {
      // Clean up test file
      if (testFileName && bucketName) {
        try {
          await storage.bucket(bucketName).file(testFileName).delete();
          console.log(`Cleaned up test file: ${testFileName}`);
        } catch (err) {
          console.warn(`Failed to clean up test file: ${err.message}`);
        }
      }
    });

    it("should send failed messages to dead letter topic and write to BigQuery", async function() {
      // Create a test file that will cause processing to fail repeatedly
      // We'll upload a corrupted "DICOM" file that fails validation
      testFileName = `test-dead-letter-${Date.now()}.dcm`;
      const corruptedContent = Buffer.from("NOT A VALID DICOM FILE - THIS SHOULD FAIL");
      
      // Upload the corrupted file to trigger processing
      await storage.bucket(bucketName).file(testFileName).save(corruptedContent, {
        metadata: {
          contentType: "application/dicom",
          metadata: {
            testType: "dead-letter-integration"
          }
        }
      });

      console.log(`Uploaded corrupted file: ${testFileName}`);

      // Wait for the message to be processed and fail multiple times
      // With max_delivery_attempts = 5 and retry backoff, this could take ~2 minutes
      await new Promise(resolve => setTimeout(resolve, 90000)); // 90 seconds

      // Query BigQuery dead letter table for our message
      const query = `
        SELECT 
          message_id,
          subscription_name,
          publish_time,
          LENGTH(data) as data_length,
          attributes
        FROM \`${deadLetterTableId}\`
        WHERE attributes LIKE '%${testFileName}%'
        ORDER BY publish_time DESC
        LIMIT 1
      `;

      const [rows] = await bigquery.query({ query });

      // Verify that the message was written to the dead letter table
      assert.ok(rows.length > 0, "Dead letter message should be written to BigQuery");
      
      const row = rows[0];
      assert.ok(row.message_id, "Dead letter record should have message_id");
      assert.ok(row.subscription_name, "Dead letter record should have subscription_name");
      assert.ok(row.subscription_name.includes("dcm2bq"), "Subscription name should be dcm2bq related");
      assert.ok(row.publish_time, "Dead letter record should have publish_time");
      assert.ok(row.data_length > 0, "Dead letter record should have message data");
      assert.ok(row.attributes, "Dead letter record should have attributes");
      assert.ok(row.attributes.includes(testFileName), "Attributes should contain the test file name");

      messageId = row.message_id;
      console.log(`Dead letter message ${messageId} successfully written to BigQuery`);
    });

    it("should have correct schema in dead letter table", async function() {
      // Verify the dead letter table schema
      const [metadata] = await bigquery.dataset(config.datasetId).table("dead_letter").getMetadata();
      
      const schemaFields = metadata.schema.fields.map(f => f.name);
      
      assert.ok(schemaFields.includes("data"), "Schema should include 'data' field");
      assert.ok(schemaFields.includes("attributes"), "Schema should include 'attributes' field");
      assert.ok(schemaFields.includes("message_id"), "Schema should include 'message_id' field");
      assert.ok(schemaFields.includes("subscription_name"), "Schema should include 'subscription_name' field");
      assert.ok(schemaFields.includes("publish_time"), "Schema should include 'publish_time' field");
    });

    it("should have subscription on dead letter topic", async function() {
      // Verify that the dead letter topic has at least one subscription
      const [subscriptions] = await pubsub.topic(deadLetterTopicName).getSubscriptions();
      
      assert.ok(subscriptions.length > 0, "Dead letter topic should have at least one subscription");
      
      const hasDeadLetterSub = subscriptions.some(sub => 
        sub.name.includes("dead-letter") || sub.name.includes("deadletter")
      );
      
      assert.ok(hasDeadLetterSub, "Dead letter topic should have a dead-letter related subscription");
      
      console.log(`Dead letter topic has ${subscriptions.length} subscription(s)`);
    });

    it("should have correct IAM permissions on dead letter topic", async function() {
      // Verify that the Pub/Sub service account has publisher role on dead letter topic
      const topic = pubsub.topic(deadLetterTopicName);
      const [policy] = await topic.iam.getPolicy();
      
      const pubsubServiceAccount = `serviceAccount:service-${projectId.match(/\d+/)?.[0]}@gcp-sa-pubsub.iam.gserviceaccount.com`;
      const publisherBinding = policy.bindings.find(b => b.role === "roles/pubsub.publisher");
      
      assert.ok(publisherBinding, "Dead letter topic should have publisher role binding");
      assert.ok(
        publisherBinding.members.some(m => m.includes("gcp-sa-pubsub")),
        "Pub/Sub service account should have publisher role on dead letter topic"
      );
    });
  });

  describe("dead letter configuration validation", () => {
    it("should have dead letter policy configured on main subscription", async function() {
      // Find the main subscription (gcs-to-cloudrun)
      const [subscriptions] = await pubsub.getSubscriptions();
      const mainSub = subscriptions.find(sub => 
        sub.name.includes("gcs-to-cloudrun") || sub.name.includes("dcm2bq")
      );
      
      assert.ok(mainSub, "Main subscription should exist");
      
      const [metadata] = await mainSub.getMetadata();
      
      assert.ok(metadata.deadLetterPolicy, "Main subscription should have dead letter policy");
      assert.ok(
        metadata.deadLetterPolicy.deadLetterTopic,
        "Dead letter policy should specify dead letter topic"
      );
      assert.ok(
        metadata.deadLetterPolicy.deadLetterTopic.includes(deadLetterTopicName),
        "Dead letter topic should be dcm2bq-dead-letter-events"
      );
      assert.strictEqual(
        metadata.deadLetterPolicy.maxDeliveryAttempts,
        5,
        "Max delivery attempts should be 5"
      );
    });

    it("should not have dead letter topic as source topic", async function() {
      // Verify that dead letter topic is different from source topic
      const [subscriptions] = await pubsub.getSubscriptions();
      const mainSub = subscriptions.find(sub => 
        sub.name.includes("gcs-to-cloudrun") || sub.name.includes("dcm2bq")
      );
      
      if (!mainSub) {
        this.skip();
        return;
      }
      
      const [metadata] = await mainSub.getMetadata();
      
      assert.notStrictEqual(
        metadata.topic,
        metadata.deadLetterPolicy?.deadLetterTopic,
        "Dead letter topic should not be the same as source topic"
      );
    });
  });
});
