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
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const { BigQuery } = require("@google-cloud/bigquery");
const crypto = require("crypto");

const storage = new Storage();
const bigquery = new BigQuery();

/**
 * Detect if a file is an archive (zip, tgz, tar.gz)
 * @param {string} filePath Path to the file
 * @returns {boolean} True if file is an archive
 */
function isArchiveFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  return ext === '.zip' || 
         ext === '.tgz' || 
         basename.endsWith('.tar.gz');
}

/**
 * Load deployment configuration from file or fallback to test config
 * @param {string} configPath Path to the deployment config file (optional)
 * @returns {Object} Deployment configuration
 * @throws {Error} If config file not found or invalid
 */
function loadDeploymentConfig(configPath) {
  // Try user-provided config first
  if (configPath) {
    try {
      const fullPath = path.resolve(configPath);
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Deployment config file not found: ${fullPath}`);
      }
      const content = fs.readFileSync(fullPath, "utf8");
      const config = JSON.parse(content);
      
      // Validate required fields
      validateConfig(config);
      return config;
    } catch (error) {
      if (error.message.includes("Deployment config")) {
        throw error;
      }
      throw new Error(`Failed to load deployment config: ${error.message}`);
    }
  }
  
  // Fallback to test config if available
  const testConfigPath = path.resolve("test/testconfig.json");
  if (fs.existsSync(testConfigPath)) {
    try {
      const content = fs.readFileSync(testConfigPath, "utf8");
      const config = JSON.parse(content);
      validateConfig(config);
      return config;
    } catch (error) {
      throw new Error(`Failed to load test config: ${error.message}`);
    }
  }
  
  // No config found
  throw new Error(
    "No deployment config found. Provide with --config option or run: " +
    "node helpers/create-deployment-config.js --terraform-dir ./tf"
  );
}

/**
 * Validate deployment configuration has required fields
 * @param {Object} config Configuration object to validate
 * @throws {Error} If required fields are missing
 */
function validateConfig(config) {
  // Check for nested structure (from deploy.sh)
  const hasProjectId = config.gcpConfig?.projectId;
  const hasDatasetId = config.gcpConfig?.bigQuery?.datasetId;
  const hasTableId = config.gcpConfig?.bigQuery?.instancesTableId;
  const hasBucketName = config.gcpConfig?.gcs_bucket_name;
  
  if (!hasProjectId || !hasDatasetId || !hasTableId || !hasBucketName) {
    throw new Error(
      "Missing required fields in config. Expected: " +
      "{ gcpConfig: { projectId, gcs_bucket_name, bigQuery: { datasetId, instancesTableId } } }"
    );
  }
}

/**
 * Upload a file to GCS and return both the object name and version
 * @param {string} filePath Local file path
 * @param {string} bucketName GCS bucket name
 * @returns {Promise<{objectName: string, version: string}>} GCS object name and version ID
 */
async function uploadToGCS(filePath, bucketName) {
  const fileName = path.basename(filePath);
  const timestamp = Date.now();
  const hash = crypto.randomBytes(4).toString("hex");
  const objectName = `uploads/${timestamp}_${hash}_${fileName}`;
  
  try {
    const bucket = storage.bucket(bucketName);
    const file = bucket.file(objectName);
    
    // Upload the file
    await bucket.upload(filePath, {
      destination: objectName
    });
    
    // Get the file metadata to retrieve the generation ID
    const [metadata] = await file.getMetadata();
    const version = metadata.generation;
    
    console.log(`✓ Uploaded to GCS: gs://${bucketName}/${objectName}`);
    return { objectName, version };
  } catch (error) {
    throw new Error(`Failed to upload file to GCS: ${error.message}`);
  }
}

/**
 * Poll BigQuery for processing results
 * @param {Object} options Configuration options
 * @param {string} options.datasetId BigQuery dataset ID
 * @param {string} options.tableId BigQuery table ID
 * @param {string} options.objectPath GCS object path
 * @param {string} options.objectVersion GCS object version ID
 * @param {number} options.pollInterval Polling interval in ms
 * @param {number} options.maxPollTime Maximum polling time in ms
 * @param {boolean} options.isArchive Whether the uploaded file is an archive
 * @param {number} options.uploadTime Time when file was uploaded (in ms)
 * @returns {Promise<Object[]|null>} Array of result rows or null if not found
 */
async function pollBigQueryForResult(options) {
  const { datasetId, tableId, objectPath, objectVersion, pollInterval, maxPollTime, isArchive, uploadTime } = options;
  
  const startTime = Date.now();
  let pollCount = 0;
  let firstResultTime = null;
  let results = [];
  let resultPaths = new Set(); // Track unique paths to avoid duplicates
  
  while (Date.now() - startTime < maxPollTime) {
    pollCount++;
    try {
      let query, params;
      
      if (isArchive) {
        // For archives, search by archive path pattern and version
        // Archive files have paths like: gs://bucket/path/archive.zip#filename.dcm
        query = `
          SELECT *
          FROM \`${bigquery.projectId}.${datasetId}.${tableId}\`
          WHERE path LIKE @pathPattern
            AND version = @version
            AND metadata IS NOT NULL
          ORDER BY timestamp DESC
        `;
        params = {
          pathPattern: `%${objectPath}#%`,
          version: objectVersion,
        };
      } else {
        // For single files, search by exact path and version
        query = `
          SELECT *
          FROM \`${bigquery.projectId}.${datasetId}.${tableId}\`
          WHERE path = @path
            AND version = @version
          ORDER BY timestamp DESC
          LIMIT 1
        `;
        params = { path: `gs://${objectPath}`, version: objectVersion };
      }
      
      const result = await bigquery.query({ query, params });
      const rows = result[0];
      
      if (rows && rows.length > 0) {
        if (!firstResultTime) {
          firstResultTime = Date.now();
          const elapsedSec = ((firstResultTime - startTime) / 1000).toFixed(2);
          console.log(`✓ Found first result in BigQuery after ${pollCount} polls (${elapsedSec}s)`);
        }
        
        // For single files, return immediately
        if (!isArchive) {
          const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`✓ Found result in BigQuery after ${pollCount} polls (${elapsedSec}s)`);
          return [rows[0]];
        }
        
        // For archives, accumulate unique results across polls
        for (const row of rows) {
          if (!resultPaths.has(row.path)) {
            resultPaths.add(row.path);
            results.push(row);
          }
        }
        
        // For archives, if we've waited 5 seconds after first result, we likely have all results
        // But continue polling in case more results are still being written
        if (firstResultTime && Date.now() - firstResultTime > 10000) {
          // After 10 seconds, return what we have
          console.log(`✓ Collected ${results.length} results from archive processing`);
          return results;
        }
      }
    } catch (error) {
      console.warn(`Warning: BigQuery query failed: ${error.message}`);
    }
    
    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  
  if (results.length > 0) {
    console.log(`✓ Collected ${results.length} results after timeout (${Date.now() - startTime}ms)`);
    return results;
  }
  
  console.warn(`⚠ Timeout waiting for result. Polled ${pollCount} times over ${Date.now() - startTime}ms`);
  return null;
}

/**
 * Calculate polling timeout based on file size
 * @param {number} fileSizeBytes File size in bytes
 * @param {number} baseTimeout Base timeout in ms
 * @param {number} timeoutPerMB Additional time per MB of file
 * @returns {number} Calculated timeout in ms
 */
function calculatePollTimeout(fileSizeBytes, baseTimeout, timeoutPerMB) {
  const fileSizeMB = fileSizeBytes / (1024 * 1024);
  return baseTimeout + (fileSizeMB * timeoutPerMB);
}

/**
 * Format a single result row for display
 * @param {Object} row BigQuery result row
 * @returns {string} Formatted result details
 */
function formatResultRow(row) {
  const lines = [];
  
  // Format timestamp - handle BigQuery Timestamp objects
  let timestampStr = "N/A";
  if (row.timestamp) {
    try {
      let ts;
      // BigQuery returns timestamps as BigQueryTimestamp objects with a value property
      if (row.timestamp.value) {
        timestampStr = row.timestamp.value;
      } else if (typeof row.timestamp.toDate === 'function') {
        ts = row.timestamp.toDate();
        timestampStr = ts.toISOString();
      } else if (row.timestamp instanceof Date) {
        timestampStr = row.timestamp.toISOString();
      } else {
        timestampStr = String(row.timestamp);
      }
    } catch (e) {
      timestampStr = String(row.timestamp);
    }
  }
  
  lines.push(`File: ${row.path ? row.path.split("/").pop() : "N/A"}`);
  lines.push(`Uploaded: ${timestampStr}`);
  lines.push(`Full Path: ${row.path || "N/A"}`);
  
  if (row.input) {
    const sizeKB = row.input.size ? (row.input.size / 1024).toFixed(2) : "N/A";
    lines.push(`\nInput:`);
    lines.push(`  Size: ${sizeKB} KB`);
    lines.push(`  Type: ${row.input.type || "N/A"}`);
  }
  
  // Parse and display metadata
  if (row.metadata) {
    try {
      const metadata = typeof row.metadata === "string" 
        ? JSON.parse(row.metadata) 
        : row.metadata;
      
      const dicomFields = [];
      if (metadata.PatientName) dicomFields.push(`Patient Name: ${metadata.PatientName}`);
      if (metadata.PatientID) dicomFields.push(`Patient ID: ${metadata.PatientID}`);
      if (metadata.StudyDate) dicomFields.push(`Study Date: ${metadata.StudyDate}`);
      if (metadata.Modality) dicomFields.push(`Modality: ${metadata.Modality}`);
      if (metadata.StudyDescription) dicomFields.push(`Study: ${metadata.StudyDescription}`);
      if (metadata.SeriesDescription) dicomFields.push(`Series: ${metadata.SeriesDescription}`);
      if (metadata.SeriesNumber) dicomFields.push(`Series #: ${metadata.SeriesNumber}`);
      if (metadata.InstanceNumber) dicomFields.push(`Instance #: ${metadata.InstanceNumber}`);
      
      if (dicomFields.length > 0) {
        lines.push(`\nDICOM Metadata:`);
        dicomFields.forEach(field => lines.push(`  ${field}`));
      }
    } catch (e) {
      // Metadata parsing failed, skip details
    }
  }
  
  // Display embedding info if available
  if (row.embedding && row.embedding.model) {
    lines.push(`\nEmbedding:`);
    lines.push(`  Model: ${row.embedding.model}`);
    if (row.embedding.input && row.embedding.input.path) {
      const inputFile = row.embedding.input.path.split("/").pop();
      lines.push(`  Input: ${inputFile}`);
      if (row.embedding.input.mimeType) {
        lines.push(`  Type: ${row.embedding.input.mimeType}`);
      }
    }
  }
  
  return lines.join("\n");
}

/**
 * Format processing results for display
 * @param {Object[]|Object} results Array of BigQuery result rows or single row
 * @param {boolean} isArchive Whether results are from archive processing
 * @param {number} totalElapsedMs Total elapsed time in milliseconds
 * @returns {string} Formatted result overview
 */
function formatResultOverview(results, isArchive = false, totalElapsedMs = 0) {
  const lines = [];
  const rows = Array.isArray(results) ? results : [results];
  
  if (isArchive) {
    lines.push("\n=== Archive Processing Results ===");
    lines.push(`Total files processed: ${rows.length}\n`);
    
    rows.forEach((row, index) => {
      lines.push(`--- Result ${index + 1} ---`);
      lines.push(formatResultRow(row));
      lines.push("");
    });
    
    // Summary statistics
    const modalities = new Set();
    const totalSize = rows.reduce((sum, row) => sum + (row.input?.size || 0), 0);
    rows.forEach(row => {
      try {
        const metadata = typeof row.metadata === "string" 
          ? JSON.parse(row.metadata) 
          : row.metadata;
        if (metadata.Modality) modalities.add(metadata.Modality);
      } catch (e) {
        // Ignore parsing errors
      }
    });
    
    lines.push("--- Summary ---");
    lines.push(`Total size: ${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
    if (modalities.size > 0) {
      lines.push(`Modalities: ${Array.from(modalities).join(", ")}`);
    }
  } else {
    lines.push("\n=== Processing Result Overview ===");
    lines.push(formatResultRow(rows[0]));
  }
  
  // Add total processing time
  if (totalElapsedMs > 0) {
    const totalSec = (totalElapsedMs / 1000).toFixed(2);
    lines.push(`\nTotal processing time: ${totalSec}s`);
  }
  
  lines.push("===================================\n");
  return lines.join("\n");
}

/**
 * Execute the process command
 * @param {string} inputFile Input file path
 * @param {Object} options Command options
 */
async function execute(inputFile, options) {
  // Record start time for total processing duration
  const startTimeMs = Date.now();
  
  // Validate input file
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }
  
  const stats = fs.statSync(inputFile);
  const fileSizeBytes = stats.size;
  const isArchive = isArchiveFile(inputFile);
  const fileType = isArchive ? "archive" : "DICOM file";
  
  console.log(`Processing ${fileType}: ${inputFile}`);
  console.log(`File size: ${fileSizeBytes} bytes (${(fileSizeBytes / 1024 / 1024).toFixed(2)} MB)`);
  if (isArchive) {
    console.log(`Note: Archive files are expanded and processed as separate DICOM files`);
  }
  
  // Load deployment config (use --config if provided, otherwise try test/testconfig.json)
  const deploymentConfig = loadDeploymentConfig(options.config);
  if (options.config) {
    console.log(`✓ Loaded deployment config from: ${options.config}`);
  } else {
    console.log(`✓ Loaded deployment config from: test/testconfig.json`);
  }
  
  // Extract config values from nested structure (from deploy.sh)
  const gcpConfig = deploymentConfig.gcpConfig || deploymentConfig;
  const projectId = gcpConfig.projectId;
  const datasetId = gcpConfig.bigQuery?.datasetId;
  const tableId = gcpConfig.bigQuery?.instancesTableId;
  const bucketName = gcpConfig.gcs_bucket_name;
  
  if (!bucketName) {
    throw new Error("Could not determine GCS bucket name from config. Expected gcpConfig.gcs_bucket_name");
  }
  
  // Upload to GCS
  const uploadTimeMs = Date.now();
  const uploadResult = await uploadToGCS(inputFile, bucketName);
  const objectName = uploadResult.objectName;
  const objectVersion = uploadResult.version;
  
  // Calculate polling timeout (archives may take longer)
  const pollInterval = parseInt(options.pollInterval, 10);
  const baseTimeout = parseInt(options.pollTimeout, 10);
  const timeoutPerMB = parseInt(options.pollTimeoutPerMb, 10);
  let maxPollTime = calculatePollTimeout(fileSizeBytes, baseTimeout, timeoutPerMB);
  
  // Add extra time for archive processing (multiple files to extract and process)
  if (isArchive) {
    maxPollTime += 30000; // Add 30 seconds for archive extraction
  }
  
  const pollIntervalSec = (pollInterval / 1000).toFixed(1);
  const maxPollTimeSec = (maxPollTime / 1000).toFixed(1);
  console.log(`\nPolling for results (interval: ${pollIntervalSec}s, max time: ${maxPollTimeSec}s)...`);
  
  // Poll for results using version to ensure we get the latest upload
  const results = await pollBigQueryForResult({
    datasetId,
    tableId,
    objectPath: `${bucketName}/${objectName}`,
    objectVersion,
    pollInterval,
    maxPollTime,
    isArchive,
    uploadTime: uploadTimeMs,
  });
  
  if (results && results.length > 0) {
    const totalElapsedMs = Date.now() - startTimeMs;
    const overview = formatResultOverview(results, isArchive, totalElapsedMs);
    console.log(overview);
  } else {
    console.log("\n⚠ No result found in BigQuery within timeout period");
    console.log("The file was uploaded successfully but may still be processing.");
    if (isArchive) {
      console.log("For archive files, all contained DICOM files must be extracted and processed.");
    }
    console.log(`Query BigQuery manually: SELECT * FROM \`${projectId}.${datasetId}.${tableId}\` WHERE path LIKE '%${objectName}%' OR timestamp >= TIMESTAMP.ADD(CURRENT_TIMESTAMP(), INTERVAL -5 MINUTE) ORDER BY timestamp DESC`);
  }
}

module.exports = {
  execute,
  loadDeploymentConfig,
  uploadToGCS,
  pollBigQueryForResult,
  calculatePollTimeout,
  formatResultOverview,
  formatResultRow,
  isArchiveFile,
};
