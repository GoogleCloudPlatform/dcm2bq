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
const { DicomFile } = require("./dicomtojson");
const config = require("./config");
const { HttpServer } = require("./server");
const package = require("../package.json");
const { createVectorEmbedding } = require("./embeddings");

const program = new Command();

program.name(package.name).description(package.description).version(package.version);


const { processImage, renderDicomImage, getFrameIndicesToProcess } = require("./processors/image");
const { processPdf } = require("./processors/pdf");
const { processSR } = require("./processors/sr");

const { isImage, isPdf, isStructuredReport } = require("./embeddings");

program
  .command("extract")
  .description("extract and save rendered image (JPG) or text from a DICOM file")
  .argument("<inputFile>", "file to parse")
  .option("-o, --output <output>", "output file (for image: .jpg, for text: .txt)")
  .option("--summary", "summarize SR or PDF text with Gemini", false)
  .option("--frame <number>", "render a specific frame (0-based index)")
  .option("--all-frames", "render all frames (multi-frame DICOM images)", false)
  .option("--max-frames <number>", "maximum number of frames to render when using --all-frames")
  .action(async (fileName, options) => {
    const requireEmbeddingCompatible = false;
    const { jsonOutput, gcpConfig } = config.get();
    if (options.summary) {
      if (!gcpConfig.embedding) gcpConfig.embedding = {};
      if (!gcpConfig.embedding.input) gcpConfig.embedding.input = {};
      gcpConfig.embedding.input.summarizeText = { model: "gemini-2.5-flash-lite" };
    } else if (gcpConfig.embedding?.input?.summarizeText) {
      delete gcpConfig.embedding.input.summarizeText;
    }
    const fileUrl = url.pathToFileURL(fileName);
    const reader = new DicomFile(fileUrl);
    const metadata = reader.toJson(jsonOutput);
    let outFile = options.output;
    const sopClassUid = metadata?.SOPClassUID;

    if (isImage(sopClassUid)) {
      if (options.allFrames) {
        const numFrames = parseInt(metadata?.NumberOfFrames, 10);
        const frameCount = (!isNaN(numFrames) && numFrames > 1) ? numFrames : 1;
        const maxFrames = options.maxFrames ? parseInt(options.maxFrames, 10) : null;
        const frameIndices = getFrameIndicesToProcess(frameCount, maxFrames);
        let rendered = 0;
        for (const frameIndex of frameIndices) {
          const imageBuffer = await renderDicomImage(metadata, fileName, frameCount > 1 ? frameIndex : null);
          if (imageBuffer) {
            const frameSuffix = frameCount > 1 ? `_frame${frameIndex}` : "";
            const frameOutFile = outFile || fileName.replace(/\.[^.]+$/, `${frameSuffix}.jpg`);
            fs.writeFileSync(frameOutFile, imageBuffer);
            console.log(`Rendered frame ${frameIndex} saved to ${frameOutFile}`);
            rendered++;
          }
        }
        if (rendered === 0) {
          console.error("Could not render any frames from the DICOM file.");
          process.exit(1);
        }
        console.log(`Rendered ${rendered} of ${frameIndices.length} frames`);
        return;
      }

      const frameIndex = options.frame != null ? parseInt(options.frame, 10) : undefined;
      const result = frameIndex != null
        ? await renderDicomImage(metadata, fileName, frameIndex)
        : await processImage(metadata, fileName);
      const jpgBuffer = frameIndex != null
        ? result
        : (result?.image?.bytesBase64Encoded ? Buffer.from(result.image.bytesBase64Encoded, "base64") : null);
      if (jpgBuffer) {
        if (!outFile) outFile = fileName.replace(/\.[^.]+$/, ".jpg");
        fs.writeFileSync(outFile, jpgBuffer);
        console.log(`Rendered image saved to ${outFile}`);
        return;
      }
      console.error("Could not render image from the DICOM file.");
      process.exit(1);
    } else if (isPdf(sopClassUid)) {
      const buffer = fs.readFileSync(fileName);
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
    const { jsonOutput } = config.get();
    const reader = new DicomFile(fileUrl);
    const json = reader.toJson(jsonOutput);
    console.log(JSON.stringify(json));
  });

program
  .command("embed")
  .description("dump embedding(s) to JSON (one per frame for multi-frame images)")
  .argument("<inputFile>", "file to parse")
  .option("--max-frames <number>", "maximum number of frames to embed for multi-frame images")
  .action(async (fileName, options) => {
    const { jsonOutput, gcpConfig } = config.get();
    if (options.maxFrames) {
      if (!gcpConfig.embedding) gcpConfig.embedding = {};
      if (!gcpConfig.embedding.input) gcpConfig.embedding.input = {};
      gcpConfig.embedding.input.maxFrames = parseInt(options.maxFrames, 10);
    }
    const fileUrl = url.pathToFileURL(fileName);
    const reader = new DicomFile(fileUrl);
    const json = reader.toJson(jsonOutput);
    const embeddings = await createVectorEmbedding(json, fileName);
    console.log(JSON.stringify(embeddings));
  });

program
  .command("service")
  .description("run in HTTP service mode")
  .argument("[port]", "port to listen on", process.env.PORT || 8080)
  .action((port) => {
    const server = new HttpServer(port);
    server.start();
  });

program
  .command("index")
  .description("index a local DICOM file or folder by posting synthetic events to a locally running dcm2bq service")
  .argument("<inputPath>", "DICOM file or folder to index (.dcm, .dicom, .zip, .tar.gz, .tgz)")
  .option("--service-url <url>", "URL of the running dcm2bq service (default: $DCM2BQ_SERVICE_URL or http://localhost:8080)")
  .option("--force", "synthesize a fresh generation so unchanged files are reprocessed as new rows", false)
  .option("--watch", "keep watching the folder and index new or changed files", false)
  .action(async (inputPath, options) => {
    const indexCommand = require("./index-command");
    try {
      await indexCommand.execute(inputPath, options);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("process")
  .description("upload a DICOM file to GCS, process via deployed CloudRun, and retrieve results from BigQuery")
  .argument("<inputFile>", "DICOM file to process")
  .option("-c, --config <deploymentConfig>", "path to deployment config file (optional; uses test/testconfig.json if available)")
  .option("--poll-interval <ms>", "polling interval in milliseconds", "2000")
  .option("--poll-timeout <ms>", "maximum polling time in milliseconds (scales with file size)", "60000")
  .option("--poll-timeout-per-mb <ms>", "additional polling time per MB of file size", "10000")
  .action(async (fileName, options) => {
    const processCommand = require("./process-command");
    try {
      await processCommand.execute(fileName, options);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("dlq")
  .description("manage dead letter queue")
  .argument("<action>", "action to perform: 'list' or 'requeue'")
  .option("-c, --config <deploymentConfig>", "path to deployment config file (optional; uses test/testconfig.json if available)")
  .option("--limit <number>", "limit number of items to process", "100")
  .action(async (action, options) => {
    const dlqCommand = require("./dlq-command");
    try {
      await dlqCommand.execute(action, options);
    } catch (error) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program.parse();
