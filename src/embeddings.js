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

const { Storage } = require("@google-cloud/storage");
const { gcpConfig, jsonOutput } = require("./config").get();
const { DEBUG_MODE } = require("./utils");
const { processImage } = require("./processors/image");
const { processPdf } = require("./processors/pdf");
const { processSR } = require("./processors/sr");

const storage = new Storage();

// --- Configuration ---
function createEndpoint(config) {
  const model = config.embedding?.input?.vector?.model;
  if (!model) {
    throw new Error("embedding.input.vector.model is required for embedding generation");
  }
  return `https://us-central1-aiplatform.googleapis.com/v1/projects/${config.projectId}/locations/us-central1/publishers/google/models/${model}:predict`;
}

function getEndpoint() {
  return createEndpoint(gcpConfig);
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

const { doRequest: httpDoRequest } = require('./http-retry');

// wrapper kept for backwards compatibility with existing callers
async function doRequest(payload) {
  return httpDoRequest(getEndpoint(), payload);
}

/**
 * Saves extracted image or text data to a GCS bucket.
 * @param {Buffer|string} data - The data to save (image buffer or text content)
 * @param {string} fileName - The file path within the bucket (e.g., 'study/series/instance.jpg')
 * @param {string} contentType - The MIME type of the file
 * @param {string} subDirectory - Optional subdirectory within the base path (e.g., 'processed')
 */
async function saveToGCS(data, fileName, contentType, subDirectory = '') {
  const gcsBucketPath = gcpConfig.embedding?.input?.gcsBucketPath;
  
  if (!gcsBucketPath) {
    console.warn("gcpConfig.embedding.input.gcsBucketPath is not configured. Skipping file save to GCS.");
    return;
  }

  try {
    // Extract bucket name from GCS path (e.g., 'gs://bucket-name' from 'gs://bucket-name/path')
    const bucketMatch = gcsBucketPath.match(/^gs:\/\/([^\/]+)/);
    if (!bucketMatch) {
      console.error("Invalid GCS bucket path format. Expected 'gs://bucket-name/path'.");
      return;
    }

    const bucketName = bucketMatch[1];
    // Remove the bucket prefix (gs://bucket-name) to get the base path
    const bucketPrefix = `gs://${bucketName}`;
    let basePath = gcsBucketPath.substring(bucketPrefix.length).replace(/^\//, "") || "";
    
    // Build full path with optional subdirectory
    let fullPath = basePath;
    if (subDirectory) {
      fullPath = fullPath ? `${fullPath}/${subDirectory}` : subDirectory;
    }
    fullPath = fullPath ? `${fullPath}/${fileName}` : fileName;

    const file = storage.bucket(bucketName).file(fullPath);
    await file.save(data, {
      contentType: contentType,
      resumable: false,
    });

    const gcsUri = `gs://${bucketName}/${fullPath}`;
    if (DEBUG_MODE) {
      console.log(`Saved file to ${gcsUri}`);
    }
    return gcsUri;
  } catch (error) {
    console.error(`Error saving file to GCS: ${error.message}`);
    return null;
  }
}

/**
 * Creates embedding input from DICOM metadata and buffer.
 * Extracts text or images and optionally saves them to GCS.
 * @param {Object} metadata - DICOM metadata JSON
 * @param {Buffer} dicomBuffer - Raw DICOM file buffer
 * @returns {Promise<{instance: Object, objectPath: string|null, objectSize: number|null, objectMimeType: string|null}|null>}
 */
async function createEmbeddingInput(metadata, dicomBuffer) {
  if (!jsonOutput.useCommonNames) {
    throw new Error("Embeddings generation code relies on jsonOutput.useCommonNames to be true in the configuration.");
  }
  if (!metadata?.SOPClassUID) {
    console.warn("SOPClassUID not found in metadata. Cannot create embedding input.");
    return null;
  }
  const sopClassUid = metadata.SOPClassUID;

  let instance;
  let objectPath = null;
  let objectSize = null;
  let objectMimeType = null;
  const studyUid = metadata.StudyInstanceUID || "unknown";
  const seriesUid = metadata.SeriesInstanceUID || "unknown";
  const instanceUid = metadata.SOPInstanceUID || "unknown";

  if (isImage(sopClassUid)) {
    instance = await processImage(metadata, dicomBuffer);
    if (instance?.image?.bytesBase64Encoded) {
      const imageBuffer = Buffer.from(instance.image.bytesBase64Encoded, 'base64');
      const fileName = `${studyUid}/${seriesUid}/${instanceUid}.jpg`;
      objectPath = await saveToGCS(imageBuffer, fileName, 'image/jpeg', '');
      objectSize = imageBuffer.length;
      objectMimeType = 'image/jpeg';
    }
  } else if (isPdf(sopClassUid)) {
    instance = await processPdf(metadata, dicomBuffer);
    if (instance?.text) {
      const textBuffer = Buffer.isBuffer(instance.text) ? instance.text : Buffer.from(instance.text);
      const fileName = `${studyUid}/${seriesUid}/${instanceUid}.txt`;
      objectPath = await saveToGCS(textBuffer, fileName, 'text/plain', '');
      objectSize = textBuffer.length;
      objectMimeType = 'text/plain';
    }
  } else if (isStructuredReport(sopClassUid)) {
    instance = await processSR(metadata);
    if (instance?.text) {
      const textBuffer = Buffer.isBuffer(instance.text) ? instance.text : Buffer.from(instance.text);
      const fileName = `${studyUid}/${seriesUid}/${instanceUid}.txt`;
      objectPath = await saveToGCS(textBuffer, fileName, 'text/plain', '');
      objectSize = textBuffer.length;
      objectMimeType = 'text/plain';
    }
  } else {
    console.error(`SOP Class UID ${sopClassUid} is not supported for embedding input generation.`);
    return null;
  }

  if (!instance) {
    return null;
  }

  return { instance, objectPath, objectSize, objectMimeType };
}

async function createVectorEmbedding(metadata, dicomBuffer) {
  const inputResult = await createEmbeddingInput(metadata, dicomBuffer);
  if (!inputResult) {
    return null;
  }

  const { instance, objectPath, objectSize, objectMimeType } = inputResult;

  try {
    const response = await doRequest({ instances: [instance] });
    if (response.predictions && response.predictions.length > 0) {
      const vectorEmbedding = response.predictions[0].imageEmbedding || response.predictions[0].textEmbedding;
      return { embedding: vectorEmbedding, objectPath, objectSize, objectMimeType };
    } else {
      console.error("Failed to get embedding from the model response.");
      return null;
    }
  } catch (e) {
    console.error("Error generating vector embedding:", e);
    return null;
  }
}

module.exports = { createVectorEmbedding, createEmbeddingInput, isImage, isPdf, isStructuredReport, SOP_CLASS_UIDS, doRequest, saveToGCS };
