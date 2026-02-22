function parseGsPath(gsUri) {
  const match = String(gsUri || "").match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], object: match[2] };
}

function parseDataField(base64Data) {
  try {
    const decoded = Buffer.from(base64Data, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch (_) {
    return null;
  }
}

function parseAttributes(attributesJson) {
  try {
    return JSON.parse(attributesJson);
  } catch (_) {
    return null;
  }
}

function extractDlqFileInfo(row) {
  if (row.data) {
    const data = parseDataField(row.data);
    if (data && data.bucket && data.name) {
      return {
        bucket: data.bucket,
        name: data.name,
        generation: data.generation || null,
        source: "data",
      };
    }
  }

  if (row.attributes) {
    const attrs = parseAttributes(row.attributes);
    if (attrs && attrs.bucketId && attrs.objectId) {
      return {
        bucket: attrs.bucketId,
        name: attrs.objectId,
        generation: attrs.objectGeneration || null,
        source: "attributes",
      };
    }
  }

  return null;
}

module.exports = {
  parseGsPath,
  extractDlqFileInfo,
};
