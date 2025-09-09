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

// NOTE: When overriding these defaults via environment variables or a config file,
// make sure to include all required fields.

module.exports = {
  gcpConfig: {
    // GCP project and location for services like Vertex AI
    projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GCP_LOCATION || "us-central1",
    // Configuration for BigQuery and Vertex AI Embeddings
    bigQuery: {
      // Location to use in BigQuery
      datasetId: "dicom",
      tableId: "metadata",
    },
    embeddings: {
      enabled: true, // Generate embeddings for text and images
      // See https://cloud.google.com/vertex-ai/docs/generative-ai/model-reference/multimodal-embeddings
      model: "multimodalembedding@001",
      summarizeText: {
        enabled: true, // Use Gemini to summarize long text fields before generating embeddings
        model: "gemini-2.5-flash-lite", // Gemini model to use for summarization
      },
    },
  },
  // Passed to DICOM parser (https://github.com/cornerstonejs/dicomParser)
  dicomParser: {},
  // Passed to JSON formatter
  jsonOutput: {
    useArrayWithSingleValue: false, // Use array, even when there's only a single value
    ignoreGroupLength: true, // Ignore group length elements
    ignoreMetaHeader: false, // Ignore the DICOM metadata header
    ignorePrivate: false, // Ignore any private tags
    ignoreBinary: false, // Ignore any binary tags
    useCommonNames: true, // Map DICOM tags to common names
    explicitBulkDataRoot: false, // For BulkdDataURIs use an explicit file path
  },
  src: "DEFAULTS",
};

