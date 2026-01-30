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
const { Storage } = require("@google-cloud/storage");

/**
 * Parse the data field (base64 encoded JSON) to extract file information
 * @param {string} base64Data - Base64 encoded data field
 * @returns {object} Parsed object information
 */
function parseDataField(base64Data) {
  try {
    const decoded = Buffer.from(base64Data, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (error) {
    console.warn("Failed to parse data field:", error.message);
    return null;
  }
}

/**
 * Parse attributes field (JSON string) to extract file information
 * @param {string} attributesJson - JSON string of attributes
 * @returns {object} Parsed attributes
 */
function parseAttributes(attributesJson) {
  try {
    return JSON.parse(attributesJson);
  } catch (error) {
    console.warn("Failed to parse attributes field:", error.message);
    return null;
  }
}

/**
 * Extract file information from dead letter record
 * @param {object} row - BigQuery row from dead_letter table
 * @returns {object} File information {bucket, name, generation}
 */
function extractFileInfo(row) {
  // Try to parse data field first
  if (row.data) {
    const data = parseDataField(row.data);
    if (data && data.bucket && data.name) {
      return {
        bucket: data.bucket,
        name: data.name,
        generation: data.generation,
        source: 'data'
      };
    }
  }

  // Fall back to attributes field
  if (row.attributes) {
    const attrs = parseAttributes(row.attributes);
    if (attrs) {
      const bucket = attrs.bucketId;
      const name = attrs.objectId;
      const generation = attrs.objectGeneration;
      
      if (bucket && name) {
        return {
          bucket,
          name,
          generation,
          source: 'attributes'
        };
      }
    }
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

  // Extract file names and buckets
  const files = new Map(); // key: bucket/name, value: {count, generation}
  let parseErrors = 0;

  for (const row of rows) {
    const fileInfo = extractFileInfo(row);
    if (fileInfo) {
      const key = `${fileInfo.bucket}/${fileInfo.name}`;
      if (files.has(key)) {
        files.get(key).count++;
      } else {
        files.set(key, {
          count: 1,
          bucket: fileInfo.bucket,
          name: fileInfo.name,
          generation: fileInfo.generation
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
  
  for (const [path, info] of sortedFiles) {
    console.log(`   ${info.count}x  gs://${path}`);
  }
  console.log();
}

/**
 * Requeue items from dead letter queue by updating GCS object metadata
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
  const storage = new Storage({ projectId });

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

  // Extract unique files
  // Even if a file appears multiple times in DLQ, we only requeue it once
  const files = new Map(); // key: bucket/name, value: { fileInfo, publishTime, messageIds }
  let parseErrors = 0;

  for (const row of rows) {
    const fileInfo = extractFileInfo(row);
    if (fileInfo) {
      const key = `${fileInfo.bucket}/${fileInfo.name}`;
      const rowPublishTime = row.publish_time ? new Date(row.publish_time.value || row.publish_time).getTime() : 0;
      const messageId = row.message_id;
      const existing = files.get(key);
      
      if (!existing) {
        files.set(key, { fileInfo, publishTime: rowPublishTime, messageIds: [messageId] });
      } else {
        // Keep the latest publish_time and accumulate all message_ids
        existing.messageIds.push(messageId);
        if (rowPublishTime > existing.publishTime) {
          existing.publishTime = rowPublishTime;
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

  // Requeue files by updating metadata
  let succeeded = 0;
  let failed = 0;
  const messageIdsToDelete = [];

  const orderedFiles = Array.from(files.entries()).sort((a, b) => b[1].publishTime - a[1].publishTime);

  for (const [path, entry] of orderedFiles) {
    const fileInfo = entry.fileInfo;
    try {
      const bucket = storage.bucket(fileInfo.bucket);
      const file = bucket.file(fileInfo.name);

      // Check if file exists
      const [exists] = await file.exists();
      if (!exists) {
        console.log(`   ⚠️  File not found: gs://${path}`);
        failed++;
        continue;
      }

      // Update metadata to trigger reprocessing
      // Adding/updating metadata causes GCS to emit an OBJECT_METADATA_UPDATE event
      await file.setMetadata({
        metadata: {
          'dcm2bq-reprocess': new Date().toISOString(),
          'dcm2bq-requeue-source': 'dlq'
        }
      });

      console.log(`   ✅ Requeued: gs://${path}`);
      succeeded++;
      
      // Track message IDs for deletion
      messageIdsToDelete.push(...entry.messageIds);
    } catch (error) {
      console.log(`   ❌ Failed: gs://${path} - ${error.message}`);
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
