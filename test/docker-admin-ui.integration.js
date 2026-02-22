/*
 Copyright 2026 Google LLC

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
const { spawnSync } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    throw new Error(`docker ${args.join(" ")} failed\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  return (result.stdout || "").trim();
}

async function waitForHttpOk(url, timeoutMs = 60000, intervalMs = 1500) {
  const start = Date.now();
  let lastError = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError ? lastError.message : "unknown error"}`);
}

describe("docker admin UI smoke integration", function () {
  this.timeout(15 * 60 * 1000);

  const workspaceRoot = path.resolve(__dirname, "..");
  const runSmoke = process.env.DOCKER_SMOKE_TEST === "true";
  const imageTag = `dcm2bq-smoke-${Date.now()}`;
  const containerName = `dcm2bq-smoke-${Date.now()}`;
  let baseUrl = null;
  let mappedPort = null;

  before(function () {
    if (!runSmoke) {
      this.skip();
      return;
    }

    const dockerCheck = spawnSync("docker", ["--version"], { encoding: "utf8" });
    if (dockerCheck.status !== 0) {
      this.skip();
      return;
    }

    runDocker(["build", "-t", imageTag, "."], { cwd: workspaceRoot, stdio: "pipe" });

    runDocker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::8080",
      imageTag,
    ], { cwd: workspaceRoot, stdio: "pipe" });

    const portMapping = runDocker(["port", containerName, "8080/tcp"], { stdio: "pipe" });
    mappedPort = portMapping.split(":").pop();
    assert(mappedPort, "Failed to determine mapped container port");
    baseUrl = `http://127.0.0.1:${mappedPort}`;
  });

  after(() => {
    try {
      spawnSync("docker", ["rm", "-f", containerName], { stdio: "pipe" });
    } catch (_) {}

    try {
      spawnSync("docker", ["rmi", "-f", imageTag], { stdio: "pipe" });
    } catch (_) {}
  });

  it("starts the container and exposes the root service endpoint", async () => {
    assert(baseUrl, "Container base URL was not initialized");
    await waitForHttpOk(`${baseUrl}/`);

    const rootResponse = await fetch(`${baseUrl}/`);
    assert.strictEqual(rootResponse.status, 200);
    const body = await rootResponse.json();
    assert.strictEqual(typeof body.name, "string");
    assert.strictEqual(typeof body.version, "string");
  });

  it("serves admin UI static assets from container image", async () => {
    await waitForHttpOk(`${baseUrl}/ui`);

    const uiResponse = await fetch(`${baseUrl}/ui`);
    assert.strictEqual(uiResponse.status, 200);
    const uiHtml = await uiResponse.text();
    assert(uiHtml.includes("./admin.js"), "Expected /ui to reference admin.js");
    assert(uiHtml.includes("./admin.css"), "Expected /ui to reference admin.css");

    const jsResponse = await fetch(`${baseUrl}/ui/admin.js`);
    assert.strictEqual(jsResponse.status, 200);
    const jsBody = await jsResponse.text();
    assert(jsBody.includes("connectWebSocket"), "Expected admin.js content to load");

    const cssResponse = await fetch(`${baseUrl}/ui/admin.css`);
    assert.strictEqual(cssResponse.status, 200);
    const cssBody = await cssResponse.text();
    assert(cssBody.includes(".ws-status"), "Expected admin.css content to load");
  });

  it("contains admin assets on disk inside the container", () => {
    runDocker(["exec", containerName, "test", "-f", "/usr/src/app/assets/http-admin/index.html"], { stdio: "pipe" });
    runDocker(["exec", containerName, "test", "-f", "/usr/src/app/assets/http-admin/admin.js"], { stdio: "pipe" });
    runDocker(["exec", containerName, "test", "-f", "/usr/src/app/assets/http-admin/admin.css"], { stdio: "pipe" });
  });

  it("accepts WebSocket connections on /ws", async () => {
    assert(mappedPort, "Container mapped port was not initialized");
    const wsUrl = `ws://127.0.0.1:${mappedPort}/ws`;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error("Timed out waiting for websocket open"));
      }, 15000);

      socket.once("open", () => {
        clearTimeout(timeout);
        socket.close();
        resolve();
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });
});
