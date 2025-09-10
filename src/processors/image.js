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

// TODO[P1]: Select a better default multi-frame rendering strategy (e.g., first, last, average, etc.)
// TODO[P0]: Add check for transfer syntaxes that are not supported by dcmtk/gdcm (video, etc.)
// TODO[P0]: Make sure we handle persisting images to disk (cloudrun)


// Renders a DICOM image to a JPG buffer by wrapping the convert_dcm_to_jpg.sh script.
// This requires dcmtk and gdcm to be installed in the execution environment.
async function renderDicomImage(dicomBuffer) {
  let tempDir;
  try {
    // Create a temporary directory to avoid file collisions
    tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-"));
    const dicomPath = path.join(tempDir, "input.dcm");
    const jpgPath = path.join(tempDir, "output.jpg");
    const scriptPath = path.resolve(__dirname, "..", "..", "helpers", "convert_dcm_to_jpg.sh");

    // Write the DICOM buffer to a temporary file
    await writeFile(dicomPath, dicomBuffer);

    // Execute convert_dcm_to_jpg.sh to convert the DICOM to a JPG.
    // The command will fail if the input is not a valid DICOM image, which is handled in the catch block.
    await new Promise((resolve, reject) => {
      execFile(scriptPath, [dicomPath, jpgPath], (error, stdout, stderr) => {
        if (error) {
          // The script writes errors to stderr.
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
