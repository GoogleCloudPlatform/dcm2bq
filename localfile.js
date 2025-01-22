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

const fs = require("fs").promises;
const os = require("os");
const crypto = require("crypto");

function createLocalTmpFilePath() {
  const tmpFileName = crypto.randomBytes(16).toString("hex");
  return `${os.tmpdir()}/${tmpFileName}.dcm`;
}

async function deleteLocalFile(filePath) {
  await fs.rm(filePath);
}

module.exports = { createLocalTmpFilePath, deleteLocalFile };
