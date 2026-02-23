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

// Default configuration for admin-console backend
// Can be overridden via environment variables or test config (test/testconfig.json)
// Table references can be in format: projectId.dataset.table or just table names

module.exports = {
  admin: {
    // GCP Project ID - must be set via environment variables or test config
    // No default fallback - will use GCP Application Default Credentials
    projectId: process.env.GCP_PROJECT_ID,
    
    // BigQuery dataset ID
    datasetId: process.env.BQ_DATASET_ID || "dicom",
    
    // BigQuery instances view ID (read/search path)
    instancesViewId: process.env.BQ_INSTANCES_VIEW_ID || "instancesView",

    // BigQuery writable instances table ID (delete path)
    instancesTableId: process.env.BQ_INSTANCES_TABLE_ID || "instances",
    
    // BigQuery dead letter table ID
    deadLetterTableId: process.env.BQ_DEAD_LETTER_TABLE_ID || "dead_letter",
  },
};
