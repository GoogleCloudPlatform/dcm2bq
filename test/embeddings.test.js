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
const glob = require("glob").globSync;
const config = require("../src/config");
const { DicomInMemory } = require("../src/dicomtojson");
const sinon = require("sinon");

const testFiles = glob("./test/files/dcm/*.dcm");

describe("embeddings", () => {
  let imageTestData, srTestData, pdfTestData;
  let storageStub, doRequestStub, askGeminiStub;
  let processImage, processPdf, processSR, SOP_CLASS_UIDS, createVectorEmbedding, createEmbeddingInput;

  const findAllTestDataBySopClass = (sopClassUids) => {
    if (!Array.isArray(sopClassUids)) {
      sopClassUids = [sopClassUids];
    }
    const testData = [];
    for (const file of testFiles) {
      const buffer = fs.readFileSync(file);
      try {
        const reader = new DicomInMemory(buffer);
        const metadata = reader.toJson({ useCommonNames: true });
        if (sopClassUids.includes(metadata.SOPClassUID)) {
          testData.push({ buffer, metadata, file });
        }
      } catch (e) {
        // Ignore files that are not DICOM or fail to parse
      }
    }
    return testData;
  };

  before(() => {
    const c = config.get();
    const hasEmbeddingVector = c.gcpConfig.embedding?.input?.vector?.model;
    assert.ok(hasEmbeddingVector, "Embeddings need to be configured (embedding.input.vector.model)");

    // First clear all module caches that might depend on gemini or http-retry
    const geminiPath = require.resolve("../src/gemini");
    const textProcessorPath = require.resolve("../src/processors/text");
    const pdfProcessorPath = require.resolve("../src/processors/pdf");
    const srProcessorPath = require.resolve("../src/processors/sr");
    const imagePath = require.resolve("../src/processors/image");
    const embeddingsPath = require.resolve("../src/embeddings");
    const httpRetryPath = require.resolve("../src/http-retry");
    const storagePath = require.resolve("@google-cloud/storage");
    
    delete require.cache[httpRetryPath];
    delete require.cache[geminiPath];
    delete require.cache[textProcessorPath];
    delete require.cache[pdfProcessorPath];
    delete require.cache[srProcessorPath];
    delete require.cache[imagePath];
    delete require.cache[embeddingsPath];
    delete require.cache[storagePath];

    // Mock Storage class to prevent real GCS operations
    // Create mock file and bucket objects
    const mockFile = {
      save: sinon.stub().resolves(),
      getSignedUrl: sinon.stub().resolves(["gs://mock-bucket/path/to/file"])
    };
    const mockBucket = {
      file: (filePath) => {
        return mockFile;
      }
    };
    
    // Create a mock Storage class that returns our mocked bucket
    const mockStorageClass = function() {
      this.bucket = (bucketName) => {
        return mockBucket;
      };
    };
    
    // Replace the Storage module in require.cache BEFORE embeddings.js is loaded
    const storageModulePath = require.resolve("@google-cloud/storage");
    const originalStorageModule = require.cache[storageModulePath];
    const mockStorageModule = {
      exports: {
        Storage: mockStorageClass,
        Bucket: function() {},
        File: function() {},
      },
    };
    if (originalStorageModule) {
      mockStorageModule.paths = originalStorageModule.paths;
      mockStorageModule.filename = originalStorageModule.filename;
    }
    require.cache[storageModulePath] = mockStorageModule;
    
    // Keep a reference to restore later
    storageStub = { restore: () => {
      if (originalStorageModule) {
        require.cache[storageModulePath] = originalStorageModule;
      } else {
        delete require.cache[storageModulePath];
      }
    }};

    // Stub GoogleGenAI to prevent real Gemini API calls
    const genaiModule = require("@google/genai");
    const mockModels = {
      generateContent: sinon.stub().resolves({ text: "Summarized text" })
    };
    sinon.stub(genaiModule, "GoogleGenAI").returns({
      models: mockModels
    });

    // Stub http-retry's doRequest to prevent real API calls to Vertex AI
    const mockVec = Array.from({ length: 1408 }, (_, i) => Math.sin(i) * 0.001);
    const httpRetryModule = require("../src/http-retry");
    doRequestStub = sinon.stub(httpRetryModule, "doRequest").resolves({
      predictions: [{ imageEmbedding: mockVec, textEmbedding: mockVec }],
    });

    // NOW load the modules that depend on gemini and http-retry (they will use stubbed versions)
    ({ processImage } = require("../src/processors/image"));
    ({ processPdf } = require("../src/processors/pdf"));
    ({ processSR } = require("../src/processors/sr"));
    ({ SOP_CLASS_UIDS, createVectorEmbedding, createEmbeddingInput } = require("../src/embeddings"));

    imageTestData = findAllTestDataBySopClass(SOP_CLASS_UIDS.IMAGE_SOP_CLASSES);
    srTestData = findAllTestDataBySopClass([SOP_CLASS_UIDS.BASIC_TEXT_SR, SOP_CLASS_UIDS.ENHANCED_SR, SOP_CLASS_UIDS.COMPREHENSIVE_SR]);
    pdfTestData = findAllTestDataBySopClass(SOP_CLASS_UIDS.ENCAPSULATED_PDF);
  });

  describe("processors", () => {
    it("should process all DICOM images", async () => {
      for (const { metadata, buffer, file } of imageTestData) {
        const result = await processImage(metadata, buffer);
        assert.ok(result, `processImage failed for ${file}`);
        assert.ok(result.image, `processImage failed for ${file}`);
        assert.ok(result.image.bytesBase64Encoded, `processImage failed for ${file}`);
      }
    });

    it("should process all DICOM SRs", async () => {
      for (const { metadata, file } of srTestData) {
        const result = await processSR(metadata);
        assert.ok(result, `processSR failed for ${file}`);
        assert.ok(result.text, `processSR failed for ${file}`);
      }
    });

    it("should process all DICOM PDFs", async () => {
      for (const { metadata, buffer, file } of pdfTestData) {
        const result = await processPdf(metadata, buffer);
        assert.ok(result, `processPdf failed for ${file}`);
        assert.ok(result.text, `processPdf failed for ${file}`);
      }
    });
  });

  after(() => {
    // Restore stubs - critical to restore Storage stub so it doesn't interfere with other tests
    if (storageStub) {
      storageStub.restore();
    }
    if (doRequestStub) {
      doRequestStub.restore();
    }
    // Restore GoogleGenAI stub
    const genaiModule = require("@google/genai");
    if (genaiModule.GoogleGenAI.restore) {
      genaiModule.GoogleGenAI.restore();
    }
    // Restore module caches
    const geminiPath = require.resolve("../src/gemini");
    const textProcessorPath = require.resolve("../src/processors/text");
    const pdfProcessorPath = require.resolve("../src/processors/pdf");
    const srProcessorPath = require.resolve("../src/processors/sr");
    const httpRetryPath = require.resolve("../src/http-retry");
    const embeddingsPath = require.resolve("../src/embeddings");
    
    delete require.cache[httpRetryPath];
    delete require.cache[geminiPath];
    delete require.cache[textProcessorPath];
    delete require.cache[pdfProcessorPath];
    delete require.cache[srProcessorPath];
    delete require.cache[embeddingsPath];
  });

  describe("createVectorEmbedding", () => {
    it("should generate vector embeddings for all DICOM images", async function () {
      for (const { buffer, metadata, file } of imageTestData) {
        const result = await createVectorEmbedding(metadata, buffer);
        assert.ok(result, `Result should not be null for ${file}`);
        const embedding = result.embedding;
        assert.ok(Array.isArray(embedding), `Embedding should be an array for ${file}`);
        assert.strictEqual(embedding.length, 1408, `Embedding should have 1408 dimensions for ${file}`);
        assert.ok(
          embedding.every((v) => typeof v === "number"),
          `All values in embedding should be numbers for ${file}`
        );
      }
    }).timeout(30000);

    it("should generate vector embeddings for all DICOM SRs", async function () {
      for (const { buffer, metadata, file } of srTestData) {
        const result = await createVectorEmbedding(metadata, buffer);
        assert.ok(result, `Result should not be null for ${file}`);
        const embedding = result.embedding;
        assert.ok(Array.isArray(embedding), `Embedding should be an array for ${file}`);
        assert.strictEqual(embedding.length, 1408, `Embedding should have 1408 dimensions for ${file}`);
        assert.ok(
          embedding.every((v) => typeof v === "number"),
          `All values in embedding should be numbers for ${file}`
        );
      }
    }).timeout(30000);

    it("should generate vector embeddings for all DICOM PDFs", async function () {
      for (const { buffer, metadata, file } of pdfTestData) {
        const result = await createVectorEmbedding(metadata, buffer);
        assert.ok(result, `Result should not be null for ${file}`);
        const embedding = result.embedding;
        assert.ok(Array.isArray(embedding), `Embedding should be an array for ${file}`);
        assert.strictEqual(embedding.length, 1408, `Embedding should have 1408 dimensions for ${file}`);
        assert.ok(
          embedding.every((v) => typeof v === "number"),
          `All values in embedding should be numbers for ${file}`
        );
      }
    }).timeout(30000);

    it("should skip unsupported SOP Class UIDs without throwing", async () => {
      const unsupportedMetadata = {
        SOPClassUID: "9.9.9.9",
        StudyInstanceUID: "1.2.3",
        SeriesInstanceUID: "1.2.3.4",
        SOPInstanceUID: "1.2.3.4.5",
      };

      const callCountBefore = doRequestStub.callCount;
      const result = await createVectorEmbedding(unsupportedMetadata, Buffer.alloc(0));

      assert.strictEqual(result, null, "Unsupported SOP classes should skip embeddings and return null");
      assert.strictEqual(doRequestStub.callCount, callCountBefore, "Vertex AI should not be called for unsupported SOP classes");
    });
  });

  describe("createEmbeddingInput", () => {
    it("should return null for unsupported SOP Class UIDs", async () => {
      const unsupportedMetadata = {
        SOPClassUID: "9.9.9.9",
        StudyInstanceUID: "1.2.3",
        SeriesInstanceUID: "1.2.3.4",
        SOPInstanceUID: "1.2.3.4.5",
      };

      const result = await createEmbeddingInput(unsupportedMetadata, Buffer.alloc(0));
      assert.strictEqual(result, null, "Unsupported SOP classes should not generate embedding input");
    });
  });

  describe("image transfer syntax support", () => {
    const { renderDicomImage } = require("../src/processors/image");
    const dummyBuffer = Buffer.from([0x00]);
    it("should allow supported transfer syntaxes", async () => {
      const supported = [
        "1.2.840.10008.1.2",
        "1.2.840.10008.1.2.1",
        "1.2.840.10008.1.2.1.99",
        "1.2.840.10008.1.2.2",
        "1.2.840.113619.5.2",
        "1.2.840.10008.1.2.5",
        "1.2.840.10008.1.2.4.50",
        "1.2.840.10008.1.2.4.51",
        "1.2.840.10008.1.2.4.57",
        "1.2.840.10008.1.2.4.70",
        "1.2.840.10008.1.2.4.90",
        "1.2.840.10008.1.2.4.91"
      ];
      for (const ts of supported) {
        const result = await renderDicomImage({ TransferSyntaxUID: ts }, dummyBuffer);
        // We expect null because the buffer is not a real DICOM, but not rejected for transfer syntax
        assert.strictEqual(result, null);
      }
    });
    it("should reject unsupported transfer syntaxes", async () => {
      const unsupported = [
        "1.2.840.10008.1.2.4.100", // MPEG2
        "1.2.840.10008.1.2.4.102", // MPEG4
        "1.2.840.10008.1.2.4.999", // made up
        undefined,
        null,
        ""
      ];
      for (const ts of unsupported) {
        const result = await renderDicomImage({ TransferSyntaxUID: ts }, dummyBuffer);
        assert.strictEqual(result, null);
      }
    });
  });
});
