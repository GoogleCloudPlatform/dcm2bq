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
const sinon = require("sinon");

const consts = require("../src/consts");
const localfile = require("../src/localfile");
const { matchEventSchema } = require("../src/schemas");
const { collectFiles, buildGeneration, buildLocalEnvelope, isSupportedFile } = require("../src/index-command");

describe("local mode", () => {
  let rootDir;

  before(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm2bq-local-test-"));
  });

  after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  describe("localfile", () => {
    it("round-trips file paths through file:// URIs", () => {
      const filePath = path.join(rootDir, "some dir", "file.dcm");
      const uri = localfile.createUriPath(filePath);
      assert.ok(uri.startsWith("file://"), `Expected file:// URI, got ${uri}`);
      assert.equal(localfile.uriToPath(uri), filePath);
      assert.ok(localfile.isFileUri(uri));
      assert.ok(!localfile.isFileUri("gs://bucket/object"));
    });

    it("resolveUnderRoot accepts paths under the root", async () => {
      const filePath = path.join(rootDir, "ok.dcm");
      fs.writeFileSync(filePath, "x");
      const resolved = await localfile.resolveUnderRoot(rootDir, filePath);
      assert.equal(resolved, await fs.promises.realpath(filePath));
    });

    it("resolveUnderRoot rejects paths escaping the root", async () => {
      await assert.rejects(
        localfile.resolveUnderRoot(rootDir, "/etc/hostname"),
        /escapes the configured root/
      );
      await assert.rejects(
        localfile.resolveUnderRoot(rootDir, path.join(rootDir, "..", "escape.dcm")),
        /not accessible|escapes the configured root/
      );
    });

    it("resolveUnderRoot resolves any accessible path when root is unset", async () => {
      const filePath = path.join(rootDir, "ok.dcm");
      fs.writeFileSync(filePath, "x");
      const resolved = await localfile.resolveUnderRoot("", filePath);
      assert.equal(resolved, await fs.promises.realpath(filePath));
    });

    it("saveToLocalPath writes nested files and returns a file:// URI", async () => {
      const baseUri = localfile.createUriPath(path.join(rootDir, "extract"));
      const uri = await localfile.saveToLocalPath(baseUri, Buffer.from("hello"), "study/series/instance.jpg");
      const writtenPath = localfile.uriToPath(uri);
      assert.equal(fs.readFileSync(writtenPath, "utf8"), "hello");
      assert.ok(writtenPath.startsWith(path.join(rootDir, "extract") + path.sep));
    });

    it("saveToLocalPath rejects relative paths escaping the output root", async () => {
      const baseUri = localfile.createUriPath(path.join(rootDir, "extract"));
      await assert.rejects(
        localfile.saveToLocalPath(baseUri, Buffer.from("x"), "../escape.txt"),
        /escapes the configured output root/
      );
    });
  });

  describe("index command", () => {
    it("recognizes supported file types", () => {
      assert.ok(isSupportedFile("/a/b.dcm"));
      assert.ok(isSupportedFile("/a/b.DICOM"));
      assert.ok(isSupportedFile("/a/b.tar.gz"));
      assert.ok(!isSupportedFile("/a/b.txt"));
    });

    it("collects supported files recursively", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcm2bq-collect-"));
      try {
        fs.mkdirSync(path.join(dir, "nested"));
        fs.writeFileSync(path.join(dir, "a.dcm"), "x");
        fs.writeFileSync(path.join(dir, "nested", "b.zip"), "x");
        fs.writeFileSync(path.join(dir, "ignored.txt"), "x");
        const files = await collectFiles(dir);
        assert.deepEqual(files.map((f) => path.basename(f)).sort(), ["a.dcm", "b.zip"]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("derives the generation from mtime, and --force makes fresh ones", () => {
      const stats = { mtimeMs: 1700000000123.456 };
      assert.equal(buildGeneration(stats, false), String(Math.floor(stats.mtimeMs * 1000)));
      assert.equal(buildGeneration(stats, false), buildGeneration(stats, false));
      assert.notEqual(buildGeneration(stats, true), buildGeneration(stats, true));
    });

    it("builds an envelope that routes to the LOCAL handler", () => {
      const envelope = buildLocalEnvelope("/data/file.dcm", { size: 42 }, "1700000000000000");
      assert.equal(matchEventSchema(envelope), consts.LOCAL_PUBSUB_UNWRAP);
      const data = JSON.parse(Buffer.from(envelope.message.data, "base64").toString());
      assert.deepEqual(data, { name: "/data/file.dcm", size: 42, generation: "1700000000000000" });
    });
  });

  describe("handleLocalPubSubUnwrap", () => {
    let bqInsertStub;
    let bqInsertEmbeddingsStub;
    let createVectorEmbeddingStub;
    let eventhandlers;
    let savedLocalConfig;

    function localEvent(filePath, overrides = {}) {
      const stats = fs.statSync(filePath);
      const envelope = buildLocalEnvelope(filePath, stats, buildGeneration(stats, false));
      if (overrides.data) {
        envelope.message.data = Buffer.from(JSON.stringify(overrides.data)).toString("base64");
      }
      return envelope;
    }

    let configModule;

    before(() => {
      // Fresh eventhandlers with BQ/embeddings stubbed (same pattern as eventhandlers.test.js).
      // Modules are resolved here rather than at file load because other test files
      // purge require.cache; stubs must land on the instances eventhandlers will use.
      delete require.cache[require.resolve("../src/eventhandlers")];
      delete require.cache[require.resolve("../src/embeddings")];

      const bq = require("../src/bigquery");
      bqInsertStub = sinon.stub(bq, "insert").resolves();
      bqInsertEmbeddingsStub = sinon.stub(bq, "insertEmbeddings").resolves();

      const embeddingsModule = require("../src/embeddings");
      createVectorEmbeddingStub = sinon.stub(embeddingsModule, "createVectorEmbedding").resolves([
        {
          embedding: [0.1, 0.2],
          objectPath: "gs://mock-bucket/path/to/file.jpg",
          objectSize: 1024,
          objectMimeType: "image/jpeg",
          frameNumber: 0,
        },
      ]);
      eventhandlers = require("../src/eventhandlers");

      // Point the cached config's local root at the test directory
      configModule = require("../src/config");
      const cfg = configModule.get();
      savedLocalConfig = cfg.localConfig;
      cfg.localConfig = { rootPath: rootDir };
    });

    after(() => {
      configModule.get().localConfig = savedLocalConfig;
      bqInsertStub.restore();
      bqInsertEmbeddingsStub.restore();
      createVectorEmbeddingStub.restore();
    });

    beforeEach(() => {
      bqInsertStub.resetHistory();
      bqInsertEmbeddingsStub.resetHistory();
      createVectorEmbeddingStub.resetHistory();
    });

    it("processes a local DICOM file in place", async function () {
      this.timeout(10000);
      const dcmPath = path.join(rootDir, "ct.dcm");
      fs.copyFileSync(path.join(__dirname, "files/dcm/ct.dcm"), dcmPath);
      const envelope = localEvent(dcmPath);
      const perfCtx = { addRef: sinon.stub() };

      await eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx });

      assert.equal(bqInsertStub.callCount, 1, "insert should be called once");
      const row = bqInsertStub.getCall(0).args[0];
      assert.ok(row.path.startsWith("file://"), `Expected file:// path, got ${row.path}`);
      assert.equal(row.info.input.type, consts.STORAGE_TYPE_LOCAL);
      assert.equal(row.info.event, consts.LOCAL_FINALIZE);
      assert.ok(row.metadata, "Should have parsed metadata");
      const expectedGeneration = JSON.parse(Buffer.from(envelope.message.data, "base64").toString()).generation;
      assert.equal(row.version, expectedGeneration);
      assert.ok(fs.existsSync(dcmPath), "Source file must not be deleted");
    });

    it("processes a local zip archive", async function () {
      this.timeout(20000);
      const zipPath = path.join(rootDir, "study.zip");
      fs.copyFileSync(path.join(__dirname, "files/zip/study.zip"), zipPath);
      const envelope = localEvent(zipPath);
      const perfCtx = { addRef: sinon.stub() };

      await eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx });

      assert.ok(bqInsertStub.callCount > 0, "insert should be called for archive contents");
      for (let i = 0; i < bqInsertStub.callCount; i++) {
        const row = bqInsertStub.getCall(i).args[0];
        assert.ok(row.path.startsWith("file://") && row.path.includes("#"), `Expected file://...#name path, got ${row.path}`);
        assert.equal(row.info.input.type, consts.STORAGE_TYPE_LOCAL);
      }
      assert.ok(fs.existsSync(zipPath), "Source archive must not be deleted");
    });

    it("falls back to DCM2BQ_LOCAL_ROOT when the active config has no localConfig", async function () {
      this.timeout(10000);
      // Configs provided via DCM2BQ_CONFIG/DCM2BQ_CONFIG_FILE do not merge with
      // defaults, so localConfig is typically absent; the env var must still work.
      const dcmPath = path.join(rootDir, "ct.dcm");
      fs.copyFileSync(path.join(__dirname, "files/dcm/ct.dcm"), dcmPath);
      const cfg = configModule.get();
      const prevLocalConfig = cfg.localConfig;
      const prevEnv = process.env.DCM2BQ_LOCAL_ROOT;
      cfg.localConfig = undefined;
      process.env.DCM2BQ_LOCAL_ROOT = rootDir;
      try {
        const envelope = localEvent(dcmPath);
        const perfCtx = { addRef: sinon.stub() };
        await eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx });
        assert.equal(bqInsertStub.callCount, 1, "insert should be called once");
      } finally {
        cfg.localConfig = prevLocalConfig;
        if (prevEnv === undefined) {
          delete process.env.DCM2BQ_LOCAL_ROOT;
        } else {
          process.env.DCM2BQ_LOCAL_ROOT = prevEnv;
        }
      }
    });

    it("rejects paths escaping the configured root", async () => {
      const envelope = localEvent(path.join(rootDir, "ct.dcm"), {
        data: { name: "/etc/hostname.dcm", size: 1, generation: "1" },
      });
      const perfCtx = { addRef: sinon.stub() };
      await assert.rejects(
        eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx }),
        /escapes the configured root|not accessible/
      );
      assert.equal(bqInsertStub.callCount, 0);
    });

    it("ignores unsupported file types", async () => {
      const txtPath = path.join(rootDir, "notes.txt");
      fs.writeFileSync(txtPath, "not dicom");
      const envelope = localEvent(txtPath);
      const perfCtx = { addRef: sinon.stub() };
      await eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx });
      assert.equal(bqInsertStub.callCount, 0);
    });

    it("acknowledges (without insert) when the file is not parseable DICOM", async () => {
      const badPath = path.join(rootDir, "bad.dcm");
      fs.writeFileSync(badPath, "definitely not dicom");
      const envelope = localEvent(badPath);
      const perfCtx = { addRef: sinon.stub() };
      // Non-retryable parse errors are logged and swallowed, like the GCS handler
      await eventhandlers.handleEvent(consts.LOCAL_PUBSUB_UNWRAP, { body: envelope }, { perfCtx });
      assert.equal(bqInsertStub.callCount, 0);
    });
  });
});
