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
const { mkdtemp, writeFile, readFile, rm } = require("fs/promises");
const path = require("path");
const os = require("os");

// TODO[P1]: Replace complex shell script with pure JS solution (or WASM) if possible

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

// Renders a DICOM image to a JPG buffer by wrapping the convert_dcm_to_jpg.sh script.
// This requires dcmtk and gdcm to be installed in the execution environment.
async function renderDicomImage(metadata, dicomBuffer) {
  // Check for supported transfer syntaxes
  const transferSyntax = metadata && metadata.TransferSyntaxUID;
  if (!transferSyntax || !SUPPORTED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    console.error(`Unsupported transfer syntax: ${transferSyntax || 'unknown'}`);
    return null;
  }

  let tempDir;
  try {
    // Create a temporary directory to avoid file collisions
    tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-"));
    const dicomPath = path.join(tempDir, "input.dcm");
    const jpgPath = path.join(tempDir, "output.jpg");
    const scriptPath = path.resolve(__dirname, "..", "..", "helpers", "convert_dcm_to_jpg.sh");

    // Write the DICOM buffer to a temporary file
    await writeFile(dicomPath, dicomBuffer);

    // Multi-frame support: select the middle frame if present
    let frameArg = null;
    const numFrames = parseInt(metadata?.NumberOfFrames, 10);
    if (!isNaN(numFrames) && numFrames > 1) {
      // DICOM frames are 1-based
      frameArg = Math.floor((numFrames + 1) / 2);
    }

    // Build arguments for the script
    const args = [dicomPath, jpgPath];
    if (frameArg) {
      args.push(frameArg.toString());
    }

    // Execute convert_dcm_to_jpg.sh to convert the DICOM to a JPG.
    await new Promise((resolve, reject) => {
      execFile(scriptPath, args, (error, stdout, stderr) => {
        if (error) {
          console.error(`convert_dcm_to_jpg.sh execution failed: ${stderr}`);
          return reject(error);
        }
        resolve(stdout);
      });
    });

    // Read the resulting JPG file into a buffer
    const jpgBuffer = await readFile(jpgPath);
    return jpgBuffer;
  } catch (error) {
    console.error(`Could not render DICOM image for embedding using convert_dcm_to_jpg.sh: ${error.message}`);
    return null;
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((cleanupError) =>
        console.error(`Failed to clean up temporary directory ${tempDir}:`, cleanupError)
      );
    }
  }
}

async function processImage(metadata, dicomBuffer) {
  const imageBuffer = await renderDicomImage(metadata, dicomBuffer);
  if (imageBuffer) {
    return {
      image: { bytesBase64Encoded: imageBuffer.toString("base64") },
    };
  }
  return null;
}

module.exports = { processImage, renderDicomImage };
