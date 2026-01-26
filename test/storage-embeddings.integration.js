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

/*
 Integration test: Storage and Embedding features with real GCP services
 
 Prerequisites:
 - Run ./helpers/deploy.sh to create GCP resources and test/testconfig.json
 - Authenticate with GCP: gcloud auth application-default login
 - Ensure embedding.input.gcsBucketPath is configured
 
 Run with: DCM2BQ_CONFIG_FILE=test/testconfig.json mocha test/storage-embeddings.integration.js
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const config = require("../src/config");
const { createVectorEmbedding, saveToGCS } = require("../src/embeddings");
const { DicomInMemory } = require("../src/dicomtojson");
const { processImage } = require("../src/processors/image");
const { processSR } = require("../src/processors/sr");
const { processPdf } = require("../src/processors/pdf");

describe("Storage and Embedding Integration Tests", function () {
  this.timeout(60000); // Allow time for API calls

  let storage;
  let gcpConfig;
  let testBucket;
  let uploadedFiles = [];

  before(function () {
    const conf = config.get();
    gcpConfig = conf.gcpConfig;
    
    // Verify we have a real config (not test config)
    if (gcpConfig.projectId === "test-project-12345") {
      this.skip(); // Skip if running with mock config
    }

    // Verify embeddings are configured
    if (!gcpConfig.embedding?.input?.vector?.model) {
      console.log("  ⚠ Skipping embedding tests - embeddings not configured");
      this.skip();
    }

    storage = new Storage({ projectId: gcpConfig.projectId });

    // Extract bucket name from gcsBucketPath if configured
    if (gcpConfig.embedding?.input?.gcsBucketPath) {
      const match = gcpConfig.embedding.input.gcsBucketPath.match(/^gs:\/\/([^\/]+)/);
      if (match) {
        testBucket = storage.bucket(match[1]);
      }
    }
  });

  after(async function () {
    // Clean up uploaded test files
    if (testBucket && uploadedFiles.length > 0) {
      console.log(`\nCleaning up ${uploadedFiles.length} test files from GCS...`);
      for (const fileName of uploadedFiles) {
        try {
          await testBucket.file(fileName).delete();
          console.log(`  Deleted: ${fileName}`);
        } catch (err) {
          if (err.code !== 404) {
            console.error(`  Failed to delete ${fileName}:`, err.message);
          }
        }
      }
    }
  });

  describe("Image Processing and Embedding", function () {
    it("should process and embed a CT image", async function () {
      const testFile = path.join(__dirname, "files/dcm/ct.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      const result = await createVectorEmbedding(metadata, buffer);
      
      assert.ok(result, "Should return embedding result");
      assert.ok(result.embedding, "Result should have embedding");
      assert.ok(Array.isArray(result.embedding), "Embedding should be an array");
      assert.strictEqual(result.embedding.length, 1408, "Embedding should have 1408 dimensions");
      
      // Verify all values are numbers
      assert.ok(result.embedding.every(v => typeof v === "number"), "All embedding values should be numbers");
      
      // Verify embedding values are in reasonable range
      const min = Math.min(...result.embedding);
      const max = Math.max(...result.embedding);
      assert.ok(min >= -1 && max <= 1, "Embedding values should be normalized");

      console.log(`  ✓ Generated embedding for CT image (${result.embedding.length} dimensions)`);
      
      if (result.objectPath) {
        console.log(`  ✓ Saved processed image to: ${result.objectPath}`);
        // Track for cleanup
        const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
        if (match) {
          uploadedFiles.push(match[1]);
        }
      }
    });

    it("should process and embed an MR image", async function () {
      const testFile = path.join(__dirname, "files/dcm/mr.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      const result = await createVectorEmbedding(metadata, buffer);
      
      assert.ok(result, "Should return embedding result");
      assert.strictEqual(result.embedding.length, 1408, "Embedding should have 1408 dimensions");

      console.log(`  ✓ Generated embedding for MR image`);
      
      if (result.objectPath) {
        const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
        if (match) {
          uploadedFiles.push(match[1]);
        }
      }
    });

    it("should process and embed an ultrasound image", async function () {
      const testFile = path.join(__dirname, "files/dcm/us.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      const result = await createVectorEmbedding(metadata, buffer);
      
      assert.ok(result, "Should return embedding result");
      assert.strictEqual(result.embedding.length, 1408, "Embedding should have 1408 dimensions");

      console.log(`  ✓ Generated embedding for ultrasound image`);
      
      if (result.objectPath) {
        const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
        if (match) {
          uploadedFiles.push(match[1]);
        }
      }
    });
  });

  describe("Text Processing and Embedding", function () {
    it("should process and embed a structured report", async function () {
      const testFile = path.join(__dirname, "files/dcm/sr.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      const result = await createVectorEmbedding(metadata, buffer);
      
      assert.ok(result, "Should return embedding result");
      assert.ok(result.embedding, "Result should have embedding");
      assert.strictEqual(result.embedding.length, 1408, "Embedding should have 1408 dimensions");

      console.log(`  ✓ Generated embedding for structured report`);
      
      if (result.objectPath) {
        const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
        if (match) {
          uploadedFiles.push(match[1]);
        }
      }
    });

    it("should process and embed a PDF document", async function () {
      // Check if we have summarization configured (needed for long text)
      if (!gcpConfig.embedding?.input?.summarizeText?.model) {
        this.skip();
      }

      const testFile = path.join(__dirname, "files/dcm/pdf.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      const result = await createVectorEmbedding(metadata, buffer);
      
      assert.ok(result, "Should return embedding result");
      assert.ok(result.embedding, "Result should have embedding");
      assert.strictEqual(result.embedding.length, 1408, "Embedding should have 1408 dimensions");

      console.log(`  ✓ Generated embedding for PDF document`);
      
      if (result.objectPath) {
        const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
        if (match) {
          uploadedFiles.push(match[1]);
        }
      }
    });
  });

  describe("GCS Storage Operations", function () {
    it("should save processed image to GCS", async function () {
      if (!testBucket) {
        this.skip();
      }

      const testFile = path.join(__dirname, "files/dcm/dx.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      // Process the image
      const imageResult = await processImage(metadata, buffer);
      
      assert.ok(imageResult, "Should process image");
      assert.ok(imageResult.image, "Should have image data");
      assert.ok(imageResult.image.bytesBase64Encoded, "Should have base64 encoded image");

      // Decode and save to GCS
      const imageBuffer = Buffer.from(imageResult.image.bytesBase64Encoded, "base64");
      const fileName = `test-${Date.now()}-dx.jpg`;
      
      await saveToGCS(imageBuffer, fileName, "image/jpeg", "test");
      
      // Track for cleanup
      // Extract the path after the bucket name (if any)
      const bucketMatch = gcpConfig.embedding.input.gcsBucketPath.match(/^gs:\/\/[^\/]+(\/(.*))?$/);
      const basePath = bucketMatch && bucketMatch[2] ? bucketMatch[2] : "";
      const fullPath = basePath ? `${basePath}/test/${fileName}` : `test/${fileName}`;
      uploadedFiles.push(fullPath);

      // Verify file exists in GCS
      const file = testBucket.file(fullPath);
      const [exists] = await file.exists();
      
      assert.ok(exists, "File should exist in GCS");

      // Verify file content
      const [downloadedBuffer] = await file.download();
      assert.strictEqual(downloadedBuffer.length, imageBuffer.length, "File size should match");

      console.log(`  ✓ Saved and verified image in GCS: ${fullPath}`);
    });

    it("should save processed text to GCS", async function () {
      if (!testBucket) {
        this.skip();
      }

      const testFile = path.join(__dirname, "files/dcm/sr.dcm");
      const buffer = fs.readFileSync(testFile);
      
      const reader = new DicomInMemory(buffer);
      const metadata = reader.toJson({ useCommonNames: true });

      // Process the structured report
      const textResult = await processSR(metadata);
      
      assert.ok(textResult, "Should process SR");
      assert.ok(textResult.text, "Should have extracted text");

      // Save text to GCS
      const fileName = `test-${Date.now()}-sr.txt`;
      
      await saveToGCS(textResult.text, fileName, "text/plain", "test");
      
      // Track for cleanup
      // Extract the path after the bucket name (if any)
      const bucketMatch = gcpConfig.embedding.input.gcsBucketPath.match(/^gs:\/\/[^\/]+(\/(.*))?$/);
      const basePath = bucketMatch && bucketMatch[2] ? bucketMatch[2] : "";
      const fullPath = basePath ? `${basePath}/test/${fileName}` : `test/${fileName}`;
      uploadedFiles.push(fullPath);

      // Verify file exists in GCS
      const file = testBucket.file(fullPath);
      const [exists] = await file.exists();
      
      assert.ok(exists, "File should exist in GCS");

      // Verify file content
      const [downloadedBuffer] = await file.download();
      const downloadedText = downloadedBuffer.toString("utf8");
      assert.strictEqual(downloadedText, textResult.text, "Text content should match");

      console.log(`  ✓ Saved and verified text in GCS: ${fullPath}`);
    });
  });

  describe("Embedding Quality", function () {
    it("should generate different embeddings for different images", async function () {
      const files = ["ct.dcm", "mr.dcm"];
      const embeddings = [];

      for (const filename of files) {
        const testFile = path.join(__dirname, "files/dcm", filename);
        const buffer = fs.readFileSync(testFile);
        
        const reader = new DicomInMemory(buffer);
        const metadata = reader.toJson({ useCommonNames: true });

        const result = await createVectorEmbedding(metadata, buffer);
        embeddings.push(result.embedding);
        
        if (result.objectPath) {
          const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
          if (match) {
            uploadedFiles.push(match[1]);
          }
        }
      }

      // Calculate cosine similarity
      function cosineSimilarity(a, b) {
        const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
        const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
        const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
        return dot / (normA * normB);
      }

      const similarity = cosineSimilarity(embeddings[0], embeddings[1]);
      
      // Different images should have different embeddings (similarity < 1.0)
      assert.ok(similarity < 1.0, `Embeddings should differ (similarity: ${similarity.toFixed(4)})`);
      
      // But they should still have some similarity (both are medical images)
      assert.ok(similarity > 0, `Embeddings should have positive similarity (got: ${similarity.toFixed(4)})`);

      console.log(`  ✓ Cosine similarity between CT and MR: ${similarity.toFixed(4)}`);
    });

    it("should generate embeddings with consistent dimensions across modalities", async function () {
      const files = ["ct.dcm", "sr.dcm", "dx.dcm"];
      const dimensions = [];

      for (const filename of files) {
        const testFile = path.join(__dirname, "files/dcm", filename);
        const buffer = fs.readFileSync(testFile);
        
        const reader = new DicomInMemory(buffer);
        const metadata = reader.toJson({ useCommonNames: true });

        const result = await createVectorEmbedding(metadata, buffer);
        dimensions.push(result.embedding.length);
        
        if (result.objectPath) {
          const match = result.objectPath.match(/gs:\/\/[^\/]+\/(.*)/);
          if (match) {
            uploadedFiles.push(match[1]);
          }
        }
      }

      // All embeddings should have the same dimensions
      assert.ok(dimensions.every(d => d === 1408), 
        `All embeddings should have 1408 dimensions (got: ${dimensions.join(", ")})`);

      console.log(`  ✓ All embeddings have consistent dimensions: 1408`);
    });
  });
});
