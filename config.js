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
