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

// Renders a DICOM image to a PNG buffer by wrapping the dcm2img utility from the dcmtk toolkit.
// This requires dcmtk to be installed in the execution environment.
async function renderDicomImage(dicomBuffer) {
  let tempDir;
  try {
    // Create a temporary directory to avoid file collisions
    tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-"));
    const dicomPath = path.join(tempDir, "input.dcm");
    const pngPath = path.join(tempDir, "output.png");

    // Write the DICOM buffer to a temporary file
    await writeFile(dicomPath, dicomBuffer);

    // Execute dcm2img to convert the DICOM to a PNG.
    // The command will fail if the input is not a valid DICOM image, which is handled in the catch block.
    await new Promise((resolve, reject) => {
      // TODO: The dcmtk package installed via apt-get in the Dockerfile should support
      // JPEG2000 decompression out-of-the-box. If using a different dcmtk build,
      // ensure it's compiled with OpenJPEG or a similar library to handle JPEG2000.
      // Use --write-png to specify PNG output and scale the image to a consistent size for embedding.
      execFile("dcm2img", ["--write-png", "--scale-x-size", "512", dicomPath, pngPath], (error, stdout, stderr) => {
        if (error) {
          // dcm2img writes errors to stderr.
          console.error(`dcm2img execution failed: ${stderr}`);
          return reject(error);
        }
        resolve(stdout);
      });
    });

    // Read the resulting PNG file into a buffer
    const pngBuffer = await readFile(pngPath);
    return pngBuffer;
  } catch (error) {
    console.error(`Could not render DICOM image for embedding using dcmtk: ${error.message}`);
    // Returning null allows the pipeline to continue without the embedding.
    return null;
  } finally {
    // Clean up the temporary directory and its contents
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((cleanupError) =>
        console.error(`Failed to clean up temporary directory ${tempDir}:`, cleanupError)
      );
    }
  }
}

async function processImage(dicomBuffer) {
  const imageBuffer = await renderDicomImage(dicomBuffer);
  if (imageBuffer) {
    return {
      image: { bytesBase64Encoded: imageBuffer.toString("base64") },
    };
  }
  return null;
}

module.exports = { processImage, renderDicomImage };
