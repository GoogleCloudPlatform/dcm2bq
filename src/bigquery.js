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
const embeddingsTable = cfg.embeddingsTableId;

function formatInsertError(error, label) {
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
  return `Failed to insert ${label}: ${errorDetails}`;
}

async function insert(obj) {
  if (!datasetId || !instancesTable) throw new Error('BigQuery instances table not configured');
  try {
    await bigquery.dataset(datasetId).table(instancesTable).insert(obj);
  } catch (error) {
    console.error('BigQuery insert error:', JSON.stringify({
      message: error.message,
      errors: error.errors,
      name: error.name,
      code: error.code
    }));
    console.error('Row data being inserted:', JSON.stringify(obj));

    const err = new Error(formatInsertError(error, 'DICOM record'));
    err.originalError = error;
    err.rowData = obj;
    throw err;
  }
}

async function insertEmbeddings(rows) {
  if (!datasetId || !embeddingsTable) throw new Error('BigQuery embeddings table not configured');
  if (!Array.isArray(rows) || rows.length === 0) return;
  try {
    await bigquery.dataset(datasetId).table(embeddingsTable).insert(rows);
  } catch (error) {
    console.error('BigQuery embeddings insert error:', JSON.stringify({
      message: error.message,
      errors: error.errors,
      name: error.name,
      code: error.code
    }));

    const err = new Error(formatInsertError(error, 'embedding records'));
    err.originalError = error;
    throw err;
  }
}

module.exports = { insert, insertEmbeddings };
