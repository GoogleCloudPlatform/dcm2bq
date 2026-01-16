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

const { BigQuery } = require("@google-cloud/bigquery");
const config = require("./config");

const bigquery = new BigQuery();
const cfg = config.get().gcpConfig.bigQuery || {};
const datasetId = cfg.datasetId;
const instancesTable = cfg.instancesTableId;

async function insert(obj) {
  if (!datasetId || !instancesTable) throw new Error('BigQuery instances table not configured');
  try {
    await bigquery.dataset(datasetId).table(instancesTable).insert(obj);
  } catch (error) {
    // Enhanced error logging
    console.error('BigQuery insert error:', JSON.stringify({
      message: error.message,
      errors: error.errors,
      name: error.name,
      code: error.code
    }, null, 2));
    console.error('Row data being inserted:', JSON.stringify(obj, null, 2));
    
    let errorDetails = 'Unknown error';
    if (error.errors && Array.isArray(error.errors) && error.errors.length > 0) {
      errorDetails = error.errors.map(e => {
        const reason = e.reason || 'unknown';
        const message = e.message || 'no message';
        const location = e.location ? ` (${e.location})` : '';
        return `${reason}: ${message}${location}`;
      }).join('; ');
    } else if (error.message) {
      errorDetails = error.message;
    }
    
    const err = new Error(`Failed to insert DICOM record: ${errorDetails}`);
    err.originalError = error;
    err.rowData = obj;
    throw err;
  }
}

module.exports = { insert };
