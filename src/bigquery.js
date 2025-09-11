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
const metadataTable = cfg.metadataTableId;
const embeddingsTable = cfg.embeddingsTableId || `${metadataTable}_embeddings`;

async function insertMetadata(obj) {
  if (!datasetId || !metadataTable) throw new Error('BigQuery metadata table not configured');
  await bigquery.dataset(datasetId).table(metadataTable).insert(obj);
}

async function insertEmbeddings(obj) {
  if (!datasetId || !embeddingsTable) throw new Error('BigQuery embeddings table not configured');
  await bigquery.dataset(datasetId).table(embeddingsTable).insert(obj);
}

// Backwards compatible default
module.exports = { insertMetadata, insertEmbeddings, insert: insertMetadata };
