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

const { GoogleAuth } = require("google-auth-library");
const { gcpConfig, jsonOutput } = require("./config").get();
const { processImage } = require("./processors/image");
const { processPdf } = require("./processors/pdf");
const { processSR } = require("./processors/sr");

// --- Configuration ---
const ENDPOINT = createEndpoint(gcpConfig);

function createEndpoint(config) {
  return `https://us-central1-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/us-central1/publishers/google/models/${config.embeddings.model}:predict`;
}

// SOP Class UIDs for different DICOM object types
const SOP_CLASS_UIDS = {
  // Encapsulated PDF
  ENCAPSULATED_PDF: "1.2.840.10008.5.1.4.1.1.104.1",
  // Basic Text SR
  BASIC_TEXT_SR: "1.2.840.10008.5.1.4.1.1.88.11",
  // Enhanced SR
  ENHANCED_SR: "1.2.840.10008.5.1.4.1.1.88.22",
  // Comprehensive SR
  COMPREHENSIVE_SR: "1.2.840.10008.5.1.4.1.1.88.33",
  // List of image SOP Class UIDs (non-exhaustive)
  IMAGE_SOP_CLASSES: [
    "1.2.840.10008.5.1.4.1.1.2", // CT Image Storage
    "1.2.840.10008.5.1.4.1.1.1", // CR Image Storage
    "1.2.840.10008.5.1.4.1.1.1.1", // DX Image Storage
    "1.2.840.10008.5.1.4.1.1.1.2", // MG Image Storage
    "1.2.840.10008.5.1.4.1.1.4", // MR Image Storage
    "1.2.840.10008.5.1.4.1.1.6.1", // US Image Storage
    "1.2.840.10008.5.1.4.1.1.7", // SC Image Storage
    "1.2.840.10008.5.1.4.1.1.12.1", // X-Ray Angiographic Image Storage
    "1.2.840.10008.5.1.4.1.1.20", // NM Image Storage
    "1.2.840.10008.5.1.4.1.1.128", // PT Image Storage
    "1.2.840.10008.5.1.4.1.1.481.1", // RT Image Storage
    // TODO: Add any known SOP classes that are missing
  ],
};

function isImage(sopClassUid) {
  // A simple check if the UID is in our list.
  // A more robust check might look at the SOP Class UID registry.
  return SOP_CLASS_UIDS.IMAGE_SOP_CLASSES.includes(sopClassUid);
}

function isStructuredReport(sopClassUid) {
  return [SOP_CLASS_UIDS.BASIC_TEXT_SR, SOP_CLASS_UIDS.ENHANCED_SR, SOP_CLASS_UIDS.COMPREHENSIVE_SR].includes(sopClassUid);
}

function isPdf(sopClassUid) {
  return sopClassUid === SOP_CLASS_UIDS.ENCAPSULATED_PDF;
}

async function doRequest(payload) {
  try {
    const auth = new GoogleAuth();
    const client = await auth.getClient();
    const res = await client.request({
      url: ENDPOINT,
      method: "POST",
      data: payload,
      timeout: 30000 // 30 second timeout
    });
    return res.data;
  } catch (error) {
    console.error("API request failed:", error.message);
    throw error;
  }
}

async function createVectorEmbedding(metadata, dicomBuffer) {
  if (!jsonOutput.useCommonNames) {
    throw new Error("Embeddings generation code relies on jsonOutput.useCommonNames to be true in the configuration.");
  }
  if (!metadata?.SOPClassUID) {
    console.warn("SOPClassUID not found in metadata. Cannot generate vector embedding.");
    return null;
  }
  const sopClassUid = metadata.SOPClassUID;

  let instance;

  if (isImage(sopClassUid)) {
    instance = await processImage(metadata, dicomBuffer);
  } else if (isPdf(sopClassUid)) {
    instance = await processPdf(metadata, dicomBuffer);
  } else if (isStructuredReport(sopClassUid)) {
    instance = await processSR(metadata);
  } else {
    console.error(`SOP Class UID ${sopClassUid} is not supported for vector embedding generation.`);
    return null;
  }

  if (!instance) {
    return null;
  }

  try {
    const response = await doRequest({ instances: [instance] });
    if (response.predictions && response.predictions.length > 0) {
      const embedding = response.predictions[0].imageEmbedding || response.predictions[0].textEmbedding;
      return embedding;
    } else {
      console.error("Failed to get embedding from the model response.");
      return null;
    }
  } catch (e) {
    console.error("Error generating vector embedding:", e);
    return null;
  }
}

module.exports = { createVectorEmbedding, isImage, isPdf, isStructuredReport, SOP_CLASS_UIDS, doRequest };
