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
const { deepClone, deepAssign } = require("./utils");

const DEFAULTS = require('./config.defaults.js');

// TODO: JSONSchema validation

function tryReadEnvVars() {
  if (process.env.DCM2BQ_CONFIG) {
    try {
      const defaultsClone = deepClone(DEFAULTS);
      const config = Object.assign(defaultsClone, JSON.parse(process.env.DCM2BQ_CONFIG), { src: "ENV_VAR" });
      return config;
    } catch (e) {
      console.error(e);
    }
  }
}

function tryReadConfigFile() {
  if (process.env.DCM2BQ_CONFIG_FILE) {
    try {
      const defaultsClone = deepClone(DEFAULTS);
      const config = Object.assign(defaultsClone, JSON.parse(fs.readFileSync(process.env.DCM2BQ_CONFIG_FILE)), { src: "ENV_VAR_FILE" });
      return config;
    } catch {}
  }
}

module.exports.get = function getConfig(overrides) {
  const defaultsClone = deepClone(DEFAULTS);
  const config = deepAssign(tryReadEnvVars() || tryReadConfigFile() || defaultsClone, overrides);
  return config;
};
