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

const { createTextInstance } = require("./text");

/**
 * Extracts text from a structured report JSON object.
 * Handles various DICOM SR content item types and relationships according to DICOM PS3.3.
 * @param {Object} metadata - The DICOM SR metadata object
 * @param {Object} [options] - Options for text extraction
 * @param {boolean} [options.includeCodes=false] - Whether to include coded concepts
 * @param {boolean} [options.includeDateTime=false] - Whether to include date/time values
 * @param {boolean} [options.includeNumeric=true] - Whether to include numeric measurements
 * @returns {string|null} Extracted text or null if no content
 */
function getTextFromSR(metadata, options = {}) {
  const {
    includeCodes = false,
    includeDateTime = false,
    includeNumeric = true
  } = options;

  if (!metadata) {
    return null;
  }

  const textParts = [];

  function processContentItem(item) {
    if (!item) return;

    // Handle different value types according to DICOM PS3.3 Table C.17.3-1
    switch (item.ValueType) {
      case "TEXT":
        if (item.TextValue) {
          textParts.push(item.TextValue.trim());
        }
        break;
      case "NUM":
        if (includeNumeric && item.MeasuredValueSequence) {
          for (const mv of item.MeasuredValueSequence) {
            if (mv.NumericValue) {
              const value = mv.NumericValue;
              const units = mv.MeasurementUnitsCodeSequence?.[0]?.CodeMeaning || '';
              textParts.push(`${value} ${units}`.trim());
            }
          }
        }
        break;
      case "CODE":
        if (includeCodes && item.ConceptCodeSequence) {
          const code = item.ConceptCodeSequence[0];
          if (code?.CodeMeaning) {
            textParts.push(code.CodeMeaning.trim());
          }
        }
        break;
      case "DATE":
      case "TIME":
      case "DATETIME":
        if (includeDateTime && item.DateTime) {
          textParts.push(item.DateTime.trim());
        }
        break;
      case "PNAME":
        if (item.PersonName) {
          const pname = item.PersonName;
          const nameParts = [];
          if (pname.Alphabetic) {
            nameParts.push(pname.Alphabetic);
          }
          if (pname.Ideographic) {
            nameParts.push(pname.Ideographic);
          }
          if (pname.Phonetic) {
            nameParts.push(pname.Phonetic);
          }
          if (nameParts.length > 0) {
            textParts.push(nameParts.join(' ').trim());
          }
        }
        break;
      case "CONTAINER":
        // Containers may have a concept name that provides context
        if (includeCodes && item.ConceptNameCodeSequence) {
          const concept = item.ConceptNameCodeSequence[0];
          if (concept?.CodeMeaning) {
            textParts.push(concept.CodeMeaning.trim());
          }
        }
        break;
    }

    // Handle relationships and nested content
    if (Array.isArray(item.ContentSequence)) {
      // Process each content item in the sequence
      for (const child of item.ContentSequence) {
        // Add relationship context if available
        if (includeCodes && child.RelationshipType && child.ConceptNameCodeSequence) {
          const concept = child.ConceptNameCodeSequence[0];
          if (concept?.CodeMeaning) {
            textParts.push(concept.CodeMeaning.trim());
          }
        }
        processContentItem(child);
      }
    }
  }

  // Start processing from the root content sequence
  if (Array.isArray(metadata.ContentSequence)) {
    for (const item of metadata.ContentSequence) {
      processContentItem(item);
    }
  }

  // Filter out empty strings and join with newlines
  const result = textParts.filter(Boolean).join('\n');
  return result || null;
}

async function processSR(metadata, requireEmbeddingCompatible = true) {
  const text = getTextFromSR(metadata);
  return await createTextInstance(text, requireEmbeddingCompatible);
}

module.exports = { processSR, getTextFromSR };
