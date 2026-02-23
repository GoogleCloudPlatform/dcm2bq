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

function isRetryableGeminiError(error) {
  const status = error?.status || error?.code || error?.response?.status;
  const message = String(error?.message || "");

  return (
    status === 429 ||
    status === "RESOURCE_EXHAUSTED" ||
    message.includes("429") ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("Resource exhausted")
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function askGemini(contents) {
  const MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || "5", 10);
  const BASE_DELAY_MS = parseInt(process.env.GEMINI_BASE_DELAY_MS || "500", 10);

  let attempt = 0;
  let delay = BASE_DELAY_MS;

  while (true) {
    try {
      const response = await ai.models.generateContent({
        model: gcpConfig.embedding?.input?.summarizeText?.model || "gemini-2.5-flash-lite",
        config: {
          temperature: 0,
          thinkingConfig: {
            thinkingBudget: 0,
          },
        },
        contents,
      });
      return response.text;
    } catch (error) {
      if (isRetryableGeminiError(error) && attempt < MAX_RETRIES) {
        attempt += 1;
        const jitter = Math.floor(Math.random() * delay);
        const sleepMs = delay + jitter;
        console.warn(`Gemini request received 429/RESOURCE_EXHAUSTED; retry ${attempt}/${MAX_RETRIES} in ${sleepMs}ms`);
        await sleep(sleepMs);
        delay = delay * 2;
        continue;
      }
      throw error;
    }
  }
}

module.exports = askGemini;
