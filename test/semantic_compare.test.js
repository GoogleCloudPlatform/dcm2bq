/*
 Integration test: Compare text and image embeddings using the Vertex AI multimodal endpoint
*/

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createVectorEmbedding, doRequest } = require("../src/embeddings");

// Example: Describe a chest X-ray in text
const anatomyText = "Black and white X-ray of a person's chest from the side. You can see the spine, ribs, and other bones.";
const crDicomPath = path.join(__dirname, "./files/dcm/dx.dcm");

describe("Semantic comparison between text and image embeddings", function () {
  this.timeout(30000); // Allow for API latency

  let textEmbedding, imageEmbedding;

  it("should generate an embedding for the anatomy text", async () => {
    // Use doRequest directly to generate a text embedding
    const response = await doRequest({ instances: [{ text: anatomyText }] });
    assert.ok(response.predictions && response.predictions.length > 0, "Should get predictions from endpoint");
    textEmbedding = response.predictions[0].textEmbedding;
    assert.ok(Array.isArray(textEmbedding), "Text embedding should be an array");
    assert.strictEqual(textEmbedding.length, 1408, "Text embedding should have 1408 dimensions");
  });

  it("should generate an embedding for the CR DICOM image", async () => {
    const buffer = fs.readFileSync(crDicomPath);
    // Extract real DICOM metadata using DicomInMemory
    const { DicomInMemory } = require("../src/dicomtojson");
    const config = require("../src/config");
    const { jsonOutput } = config.get();
    const reader = new DicomInMemory(buffer);
    const metadata = reader.toJson(jsonOutput);
    const result = await createVectorEmbedding(metadata, buffer);
    assert.ok(result, "Result should not be null");
    imageEmbedding = result.embedding;
    assert.ok(Array.isArray(imageEmbedding), "Image embedding should be an array");
    assert.strictEqual(imageEmbedding.length, 1408, "Image embedding should have 1408 dimensions");
  });

  it("should have a high cosine similarity between the text and image embeddings", () => {
    function cosineSimilarity(a, b) {
      const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
      const normA = Math.sqrt(a.reduce((sum, v) => sum + v * v, 0));
      const normB = Math.sqrt(b.reduce((sum, v) => sum + v * v, 0));
      return dot / (normA * normB);
    }
    const similarity = cosineSimilarity(textEmbedding, imageEmbedding);
    console.log("Cosine similarity between text and image:", similarity);
    // For a matching description and image, expect similarity > 0.15 (empirical, may vary)
    assert.ok(similarity > 0.15, `Expected similarity > 0.15, got ${similarity}`);
  });
});
