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

const { GoogleGenAI } = require("@google/genai");
const { gcpConfig } = require("./config").get();

const ai = new GoogleGenAI({
  vertexai: true,
  project: gcpConfig.projectId,
  location: gcpConfig.location || "us-central1",
});

async function askGemini(contents) {
  // Set the config below to use temperature: 0
  const response = await ai.models.generateContent({
    model: gcpConfig.embeddings.summarizeText.model || "gemini-2.5-flash-lite",
    config: {
      temperature: 0,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
    contents,
  });
  return response.text;
}

module.exports = askGemini;
