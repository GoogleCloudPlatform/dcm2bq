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

const fs = require("fs");
const { BigQuery } = require("@google-cloud/bigquery");
const { PubSub } = require("@google-cloud/pubsub");

/**
 * Parse the data field (base64 encoded JSON) to extract file information
 * @param {string} base64Data - Base64 encoded data field
 * @returns {object} Parsed object information
 */
function parseDataField(base64Data) {
  if (!base64Data) return null;

  if (Buffer.isBuffer(base64Data)) {
    const text = base64Data.toString("utf-8").trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  try {
    const decoded = Buffer.from(String(base64Data), "base64").toString("utf-8");
    try {
      return JSON.parse(decoded);
    } catch (_) {
      const text = decoded.trim();
      if (text) return text;
    }
  } catch (_) {
    // Fall through to raw JSON parse below.
  }

  try {
    return JSON.parse(String(base64Data));
  } catch (_) {
    return null;
  }
}

/**
 * Parse attributes field (JSON string) to extract file information
 * @param {string} attributesJson - JSON string of attributes
 * @returns {object} Parsed attributes
 */
function parseAttributes(attributesJson) {
  if (!attributesJson) return null;
  if (typeof attributesJson === "object") return attributesJson;
  try {
    return JSON.parse(attributesJson);
  } catch (_) {
    return null;
  }
}

function extractRequeueTarget(row) {
  const attrs = row.attributes ? parseAttributes(row.attributes) || {} : {};
  const data = row.data ? parseDataField(row.data) : null;

  const bucket = data?.bucket || attrs.bucketId;
  const objectId = data?.name || attrs.objectId;
  if (bucket && objectId) {
    const eventData = {
      ...(data && typeof data === "object" ? data : {}),
      bucket,
      name: objectId,
    };
    if (eventData.generation || attrs.objectGeneration) {
      eventData.generation = String(eventData.generation || attrs.objectGeneration);
    }

    return {
      key: `gcs:${bucket}/${objectId}`,
      displayPath: `gs://${bucket}/${objectId}`,
      publishData: Buffer.from(JSON.stringify(eventData), "utf8"),
      publishAttributes: {
        payloadFormat: "JSON_API_V1",
        eventType: "OBJECT_FINALIZE",
        bucketId: bucket,
        objectId,
        ...(eventData.generation ? { objectGeneration: String(eventData.generation) } : {}),
      },
    };
  }

  if (typeof data === "string" && data.trim() && /\/dicomWeb\//.test(data)) {
    const dicomWebPath = data.trim();
    return {
      key: `hcapi:${dicomWebPath}`,
      displayPath: `https://healthcare.googleapis.com/v1/${dicomWebPath}`,
      publishData: Buffer.from(dicomWebPath, "utf8"),
      publishAttributes: {
        ...(attrs && typeof attrs === "object" ? attrs : {}),
      },
    };
  }

  return null;
}

/**
 * List dead letter queue items
 * @param {object} config - Configuration object
 * @param {object} options - Command options
 */
async function listDLQ(config, options) {
  const projectId = config.projectId || config.gcpConfig?.projectId;
  const datasetId = config.datasetId || config.gcpConfig?.bigQuery?.datasetId;
  const deadLetterTableId = config.deadLetterTableId || `${datasetId}.dead_letter`;
  const limit = parseInt(options.limit || "100", 10);

  if (!projectId || !datasetId) {
    throw new Error("Missing required configuration: projectId and datasetId");
  }

  console.log(`\n📊 Dead Letter Queue Analysis`);
  console.log(`   Project: ${projectId}`);
  console.log(`   Table: ${deadLetterTableId}`);
  console.log(`   Limit: ${limit}\n`);

  const bigquery = new BigQuery({ projectId });

  // Query to get all dead letter items
  const query = `
    SELECT 
      data,
      attributes,
      message_id,
      publish_time
    FROM \`${deadLetterTableId}\`
    ORDER BY publish_time DESC
    LIMIT ${limit}
  `;

  const [rows] = await bigquery.query({ query });

  if (rows.length === 0) {
    console.log("✅ No items in dead letter queue\n");
    return;
  }

  // Extract requeue targets (GCS and HCAPI)
  const files = new Map(); // key: target.key, value: {count, displayPath}
  let parseErrors = 0;

  for (const row of rows) {
    const target = extractRequeueTarget(row);
    if (target) {
      const key = target.key;
      if (files.has(key)) {
        files.get(key).count++;
      } else {
        files.set(key, {
          count: 1,
          displayPath: target.displayPath,
        });
      }
    } else {
      parseErrors++;
    }
  }

  console.log(`📈 Summary:`);
  console.log(`   Total records: ${rows.length}`);
  console.log(`   Unique files: ${files.size}`);
  if (parseErrors > 0) {
    console.log(`   ⚠️  Parse errors: ${parseErrors}`);
  }
  console.log();

  // Display distinct files
  console.log(`📁 Failed Files:\n`);
  const sortedFiles = Array.from(files.entries()).sort((a, b) => b[1].count - a[1].count);
  
  for (const [, info] of sortedFiles) {
    console.log(`   ${info.count}x  ${info.displayPath}`);
  }
  console.log();
}

/**
 * Requeue items from dead letter queue by publishing Pub/Sub messages
 * @param {object} config - Configuration object
 * @param {object} options - Command options
 */
async function requeueDLQ(config, options) {
  const projectId = config.projectId || config.gcpConfig?.projectId;
  const datasetId = config.datasetId || config.gcpConfig?.bigQuery?.datasetId;
  const deadLetterTableId = config.deadLetterTableId || `${datasetId}.dead_letter`;
  const limit = parseInt(options.limit || "100", 10);

  if (!projectId || !datasetId) {
    throw new Error("Missing required configuration: projectId and datasetId");
  }

  console.log(`\n🔄 Requeuing Dead Letter Queue Items`);
  console.log(`   Project: ${projectId}`);
  console.log(`   Table: ${deadLetterTableId}`);
  console.log(`   Limit: ${limit}\n`);

  const bigquery = new BigQuery({ projectId });
  const pubsub = new PubSub({ projectId });
  const requeueTopicName = process.env.PUBSUB_REQUEUE_TOPIC || config.pubsubRequeueTopic || "dcm2bq-gcs-events";
  const requeueTopic = pubsub.topic(requeueTopicName);

  // Query to get items to requeue
  const query = `
    SELECT 
      data,
      attributes,
      message_id,
      publish_time
    FROM \`${deadLetterTableId}\`
    ORDER BY publish_time DESC
    LIMIT ${limit}
  `;

  const [rows] = await bigquery.query({ query });

  if (rows.length === 0) {
    console.log("✅ No items to requeue\n");
    return;
  }

  // Extract unique requeue targets.
  // Even if an object appears multiple times in DLQ, publish only once.
  const files = new Map(); // key: target.key, value: { target, publishTime, messageIds }
  let parseErrors = 0;

  for (const row of rows) {
    const target = extractRequeueTarget(row);
    if (target) {
      const key = target.key;
      const rowPublishTime = row.publish_time ? new Date(row.publish_time.value || row.publish_time).getTime() : 0;
      const messageId = row.message_id;
      const existing = files.get(key);
      
      if (!existing) {
        files.set(key, { target, publishTime: rowPublishTime, messageIds: [messageId] });
      } else {
        // Keep the latest publish_time and accumulate all message_ids
        existing.messageIds.push(messageId);
        if (rowPublishTime > existing.publishTime) {
          existing.publishTime = rowPublishTime;
          existing.target = target;
        }
      }
    } else {
      parseErrors++;
    }
  }

  console.log(`Found ${files.size} unique files to requeue`);
  if (parseErrors > 0) {
    console.log(`⚠️  ${parseErrors} records could not be parsed\n`);
  }

  // Requeue files by publishing schema-compliant Pub/Sub messages
  let succeeded = 0;
  let failed = 0;
  const messageIdsToDelete = [];

  const orderedFiles = Array.from(files.entries()).sort((a, b) => b[1].publishTime - a[1].publishTime);

  for (const [, entry] of orderedFiles) {
    try {
      await requeueTopic.publishMessage({
        data: entry.target.publishData,
        attributes: {
          ...entry.target.publishAttributes,
          dcm2bqRequeueSource: 'dlq',
          dcm2bqRequeueAt: new Date().toISOString(),
        },
      });

      console.log(`   ✅ Requeued: ${entry.target.displayPath}`);
      succeeded++;
      
      // Track message IDs for deletion
      messageIdsToDelete.push(...entry.messageIds);
    } catch (error) {
      console.log(`   ❌ Failed: ${entry.target.displayPath} - ${error.message}`);
      failed++;
    }
  }

  // Delete successfully requeued items from DLQ
  if (messageIdsToDelete.length > 0) {
    try {
      const messageIdsList = messageIdsToDelete.map(id => `'${id}'`).join(', ');
      const deleteQuery = `
        DELETE FROM \`${deadLetterTableId}\`
        WHERE message_id IN (${messageIdsList})
      `;
      
      await bigquery.query({ query: deleteQuery });
      console.log(`\n🗑️  Deleted ${messageIdsToDelete.length} records from dead letter table`);
    } catch (error) {
      console.error(`⚠️  Failed to delete records from DLQ: ${error.message}`);
    }
  }

  console.log();
  console.log(`📊 Requeue Results:`);
  console.log(`   ✅ Succeeded: ${succeeded}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log();

  if (succeeded > 0) {
    console.log(`ℹ️  Files will be reprocessed via Cloud Run`);
    console.log(`   Monitor logs to verify processing\n`);
  }
}

/**
 * Load configuration from file or environment
 * @param {object} options - Command options
 * @returns {object} Configuration object
 */
function loadConfig(options) {
  let configPath = options.config;

  // Try default locations if not specified
  if (!configPath) {
    const defaultPaths = ["test/testconfig.json", "testconfig.json"];
    for (const path of defaultPaths) {
      if (fs.existsSync(path)) {
        configPath = path;
        break;
      }
    }
  }

  if (configPath && fs.existsSync(configPath)) {
    console.log(`Using config file: ${configPath}`);
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  throw new Error(
    "Configuration file not found. Use --config or create test/testconfig.json"
  );
}

/**
 * Execute DLQ command
 * @param {string} action - Action to perform ('list' or 'requeue')
 * @param {object} options - Command options
 */
async function execute(action, options) {
  const config = loadConfig(options);

  if (action === "list") {
    await listDLQ(config, options);
  } else if (action === "requeue") {
    await requeueDLQ(config, options);
  } else {
    throw new Error(`Unknown action: ${action}. Use 'list' or 'requeue'`);
  }
}

module.exports = { execute };
