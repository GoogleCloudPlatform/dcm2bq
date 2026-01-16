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
    const errorDetails = error.errors ? error.errors.map(e => e.message).join('; ') : error.message;
    const err = new Error(`Failed to insert DICOM record: ${errorDetails}`);
    err.originalError = error;
    err.rowData = obj;
    throw err;
  }
}

module.exports = { insert };
