const { Storage } = require("@google-cloud/storage");

const storage = new Storage();

function createUriPath(bucketId, objectId) {
  return `gs://${bucketId}/${objectId}`;
}

async function downloadToPath(bucketId, objectId, dstFilePath) {
  const options = {
    destination: dstFilePath,
  };
  await storage.bucket(bucketId).file(objectId).download(options);
}

async function downloadToMemory(bucketId, objectId) {
  // TODO: Should we set a max on the amount of bytes read?
  const response = await storage.bucket(bucketId).file(objectId).download();
  return response[0]; // First item
}

module.exports = {
  createUriPath,
  downloadToMemory,
  downloadToPath,
};
