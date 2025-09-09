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
const { globSync } = require("glob");
const { DicomFile, DicomInMemory, parseBulkDataUri } = require("../dicomtojson");

const testFiles = globSync("./test/files/dcm/*.dcm");
const notDicomFile = "./test/files/dcm/notdicom.txt";

describe("dicomtojson", () => {
  describe("DicomInMemory", () => {
    it("should parse a DICOM file from buffer", () => {
      const testFile = testFiles[0];
      const buffer = fs.readFileSync(testFile);
      const dicom = new DicomInMemory(buffer);
      const json = dicom.toJson();
      assert.ok(json);
      assert.ok(Object.keys(json).length > 0);
    });

    it("should throw error for non-buffer input", () => {
      try {
        new DicomInMemory("not a buffer");
        assert.fail("Should have thrown an error");
      } catch (e) {
        assert.strictEqual(e, "Expected instance of buffer for `buffer` parameter");
      }
    });

    it("should fail to parse a non-DICOM file", () => {
        const buffer = fs.readFileSync(notDicomFile);
        const dicom = new DicomInMemory(buffer);
        try {
            dicom.parse();
            assert.fail("Should have thrown an error");
        } catch (e) {
        }
    });
  });

  describe("DicomFile", () => {
    it("should parse a DICOM file from file path", () => {
      const testFile = testFiles[0];
      const dicom = new DicomFile(new URL(`file://${require.resolve(`../${testFile}`)}`));
      const json = dicom.toJson();
      assert.ok(json);
      assert.ok(Object.keys(json).length > 0);
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
