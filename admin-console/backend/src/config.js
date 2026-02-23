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

/**
 * Configuration management for admin-console backend
 * 
 * Only manages BigQuery table references (instances view and dead letter table).
 * Configuration precedence:
 * 1. Environment variables (BQ_INSTANCES_VIEW_ID, BQ_DEAD_LETTER_TABLE_ID) - highest priority
 * 2. Test config (if NODE_ENV=test) from ../../../test/testconfig.json
 * 3. Default configuration from ./config.defaults.js
 */

let cachedConfig = null;

/**
 * Attempts to read test configuration
 * @returns {Object|null} Parsed configuration object or null if not found
 */
function tryReadTestConfig() {
  if (process.env.NODE_ENV !== "test") {
    return null;
  }

  try {
    const testConfigPath = path.join(__dirname, "..", "..", "..", "test", "testconfig.json");
    if (!fs.existsSync(testConfigPath)) {
      return null;
    }
    const fileContent = fs.readFileSync(testConfigPath, "utf8");
    return JSON.parse(fileContent);
  } catch (_) {
    return null;
  }
}

/**
 * Extracts BigQuery configuration from config object
 * Handles both nested (gcpConfig.bigQuery) and flat (datasetId/instancesViewId) formats
 * Returns components separately: projectId, datasetId, instancesTableId, deadLetterTableId
 * @param {Object} config Configuration object
 * @returns {Object} Object with BigQuery components
 */
function extractBigQueryConfig(config) {
  // If already has admin key with components, use it
  if (config.admin?.projectId && config.admin?.datasetId) {
    return config.admin;
  }

  // Try to extract from nested gcpConfig structure
  if (config.gcpConfig?.bigQuery) {
    const projectId = config.gcpConfig.projectId;
    const datasetId = config.gcpConfig.bigQuery.datasetId;
    const instancesTableId = config.gcpConfig.bigQuery.instancesTableId || "instances";
    
    // Parse deadLetterTableId - it might be just tableName or dataset.tableName
    let deadLetterTableId = config.deadLetterTableId || "dead_letter";
    if (deadLetterTableId.includes(".")) {
      // If it's dataset.table format, keep just the table name (dataset from main config)
      deadLetterTableId = deadLetterTableId.split(".").pop();
    }
    
    return {
      projectId,
      datasetId,
      instancesTableId,
      deadLetterTableId: deadLetterTableId || "dead_letter",
    };
  }

  // Try to extract from flat structure
  if (config.datasetId) {
    const projectId = config.projectId;
    const datasetId = config.datasetId;
    const instancesTableId = config.instancesViewId || "instances";
    
    // Parse deadLetterTableId - it might be just tableName or dataset.tableName
    let deadLetterTableId = config.deadLetterTableId || "dead_letter";
    if (deadLetterTableId.includes(".")) {
      // If it's dataset.table format, keep just the table name (dataset from main config)
      deadLetterTableId = deadLetterTableId.split(".").pop();
    }
    
    return {
      projectId,
      datasetId,
      instancesTableId,
      deadLetterTableId: deadLetterTableId || "dead_letter",
    };
  }

  // Return what we have
  return config.admin || {};
}

/**
 * Gets the admin console BigQuery configuration
 * 
 * Returns BigQuery components (projectId, datasetId, instancesTableId, deadLetterTableId)
 * 
 * @param {Object} options Configuration options
 * @param {boolean} options.ignoreCache If true, reload config from source
 * @returns {Object} Object with admin config containing BigQuery components
 * @throws {Error} If required fields are missing
 */
function getConfig(options = {}) {
  if (!options.ignoreCache && cachedConfig) {
    return cachedConfig;
  }

  try {
    let config = tryReadTestConfig() || require("./config.defaults.js");

    if (!config || typeof config !== "object") {
      throw new Error("Invalid configuration format: expected an object");
    }

    // Extract BigQuery config components
    let adminCfg = extractBigQueryConfig(config);

    // Allow environment variables to override (highest priority)
    // For env vars, we expect projectId.dataset.table format and split it
    if (process.env.BQ_INSTANCES_VIEW_ID) {
      const parts = process.env.BQ_INSTANCES_VIEW_ID.split(".");
      if (parts.length === 3) {
        adminCfg.projectId = parts[0];
        adminCfg.datasetId = parts[1];
        adminCfg.instancesTableId = parts[2];
      } else if (parts.length === 2) {
        adminCfg.datasetId = parts[0];
        adminCfg.instancesTableId = parts[1];
      } else {
        adminCfg.instancesTableId = process.env.BQ_INSTANCES_VIEW_ID;
      }
    }
    
    if (process.env.BQ_DEAD_LETTER_TABLE_ID) {
      const parts = process.env.BQ_DEAD_LETTER_TABLE_ID.split(".");
      if (parts.length === 3) {
        adminCfg.projectId = parts[0];
        adminCfg.datasetId = parts[1];
        adminCfg.deadLetterTableId = parts[2];
      } else if (parts.length === 2) {
        adminCfg.datasetId = parts[0];
        adminCfg.deadLetterTableId = parts[1];
      } else {
        adminCfg.deadLetterTableId = process.env.BQ_DEAD_LETTER_TABLE_ID;
      }
    }

    // Validate required fields
    if (!adminCfg.projectId) {
      throw new Error(
        "Configuration missing required field: GCP projectId " +
        "(set via GCP_PROJECT_ID environment variable or testconfig.json with gcpConfig.projectId)"
      );
    }

    if (!adminCfg.datasetId) {
      throw new Error(
        "Configuration missing required field: BQ dataset " +
        "(set via testconfig.json or BQ_INSTANCES_VIEW_ID environment variable)"
      );
    }

    if (!adminCfg.instancesTableId) {
      throw new Error(
        "Configuration missing required field: BQ instances table " +
        "(set via testconfig.json or BQ_INSTANCES_VIEW_ID environment variable)"
      );
    }

    if (!adminCfg.deadLetterTableId) {
      throw new Error(
        "Configuration missing required field: BQ dead letter table " +
        "(set via testconfig.json or BQ_DEAD_LETTER_TABLE_ID environment variable)"
      );
    }

    cachedConfig = { admin: adminCfg };
    return cachedConfig;
  } catch (error) {
    // Clear cache in case of error to allow retry
    cachedConfig = null;
    throw error;
  }
}

module.exports = {
  get: getConfig,
};
