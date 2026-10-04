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

const { renderFrame } = require("@pohcee/dcmnorm-node");
const { mkdtemp, writeFile, rm } = require("fs/promises");
const path = require("path");
const os = require("os");

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
  // JPEG-LS
  "1.2.840.10008.1.2.4.80",      // JPEG-LS Lossless Image Compression
  "1.2.840.10008.1.2.4.81",      // JPEG-LS Lossy (Near-Lossless) Image Compression
  // JPEG 2000
  "1.2.840.10008.1.2.4.90",      // JPEG 2000 Image Compression (Lossless Only)
  "1.2.840.10008.1.2.4.91",      // JPEG 2000 Image Compression
  "1.2.840.10008.1.2.4.92",      // JPEG 2000 Part 2 Multi-component Image Compression (Lossless Only)
  "1.2.840.10008.1.2.4.93",      // JPEG 2000 Part 2 Multi-component Image Compression
  "1.2.840.10008.1.2.4.201",     // High-Throughput JPEG 2000 Image Compression (Lossless Only)
  "1.2.840.10008.1.2.4.202",     // High-Throughput JPEG 2000 with RPCL Options Image Compression (Lossless Only)
  "1.2.840.10008.1.2.4.203",     // High-Throughput JPEG 2000 Image Compression
  // JPEG XL
  "1.2.840.10008.1.2.4.110",     // JPEG XL Lossless
  "1.2.840.10008.1.2.4.111",     // JPEG XL JPEG Recompression
  "1.2.840.10008.1.2.4.112",     // JPEG XL
  // Video (decoded by the FFmpeg codec statically linked into dcmnorm-node)
  "1.2.840.10008.1.2.4.100",     // MPEG2 Main Profile / Main Level
  "1.2.840.10008.1.2.4.101",     // MPEG2 Main Profile / High Level
  "1.2.840.10008.1.2.4.102",     // MPEG-4 AVC/H.264 High Profile / Level 4.1
  "1.2.840.10008.1.2.4.103",     // MPEG-4 AVC/H.264 BD-compatible High Profile / Level 4.1
  "1.2.840.10008.1.2.4.104",     // MPEG-4 AVC/H.264 High Profile / Level 4.2 For 2D Video
  "1.2.840.10008.1.2.4.105",     // MPEG-4 AVC/H.264 High Profile / Level 4.2 For 3D Video
  "1.2.840.10008.1.2.4.106",     // MPEG-4 AVC/H.264 Stereo High Profile / Level 4.2
  "1.2.840.10008.1.2.4.107",     // HEVC/H.265 Main Profile / Level 5.1
  "1.2.840.10008.1.2.4.108"      // HEVC/H.265 Main 10 Profile / Level 5.1
]);

// Options shared by every renderFrame call. Overlay planes (group 60xx) are composited by
// dcmnorm-node by default; keep them out so visuals/embeddings reflect the pixel data only.
const BASE_RENDER_OPTIONS = Object.freeze({ format: "jpeg", showOverlays: false });

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
 * Determines whether to pass outputWidth or outputHeight to dcmnorm
 * so that the rendered image maintains its original aspect ratio and fits within maxDim x maxDim.
 * @param {Object} metadata - DICOM metadata JSON
 * @param {number} maxDim - Maximum dimension bound (default: 512)
 * @returns {Object} `{ outputHeight: maxDim }` or `{ outputWidth: maxDim }`
 */
function getRenderDimensions(metadata, maxDim = 512) {
  const rows = parseInt(metadata?.Rows, 10);
  const cols = parseInt(metadata?.Columns, 10);
  if (!isNaN(rows) && !isNaN(cols) && rows > cols) {
    return { outputHeight: maxDim };
  }
  return { outputWidth: maxDim };
}

/**
 * Renders a DICOM image to a JPG buffer using native dcmnorm node bindings.
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
    let dicomPath;
    if (typeof dicomInput === "string") {
      dicomPath = dicomInput;
    } else if (Buffer.isBuffer(dicomInput)) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-"));
      dicomPath = path.join(tempDir, "input.dcm");
      await writeFile(dicomPath, dicomInput);
    } else {
      throw new Error("Expected dicom input to be a file path or Buffer");
    }

    let targetFrame = 0;
    if (frameIndex != null) {
      targetFrame = frameIndex;
    } else {
      const numFrames = parseInt(metadata?.NumberOfFrames, 10);
      if (!isNaN(numFrames) && numFrames > 1) {
        targetFrame = Math.floor((numFrames - 1) / 2);
      }
    }

    const renderDimensions = getRenderDimensions(metadata, 512);
    const rendered = await renderFrame(dicomPath, {
      ...BASE_RENDER_OPTIONS,
      ...renderDimensions,
      frameIndex: targetFrame,
    });

    return rendered && rendered.data ? rendered.data : null;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not render DICOM image for embedding using dcmnorm renderer",
      error: error?.message || String(error),
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
 * Renders all frames of a multi-frame DICOM file using native dcmnorm node bindings.
 * Returns an array of {frameIndex, buffer} sorted by frame index.
 * Only the frames in frameIndices are returned.
 */
async function renderAllDicomFrames(metadata, dicomInput, frameIndices) {
  const transferSyntax = metadata && metadata.TransferSyntaxUID;
  if (!transferSyntax || !SUPPORTED_TRANSFER_SYNTAXES.has(transferSyntax)) {
    console.error(`Unsupported transfer syntax: ${transferSyntax || 'unknown'}`);
    return [];
  }

  let tempDir;
  try {
    let dicomPath;
    if (typeof dicomInput === "string") {
      dicomPath = dicomInput;
    } else if (Buffer.isBuffer(dicomInput)) {
      tempDir = await mkdtemp(path.join(os.tmpdir(), "dcm-render-all-"));
      dicomPath = path.join(tempDir, "input.dcm");
      await writeFile(dicomPath, dicomInput);
    } else {
      throw new Error("Expected dicom input to be a file path or Buffer");
    }

    const renderDimensions = getRenderDimensions(metadata, 512);
    const results = [];
    for (const frameIndex of frameIndices) {
      const rendered = await renderFrame(dicomPath, {
        ...BASE_RENDER_OPTIONS,
        ...renderDimensions,
        frameIndex,
      });
      if (rendered && rendered.data) {
        results.push({ frameIndex, buffer: rendered.data });
      }
    }

    return results;
  } catch (error) {
    console.error(JSON.stringify({
      message: "Could not render all DICOM frames using dcmnorm renderer",
      error: error?.message || String(error),
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

module.exports = { processImage, renderDicomImage, renderAllDicomFrames, getFrameIndicesToProcess, getRenderDimensions };
