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
