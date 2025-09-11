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

const { gcpConfig } = require("../config").get();
const askGemini = require("../gemini");

const MAX_TEXT_LENGTH = 1024; // Max characters for text to be sent for embedding

async function createEmbedText(text) {
  const prompt = `Summarize the following medical text for embedding. Keep it under ${MAX_TEXT_LENGTH} characters and retain important clinical details:\n\n${text}`;
  return await askGemini(prompt);
}

async function createTextInstance(text) {
  if (!text) {
    console.log("No text could be extracted from DICOM object.");
    return null;
  }

  // Summarize if config enables it
  if (gcpConfig.embeddings.summarizeText.enabled) {
    const embedText = await createEmbedText(text);
    if (embedText) {
      return { text: embedText };
    } else {
      console.warn("Failed to summarize text for embedding, skipping.");
      return null;
    }
  } else if (text.length > MAX_TEXT_LENGTH) {
    console.warn("Extracted text is too long for embedding, skipping.");
    return null;
  } else {
    return { text };
  }
}

module.exports = { createTextInstance, MAX_TEXT_LENGTH };
