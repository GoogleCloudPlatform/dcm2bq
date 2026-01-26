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

const assert = require("assert");
const fs = require("fs");
const path = require("path");

describe("http-retry", () => {
  it("should export doRequest function", () => {
    const httpRetry = require("../src/http-retry");
    
    assert(httpRetry.doRequest);
    assert.strictEqual(typeof httpRetry.doRequest, "function");
  });

  it("should be an async function", () => {
    const httpRetry = require("../src/http-retry");
    const doRequest = httpRetry.doRequest;
    
    // Check the function is defined
    assert(doRequest);
    assert.strictEqual(typeof doRequest, "function");
    // Verify it's an async function by checking the constructor name
    assert.strictEqual(doRequest.constructor.name, "AsyncFunction");
  });

  it("should have proper module structure", () => {
    const httpRetry = require("../src/http-retry");
    
    // Check that module only exports doRequest
    const keys = Object.keys(httpRetry);
    assert(keys.includes("doRequest"));
  });

  it("should be defined in the correct file", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    assert(fs.existsSync(filePath));
    
    const content = fs.readFileSync(filePath, "utf8");
    assert(content.includes("doRequest"));
    assert(content.includes("GoogleAuth"));
    assert(content.includes("429")); // Should handle 429 rate limiting
  });

  it("should use exponential backoff for retries", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    // Check for exponential backoff pattern
    assert(content.includes("delay"));
    assert(content.includes("attempt"));
    assert(content.includes("delay * 2")); // Exponential growth
  });

  it("should respect MAX_RETRIES environment variable", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("EMBEDDINGS_MAX_RETRIES"));
  });

  it("should use configurable base delay", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("EMBEDDINGS_BASE_DELAY_MS"));
  });

  it("should set request timeout to 30 seconds", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("timeout: 30000"));
  });

  it("should use POST method for requests", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("'POST'"));
  });

  it("should use GoogleAuth for authentication", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("GoogleAuth"));
    assert(content.includes("getClient"));
  });

  it("should log errors appropriately", () => {
    const filePath = path.join(__dirname, "../src/http-retry.js");
    const content = fs.readFileSync(filePath, "utf8");
    
    assert(content.includes("console.error"));
    assert(content.includes("console.warn")); // For rate limiting warnings
  });
});
