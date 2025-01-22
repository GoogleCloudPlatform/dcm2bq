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

const { GoogleAuth } = require("google-auth-library");

function createUriPath(dicomWebPath) {
  return `https://healthcare.googleapis.com/v1/${dicomWebPath}`;
}

async function downloadToMemory(url) {
  const auth = new GoogleAuth({
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  const client = await auth.getClient();
  const res = await client.request({ url, headers: { Accept: "application/dicom; transfer-syntax=*" }, responseType: "arraybuffer" });
  const buff = Buffer.from(res.data);
  return buff;
}

module.exports = {
  createUriPath,
  downloadToMemory,
};
