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

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");
const { globSync } = require("glob");
const { DicomFile, parseBulkDataUri } = require("../src/dicomtojson");

const testFiles = globSync("./test/files/dcm/*.dcm");
const notDicomFile = "./test/files/dcm/notdicom.txt";

describe("dicomtojson", () => {
  describe("DicomFile", () => {
    it("should parse a DICOM file from file path", async () => {
      const testFile = testFiles[0];
      const dicom = new DicomFile(pathToFileURL(path.resolve(testFile)));
      const json = await dicom.toJson();
      assert.ok(json);
      assert.ok(Object.keys(json).length > 0);
    });

    it("should fail to parse a non-DICOM file", async () => {
      const dicom = new DicomFile(pathToFileURL(path.resolve(notDicomFile)));
      try {
        await dicom.parse();
        assert.fail("Should have thrown an error");
      } catch (e) {
      }
    });

    it("should throw error for non-URL input", () => {
        try {
          new DicomFile("not a url");
          assert.fail("Should have thrown an error");
        } catch (e) {
          assert.strictEqual(e, "Expected instance of URL for `url` parameter");
        }
      });
  });

  describe("parseBulkDataUri", () => {
    it("should parse offset and length from bulkDataUri", () => {
      const uri = "?offset=123&length=456";
      const result = parseBulkDataUri(uri);
      assert.deepStrictEqual(result, { offset: 123, length: 456 });
    });

    it("should return null for invalid bulkDataUri", () => {
      const uri = "invalid-uri";
      const result = parseBulkDataUri(uri);
      assert.strictEqual(result, null);
    });
  });
});
