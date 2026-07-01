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

const { execFile } = require("child_process");
const { mkdtemp, writeFile, readFile, readdir, rm } = require("fs/promises");
const path = require("path");
const os = require("os");

// TODO[P1]: Replace shell wrapper with direct in-process rendering if a stable library becomes available.

// Supported transfer syntaxes for image rendering
const SUPPORTED_TRANSFER_SYNTAXES = new Set([
  // Uncompressed
  "1.2.840.10008.1.2",           // Implicit VR - Little Endian
  "1.2.840.10008.1.2.1",         // Explicit VR - Little Endian
  "1.2.840.10008.1.2.1.99",      // Deflated Explicit VR - Little Endian
  "1.2.840.10008.1.2.2",         // Explicit VR - Big Endian
  "1.2.840.113619.5.2",          // Implicit VR - Big Endian (G.E Private)
  // RLE
  "1.2.840.10008.1.2.5",         // Run Length Encoding, Lossless
  // JPEG
  "1.2.840.10008.1.2.4.50",      // JPEG Baseline (Process 1)
  "1.2.840.10008.1.2.4.51",      // JPEG Extended (Process 2 & 4)
  "1.2.840.10008.1.2.4.57",      // JPEG Lossless, Non-Hierarchical (Process 14)
  "1.2.840.10008.1.2.4.70",      // JPEG Lossless, Hierarchical, First-Order Prediction (Process 14, [Selection Value 1])
  "1.2.840.10008.1.2.4.90",      // JPEG 2000 Image Compression (Lossless Only)
  "1.2.840.10008.1.2.4.91"       // JPEG 2000 Image Compression
]);

/**
 * Returns an array of 0-based frame indices to process.
 * If maxFrames is null or numFrames <= maxFrames, returns all indices.
 * Otherwise evenly samples maxFrames indices across the range.
 */
function getFrameIndicesToProcess(numFrames, maxFrames) {
  if (!numFrames || numFrames <= 1) return [0];
  if (maxFrames != null && maxFrames <= 1 && maxFrames > 0) return [0];
  const indices = [];
  if (maxFrames != null && numFrames > maxFrames && maxFrames > 1) {
    for (let i = 0; i < maxFrames; i++) {
      indices.push(Math.round(i * (numFrames - 1) / (maxFrames - 1)));
    }
  } else {
    for (let i = 0; i < numFrames; i++) {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Renders a DICOM image to a JPG buffer by wrapping the convert_dcm_to_jpg.sh script.
 * This requires dcmnorm to be installed in the execution environment.
 * @param {Object} metadata - DICOM metadata JSON
 * @param {Buffer|string} dicomInput - Raw DICOM file buffer or local DICOM file path
 * @param {number|null} frameIndex - 0-based frame index to render (null = auto-select middle frame)
 */
async function renderDicomImage(metadata, dicomInput, frameIndex) {
  const transferSyntax = metadata && metadata.TransferSyntaxUID;
  if (!transferSyntax || !SUPPORTED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    console.error(`Unsupported transfer syntax: ${transferSyntax || 'unknown'}`);
    return null;
  }

  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-"));
    const dicomPath = typeof dicomInput === "string" ? dicomInput : path.join(tempDir, "input.dcm");
    const jpgPath = path.join(tempDir, "output.jpg");
    const scriptPath = path.resolve(__dirname, "..", "..", "helpers", "convert_dcm_to_jpg.sh");

    if (Buffer.isBuffer(dicomInput)) {
      await writeFile(dicomPath, dicomInput);
    } else if (typeof dicomInput !== "string") {
      throw new Error("Expected dicom input to be a file path or Buffer");
    }

    let frameArg = null;
    if (frameIndex != null) {
      frameArg = frameIndex;
    } else {
      const numFrames = parseInt(metadata?.NumberOfFrames, 10);
      if (!isNaN(numFrames) && numFrames > 1) {
        frameArg = Math.floor((numFrames - 1) / 2);
      }
    }

    const args = [dicomPath, jpgPath];
    if (frameArg !== null) {
      args.push(frameArg.toString());
    }

    await new Promise((resolve, reject) => {
      execFile(scriptPath, args, (error, stdout, stderr) => {
        if (error) {
          console.error(JSON.stringify({
            message: "convert_dcm_to_jpg.sh execution failed",
            stderr,
          }));
          const enhancedError = new Error(error.message);
          enhancedError.cause = error;
          enhancedError.stderr = stderr;
          return reject(enhancedError);
        }
        resolve(stdout);
      });
    });

    const jpgBuffer = await readFile(jpgPath);
    return jpgBuffer;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not render DICOM image for embedding using dcmnorm renderer",
      error: error?.message || String(error),
      stderr: error?.stderr || null,
    }));
    return null;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((cleanupError) =>
        console.error(`Failed to clean up temporary directory ${tempDir}: ${cleanupError?.message || String(cleanupError)}`)
      );
    }
  }
}

/**
 * Renders all frames of a multi-frame DICOM file in a single dcmnorm invocation.
 * Returns an array of {frameIndex, buffer} sorted by frame index.
 * Only the frames in frameIndices are returned (others are discarded).
 */
async function renderAllDicomFrames(metadata, dicomInput, frameIndices) {
  const transferSyntax = metadata && metadata.TransferSyntaxUID;
  if (!transferSyntax || !SUPPORTED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    console.error(`Unsupported transfer syntax: ${transferSyntax || 'unknown'}`);
    return [];
  }

  let tempDir;
  try {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-all-"));
    const dicomPath = typeof dicomInput === "string" ? dicomInput : path.join(tempDir, "input.dcm");
    const jpgPath = path.join(tempDir, "output.jpg");
    const scriptPath = path.resolve(__dirname, "..", "..", "helpers", "convert_dcm_to_jpg.sh");

    if (Buffer.isBuffer(dicomInput)) {
      await writeFile(dicomPath, dicomInput);
    } else if (typeof dicomInput !== "string") {
      throw new Error("Expected dicom input to be a file path or Buffer");
    }

    await new Promise((resolve, reject) => {
      execFile(scriptPath, [dicomPath, jpgPath, "--all-frames"], (error, stdout, stderr) => {
        if (error) {
          console.error(JSON.stringify({
            message: "convert_dcm_to_jpg.sh --all-frames execution failed",
            stderr,
          }));
          const enhancedError = new Error(error.message);
          enhancedError.cause = error;
          enhancedError.stderr = stderr;
          return reject(enhancedError);
        }
        resolve(stdout);
      });
    });

    // dcmnorm produces files like output_000001.jpg, output_000002.jpg, ... (1-based)
    const wantedSet = new Set(frameIndices);
    const files = await readdir(tempDir);
    const frameFiles = files
      .filter(f => f.startsWith("output_") && f.endsWith(".jpg"))
      .sort();

    const results = [];
    for (const file of frameFiles) {
      const match = file.match(/^output_(\d+)\.jpg$/);
      if (!match) continue;
      const frameIndex = parseInt(match[1], 10) - 1; // dcmnorm is 1-based, we use 0-based
      if (!wantedSet.has(frameIndex)) continue;
      const buffer = await readFile(path.join(tempDir, file));
      results.push({ frameIndex, buffer });
    }

    return results;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not render all DICOM frames using dcmnorm renderer",
      error: error?.message || String(error),
      stderr: error?.stderr || null,
    }));
    return [];
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((cleanupError) =>
        console.error(`Failed to clean up temporary directory ${tempDir}: ${cleanupError?.message || String(cleanupError)}`)
      );
    }
  }
}

async function processImage(metadata, dicomInput) {
  const imageBuffer = await renderDicomImage(metadata, dicomInput);
  if (imageBuffer) {
    return {
      image: { bytesBase64Encoded: imageBuffer.toString("base64") },
    };
  }
  return null;
}

module.exports = { processImage, renderDicomImage, renderAllDicomFrames, getFrameIndicesToProcess };
