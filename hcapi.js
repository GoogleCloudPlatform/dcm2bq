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
