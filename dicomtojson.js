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

const fs = require("fs");
const dicomParser = require("dicom-parser");

const BIN_VR_LIST = ["OB", "OD", "OF", "OW", "UN"];
const NUM_VR_LIST = ["AT", "FL", "FD", "SL", "SS", "UL", "US"];
const STR_VR_LIST = ["AE", "AS", "CS", "DA", "DS", "DT", "IS", "LO", "LT", "PN", "SH", "ST", "TM", "UI", "UT"];
const BYTES_PER_VR = {
  AT: { bytes: 4, type: "uint32" },
  FL: { bytes: 4, type: "float" },
  FD: { bytes: 8, type: "double" },
  SL: { bytes: 4, type: "int32" },
  SS: { bytes: 2, type: "int16" },
  UL: { bytes: 4, type: "uint32" },
  US: { bytes: 2, type: "uint16" },
};

// Lazy initialize
let tagLookupMap;

function normalizeTag(tag) {
  if (/x[0-9a-f]{8}/.test(tag)) {
    return tag.substring(1).toLowerCase();
  } else if (/\([0-9A-F],[0-9A-F]\)/.test(tag)) {
    return `${tag.substring(1, 5).toLowerCase()}${tag.substring(5, 9).toLowerCase()}`;
  }
  return tag;
}

function lookupTag(tag) {
  if (!tagLookupMap) {
    tagLookupMap = require("./tag-lookup.min.json");
  }
  const normTag = normalizeTag(tag);
  return tagLookupMap[normTag];
}

function isBinaryVR(vr) {
  return BIN_VR_LIST.includes(vr);
}

function isNumericVR(vr) {
  return NUM_VR_LIST.includes(vr);
}

function isSequenceVR(vr) {
  return vr === "SQ";
}

function isStringVR(vr) {
  return STR_VR_LIST.includes(vr);
}

function isPrivateElem(elem) {
  return dicomParser.isPrivateTag(elem.tag);
}

function isGroupLength(elem) {
  return /0000$/.test(elem.tag);
}

function isMetaElem(elem) {
  return elem.tag <= "x0002ffff";
}

function isEmptyElem(elem) {
  return elem.length === 0;
}

function getVR(elem) {
  return elem.vr || (lookupTag(elem.tag) || { vr: "UN" }).vr;
}

function getValues(rootObj, outputOptions) {
  const jsonObj = {};
  const dataset = rootObj.elements;
  const keys = Object.keys(dataset).sort();
  keys.forEach((key) => {
    const elem = dataset[key];
    if (excludeElement(outputOptions, elem)) return;
    let normKey = normalizeTag(key);
    if (outputOptions.useCommonNames) {
      const tag = lookupTag(normKey);
      normKey = tag ? tag.keyword : normKey;
    }
    jsonObj[normKey] = getValue(rootObj, elem, outputOptions);
  });
  return jsonObj;
}

function getValue(rootObj, elem, outputOptions) {
  let value = null;
  const vr = getVR(elem);
  if (isStringVR(vr)) {
    value = rootObj.string(elem.tag);
  } else if (isNumericVR(vr)) {
    value = [];
    const type = BYTES_PER_VR[vr].type;
    const items = elem.length / BYTES_PER_VR[vr].bytes;
    for (let i = 0; i < items; i++) {
      value.push(rootObj[type](elem.tag, i));
    }
    if (!outputOptions.useArrayWithSingleValue && Array.isArray(value) && value.length === 1) {
      value = value[0];
    }
  } else if (isBinaryVR(vr)) {
    value = { BulkDataURI: `${outputOptions.bulkDataRoot || ""}?offset=${elem.dataOffset}&length=${elem.length}` };
  } else if (isSequenceVR(vr)) {
    value = [];
    (elem.items || []).forEach((item) => {
      const values = getValues(item.dataSet, outputOptions);
      value.push(values);
    });
  }
  return value;
}

function excludeElement(outputOptions, elem) {
  return (
    (outputOptions.ignoreGroupLength && isGroupLength(elem)) ||
    (outputOptions.ignorePrivate && isPrivateElem(elem)) ||
    (outputOptions.ignoreEmpty && isEmptyElem(elem)) ||
    (outputOptions.ignoreMetaHeader && isMetaElem(elem)) ||
    (outputOptions.ignoreBinary && isBinaryVR(getVR(elem)))
  );
}

class DicomInMemory {
  constructor(buffer, parserOptions = {}) {
    if (!(buffer instanceof Buffer)) {
      throw "Expected instance of buffer for `buffer` parameter";
    }
    this.buffer = buffer;
    this.parserOptions = parserOptions;
  }

  parse() {
    return dicomParser.parseDicom(this.buffer, this.parserOptions);
  }

  toJson(outputOptions = {}) {
    const rootObj = this.parse();
    return getValues(rootObj, outputOptions);
  }
}

class DicomFile extends DicomInMemory {
  constructor(url, parserOptions = {}) {
    if (!(url instanceof URL)) {
      throw "Expected instance of URL for `url` parameter";
    }
    const buffer = fs.readFileSync(url);
    super(buffer, parserOptions);
  }
}

function parseBulkDataUri(bulkDataUri) {
  const match = bulkDataUri.match(/\?offset=(\d+)&length=(\d+)/);
  if (match) {
    return { offset: parseInt(match[1], 10), length: parseInt(match[2], 10) };
  }
  return null;
}

module.exports = { DicomFile, DicomInMemory, parseBulkDataUri };
