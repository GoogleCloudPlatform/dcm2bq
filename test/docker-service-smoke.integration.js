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
const fs = require("fs");
const path = require("path");

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

function imageExists(imageTag) {
  const result = spawnSync("docker", ["image", "inspect", imageTag], { encoding: "utf8" });
  return result.status === 0;
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

describe("docker service smoke integration", function () {
  this.timeout(15 * 60 * 1000);

  const workspaceRoot = path.resolve(__dirname, "..");
  const testConfigPath = path.resolve(__dirname, "testconfig.json");
  const runSmoke = process.env.DOCKER_SMOKE_TEST === "true";
  const packageJson = require(path.join(workspaceRoot, "package.json"));
  const version = process.env.npm_package_version || packageJson.version;
  const imageTag = `jasonklotzer/dcm2bq:${version}`;
  const imagePreexisting = imageExists(imageTag);
  const removeBuiltImage = process.env.DOCKER_SMOKE_REMOVE_IMAGE === "true";
  const containerName = `dcm2bq-service-smoke-${Date.now()}`;
  let baseUrl = null;
  let mappedPort = null;
  let configEnv = null;

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

    if (!fs.existsSync(testConfigPath)) {
      throw new Error(`testconfig.json not found at ${testConfigPath}`);
    }
    configEnv = fs.readFileSync(testConfigPath, "utf8").trim();

    if (!imagePreexisting) {
      runDocker(["build", "-t", imageTag, "."], { cwd: workspaceRoot, stdio: "pipe" });
    }

    runDocker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-e",
      `DCM2BQ_CONFIG=${configEnv}`,
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

    if (!imagePreexisting && removeBuiltImage) {
      try {
        spawnSync("docker", ["rmi", "-f", imageTag], { stdio: "pipe" });
      } catch (_) {}
    }
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
});
