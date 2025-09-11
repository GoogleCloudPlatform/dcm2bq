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
const { getSchema } = require("./schemas");
const consts = require('./consts');

/**
 * Configuration constants
 */
const CONFIG = {
  ENV_VAR: 'DCM2BQ_CONFIG',
  FILE_ENV_VAR: 'DCM2BQ_CONFIG_FILE',
  DEFAULT_FILE: './config.defaults.js'
};

// Cache for the parsed configuration
let cachedConfig = null;

/**
 * Attempts to read and parse configuration from environment variable
 * @returns {Object|null} Parsed configuration object or null if not found
 * @throws {Error} If JSON parsing fails
 */
function tryReadEnvVars() {
  const env = process.env[CONFIG.ENV_VAR];
  if (!env || env.trim() === "") {
    return null;
  }
  
  try {
    return JSON.parse(env);
  } catch (error) {
    throw new Error(`Failed to parse DCM2BQ_CONFIG environment variable: ${error.message}`);
  }
}

/**
 * Attempts to read and parse configuration from file
 * @returns {Object|null} Parsed configuration object or null if not found
 * @throws {Error} If file reading or parsing fails
 */
function tryReadConfigFile() {
  const fileName = process.env[CONFIG.FILE_ENV_VAR];
  if (!fileName) {
    return null;
  }
  
  try {
    const fileContent = fs.readFileSync(fileName, 'utf8');
    return JSON.parse(fileContent);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${fileName}`);
    }
    throw new Error(`Failed to read/parse configuration file ${fileName}: ${error.message}`);
  }
}

/**
 * Gets the configuration object, using the following precedence:
 * 1. Environment variable (DCM2BQ_CONFIG)
 * 2. Configuration file (specified by DCM2BQ_CONFIG_FILE)
 * 3. Default configuration file
 * 
 * @returns {Object} The configuration object
 * @throws {Error} If configuration cannot be loaded or parsed
 */
function getConfig(options = {}) {
  if (!options.ignoreCache && cachedConfig) {
    return cachedConfig;
  }

  try {
    cachedConfig = tryReadEnvVars() || tryReadConfigFile() || require(CONFIG.DEFAULT_FILE);
    
    if (!cachedConfig || typeof cachedConfig !== 'object') {
      throw new Error('Invalid configuration format: expected an object');
    }

    const validate = getSchema(consts.CONFIG_SCHEMA);
    if (!validate(cachedConfig)) {
      throw new Error(`Invalid configuration: ${validate.errors.map(e => `${e.instancePath} ${e.message}`).join(', ')}`);
    }

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
