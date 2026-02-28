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

const pdfParseModule = require("pdf-parse");
const { parseBulkDataUri } = require("../dicomtojson");
const { createTextInstance } = require("./text");

// Handle both pdf-parse v1.x (function) and v2.x (PDFParse class)
async function parsePdf(pdfBuffer) {
  // Check if v2.x (PDFParse class exists)
  if (pdfParseModule.PDFParse) {
    const parser = new pdfParseModule.PDFParse({ data: pdfBuffer });
    const result = await parser.getText();
    return { text: result.text };
  }
  // v1.x (function)
  return await pdfParseModule(pdfBuffer);
}

async function processPdf(metadata, dicomBuffer, requireEmbeddingCompatible = false) {
  if (!metadata.EncapsulatedDocument) {
    console.warn("Encapsulated PDF SOP Class UID found, but no (0042,0011) tag present.");
    return null;
  }

  const bulkDataUri = parseBulkDataUri(metadata.EncapsulatedDocument.BulkDataURI);
  const offset = bulkDataUri.offset;
  const length = metadata.EncapsulatedDocumentLength || bulkDataUri.length;

  if (!offset || !length) {
    console.warn("Could not determine offset/length of encapsulated PDF data.");
    return null;
  }

  const pdfBuffer = Buffer.from(dicomBuffer, offset, length);
  const data = await parsePdf(pdfBuffer);
  return await createTextInstance(data.text, requireEmbeddingCompatible);
}

module.exports = { processPdf };
