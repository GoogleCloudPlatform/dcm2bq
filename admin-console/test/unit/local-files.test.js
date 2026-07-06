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
const os = require("os");
const path = require("path");
const url = require("url");

const { isFileUri, readLocalAsset, buildLocalReprocessEnvelope } = require("../../backend/src/local-files");

describe("local-files", () => {
  let rootDir;

  before(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-local-test-"));
  });

  after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe("isFileUri", () => {
    it("detects file:// URIs and nothing else", () => {
      assert.ok(isFileUri("file:///data/x.jpg"));
      assert.ok(!isFileUri("gs://bucket/x.jpg"));
      assert.ok(!isFileUri(null));
    });
  });

  describe("readLocalAsset", () => {
    it("reads assets under the configured root", async () => {
      const assetPath = path.join(rootDir, "asset.jpg");
      fs.writeFileSync(assetPath, "jpeg-bytes");
      const buffer = await readLocalAsset(rootDir, url.pathToFileURL(assetPath).href);
      assert.equal(buffer.toString(), "jpeg-bytes");
    });

    it("reads any accessible asset when no root is configured", async () => {
      const assetPath = path.join(rootDir, "asset.jpg");
      fs.writeFileSync(assetPath, "jpeg-bytes");
      const buffer = await readLocalAsset("", url.pathToFileURL(assetPath).href);
      assert.equal(buffer.toString(), "jpeg-bytes");
    });

    it("rejects with 403 when the path escapes the root", async () => {
      await assert.rejects(
        readLocalAsset(rootDir, url.pathToFileURL("/etc/hostname").href),
        (e) => e.statusCode === 403
      );
    });

    it("rejects with 404 when the file does not exist", async () => {
      await assert.rejects(
        readLocalAsset(rootDir, url.pathToFileURL(path.join(rootDir, "missing.jpg")).href),
        (e) => e.statusCode === 404
      );
    });
  });

  describe("buildLocalReprocessEnvelope", () => {
    it("builds a LOCAL_FINALIZE envelope carrying the path and synthetic generation", () => {
      const fileUri = url.pathToFileURL("/data/dicom/study/file.dcm").href;
      const envelope = buildLocalReprocessEnvelope(fileUri, "reprocess-123-abc-0");
      assert.equal(envelope.message.attributes.eventType, "LOCAL_FINALIZE");
      const data = JSON.parse(Buffer.from(envelope.message.data, "base64").toString());
      assert.equal(data.name, "/data/dicom/study/file.dcm");
      assert.equal(data.generation, "reprocess-123-abc-0");
      assert.equal(data.size, undefined, "size must be omitted so stale rows can still reprocess");
    });
  });
});
