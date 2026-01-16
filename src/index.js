#!/usr/bin/env node

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

// TODO: Try to improve startup time, when running as CLI. Tested time: ~400ms

const url = require("url");
const fs = require("fs");
const { Command } = require("commander");
const { DicomFile, DicomInMemory } = require("./dicomtojson");
const config = require("./config");
const { HttpServer } = require("./server");
const package = require("../package.json");
const { createVectorEmbedding } = require("./embeddings");

const program = new Command();

program.name(package.name).description(package.description).version(package.version);


const { processImage } = require("./processors/image");
const { processPdf } = require("./processors/pdf");
const { processSR } = require("./processors/sr");

const { isImage, isPdf, isStructuredReport } = require("./embeddings");

program
  .command("extract")
  .description("extract and save rendered image (JPG) or text from a DICOM file")
  .argument("<inputFile>", "file to parse")
  .option("-o, --output <output>", "output file (for image: .jpg, for text: .txt)")
  .option("--summary", "summarize SR or PDF text with Gemini", false)
  .action(async (fileName, options) => {
    let requireEmbeddingCompatible = false;
    const { jsonOutput, gcpConfig } = config.get();
    // Set summarization config based on CLI
    requireEmbeddingCompatible = !!options.summary;
    if (options.summary) {
      if (!gcpConfig.embedding) gcpConfig.embedding = {};
      if (!gcpConfig.embedding.input) gcpConfig.embedding.input = {};
      gcpConfig.embedding.input.summarizeText = { model: "gemini-2.5-flash-lite" };
    } else if (gcpConfig.embedding?.input?.summarizeText) {
      delete gcpConfig.embedding.input.summarizeText;
    }
    const buffer = fs.readFileSync(fileName);
    const reader = new DicomInMemory(buffer);
    const metadata = reader.toJson(jsonOutput);
    let outFile = options.output;
    const sopClassUid = metadata?.SOPClassUID;

    if (isImage(sopClassUid)) {
      const result = await processImage(metadata, buffer);
      if (result && result.image && result.image.bytesBase64Encoded) {
        const jpgBuffer = Buffer.from(result.image.bytesBase64Encoded, "base64");
        if (!outFile) outFile = fileName.replace(/\.[^.]+$/, ".jpg");
        fs.writeFileSync(outFile, jpgBuffer);
        console.log(`Rendered image saved to ${outFile}`);
        return;
      }
      console.error("Could not render image from the DICOM file.");
      process.exit(1);
    } else if (isPdf(sopClassUid)) {
      const result = await processPdf(metadata, buffer, requireEmbeddingCompatible);
      if (result && result.text) {
        if (!outFile) outFile = fileName.replace(/\.[^.]+$/, ".txt");
        fs.writeFileSync(outFile, result.text, "utf8");
        console.log(`Extracted text saved to ${outFile}`);
        return;
      }
      console.error("Could not extract text from the DICOM PDF file.");
      process.exit(1);
    } else if (isStructuredReport(sopClassUid)) {
      const result = await processSR(metadata, requireEmbeddingCompatible);
      if (result && result.text) {
        if (!outFile) outFile = fileName.replace(/\.[^.]+$/, ".txt");
        fs.writeFileSync(outFile, result.text, "utf8");
        console.log(`Extracted text saved to ${outFile}`);
        return;
      }
      console.error("Could not extract text from the DICOM SR file.");
      process.exit(1);
    } else {
      console.error("Unsupported or unknown SOP Class UID for extraction.");
      process.exit(1);
    }
  });

program
  .command("dump")
  .description("dump file to JSON")
  .argument("<inputFile>", "file to parse")
  .action((fileName) => {
    const fileUrl = new URL(url.pathToFileURL(fileName));
    const { dicomParser, jsonOutput } = config.get();
    const reader = new DicomFile(fileUrl, dicomParser);
    const json = reader.toJson(jsonOutput);
    console.log(JSON.stringify(json));
  });

program
  .command("embed")
  .description("dump embedding to JSON")
  .argument("<inputFile>", "file to parse")
  .action(async (fileName) => {
    const { jsonOutput } = config.get();
    const buffer = fs.readFileSync(fileName);
    const reader = new DicomInMemory(buffer);
    const json = reader.toJson(jsonOutput);
    const embedding = await createVectorEmbedding(json, buffer);
    console.log(JSON.stringify(embedding));
  });

program
  .command("service")
  .description("run in HTTP service mode")
  .argument("[port]", "port to listen on", process.env.PORT || 8080)
  .action((port) => {
    const server = new HttpServer(port);
    server.start();
  });

program.parse();
