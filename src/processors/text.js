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

async function createTextInstance(text, requireEmbeddingCompatible = false) {
  if (!text) {
    console.log("No text could be extracted from DICOM object.");
    return null;
  }

  // If text is too long for embedding and we need embedding compatibility
  if (requireEmbeddingCompatible && text.length > MAX_TEXT_LENGTH) {
    if (gcpConfig.embeddings.summarizeText.enabled) {
      console.log(`Text length (${text.length}) exceeds MAX_TEXT_LENGTH (${MAX_TEXT_LENGTH}), attempting to summarize...`);
      const embedText = await createEmbedText(text);
      if (embedText) {
        return { text: embedText };
      } else {
        console.error("Failed to summarize text for embedding.");
        return null;
      }
    } else {
      console.error(`Text is too long for embedding (${text.length} > ${MAX_TEXT_LENGTH} characters) and summarization is disabled. Cannot create embedding.`);
      return null;
    }
  }

  // For CLI extraction or short text, return as-is
  return { text };
}

module.exports = { createTextInstance, MAX_TEXT_LENGTH };
