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
const config = require("../config");
const { DicomInMemory } = require("../dicomtojson");
const { processImage } = require("../processors/image");
const { processPdf } = require("../processors/pdf");
const { processSR } = require("../processors/sr");
const { SOP_CLASS_UIDS, createVectorEmbedding } = require("../embeddings");

const testFiles = glob("./test/files/dcm/*.dcm");

describe("embeddings", () => {
  let imageTestData, srTestData, pdfTestData;

  const findTestDataBySopClass = (sopClassUids) => {
    if (!Array.isArray(sopClassUids)) {
      sopClassUids = [sopClassUids];
    }
    for (const file of testFiles) {
      const buffer = fs.readFileSync(file);
      try {
        const reader = new DicomInMemory(buffer);
        const metadata = reader.toJson({ useCommonNames: true });
        if (sopClassUids.includes(metadata.SOPClassUID)) {
          return { buffer, metadata };
        }
      } catch (e) {
        // Ignore files that are not DICOM or fail to parse
      }
    }
    return null;
  };

  before(() => {
    const c = config.get();
    const isEnabled = c.gcpConfig.embeddings.enabled;
    assert.ok(isEnabled, "Embeddings need to be enabled in the config");

    imageTestData = findTestDataBySopClass(SOP_CLASS_UIDS.IMAGE_SOP_CLASSES);
    srTestData = findTestDataBySopClass([
      SOP_CLASS_UIDS.BASIC_TEXT_SR,
      SOP_CLASS_UIDS.ENHANCED_SR,
      SOP_CLASS_UIDS.COMPREHENSIVE_SR,
    ]);
    pdfTestData = findTestDataBySopClass(SOP_CLASS_UIDS.ENCAPSULATED_PDF);
  });
  
  describe("processors", () => {
    it("should process DICOM image", async () => {
      const { buffer } = imageTestData;
      const result = await processImage(buffer);
      assert.ok(result);
      assert.ok(result.image);
      assert.ok(result.image.bytesBase64Encoded);
    });

    it("should process DICOM SR", async () => {
      const { metadata } = srTestData;
      const result = await processSR(metadata);
      assert.ok(result);
      assert.ok(result.text);
    });

    it("should process DICOM PDF", async () => {
      const { metadata, buffer } = pdfTestData;
      const result = await processPdf(metadata, buffer);
      assert.ok(result);
      assert.ok(result.text);
    });
  });

  describe("createVectorEmbedding", () => {
    it("should generate a vector embedding for a DICOM image", async function () {
      const { buffer, metadata } = imageTestData;
      const embedding = await createVectorEmbedding(metadata, buffer);
      assert.ok(embedding, "Embedding should not be null");
      assert.ok(Array.isArray(embedding), "Embedding should be an array");
      assert.strictEqual(embedding.length, 1408, "Embedding should have 1408 dimensions");
      assert.ok(
        embedding.every((v) => typeof v === "number"),
        "All values in embedding should be numbers"
      );
    }).timeout(30000);

    it("should generate a vector embedding for a DICOM SR", async function () {
      const { buffer, metadata } = srTestData;
      const embedding = await createVectorEmbedding(metadata, buffer);
      assert.ok(embedding, "Embedding should not be null");
      assert.ok(Array.isArray(embedding), "Embedding should be an array");
      assert.strictEqual(embedding.length, 1408, "Embedding should have 1408 dimensions");
      assert.ok(
        embedding.every((v) => typeof v === "number"),
        "All values in embedding should be numbers"
      );
    }).timeout(30000);

    it("should generate a vector embedding for a DICOM PDF", async function () {
      const { buffer, metadata } = pdfTestData;
      const embedding = await createVectorEmbedding(metadata, buffer);
      assert.ok(embedding, "Embedding should not be null");
      assert.ok(Array.isArray(embedding), "Embedding should be an array");
      assert.strictEqual(embedding.length, 1408, "Embedding should have 1408 dimensions");
      assert.ok(
        embedding.every((v) => typeof v === "number"),
        "All values in embedding should be numbers"
      );
    }).timeout(30000);
  });
});