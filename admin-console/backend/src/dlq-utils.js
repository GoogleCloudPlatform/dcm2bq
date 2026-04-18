function parseGsPath(gsUri) {
  const match = String(gsUri || "").match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { bucket: match[1], object: match[2] };
}

function parseDataField(base64Data) {
  if (!base64Data) return null;

  if (typeof base64Data === "object") {
    if (Buffer.isBuffer(base64Data)) {
      try {
        const decoded = base64Data.toString("utf-8");
        return JSON.parse(decoded);
      } catch (_) {
        const text = base64Data.toString("utf-8").trim();
        return text || null;
      }
    }
    return base64Data;
  }

  try {
    const decoded = Buffer.from(String(base64Data), "base64").toString("utf-8");
    try {
      return JSON.parse(decoded);
    } catch (_) {
      const text = String(decoded || "").trim();
      if (text) return text;
    }
  } catch (_) {
    // Fall through to raw JSON parse below.
  }

  try {
    return JSON.parse(String(base64Data));
  } catch (_) {
    return null;
  }
}

function parseAttributes(attributesJson) {
  if (!attributesJson) return null;

  if (typeof attributesJson === "object") {
    return attributesJson;
  }

  try {
    return JSON.parse(String(attributesJson));
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

function extractDlqRequeueTarget(row) {
  const attrs = parseAttributes(row?.attributes) || {};
  const data = parseDataField(row?.data);

  const dataBucket = data && typeof data === "object" ? data.bucket : null;
  const dataName = data && typeof data === "object" ? data.name : null;
  const dataGeneration = data && typeof data === "object" ? data.generation : null;

  const bucket = dataBucket || attrs.bucketId || null;
  const objectId = dataName || attrs.objectId || null;
  if (bucket && objectId) {
    const eventData = {
      ...(data && typeof data === "object" ? data : {}),
      bucket,
      name: objectId,
    };

    if (dataGeneration || attrs.objectGeneration) {
      eventData.generation = String(dataGeneration || attrs.objectGeneration);
    }

    const publishAttributes = {
      payloadFormat: "JSON_API_V1",
      eventType: "OBJECT_FINALIZE",
      bucketId: bucket,
      objectId,
    };

    if (eventData.generation) {
      publishAttributes.objectGeneration = String(eventData.generation);
    }

    return {
      type: "gcs",
      key: `gcs:${bucket}/${objectId}`,
      displayPath: `gs://${bucket}/${objectId}`,
      publishDataBuffer: Buffer.from(JSON.stringify(eventData), "utf8"),
      publishAttributes,
    };
  }

  const dicomWebPath = typeof data === "string" ? data.trim() : "";
  if (dicomWebPath && /\/dicomWeb\//.test(dicomWebPath)) {
    return {
      type: "hcapi",
      key: `hcapi:${dicomWebPath}`,
      displayPath: `https://healthcare.googleapis.com/v1/${dicomWebPath}`,
      publishDataBuffer: Buffer.from(dicomWebPath, "utf8"),
      publishAttributes: {
        ...(typeof attrs === "object" ? attrs : {}),
      },
    };
  }

  return null;
}

module.exports = {
  parseGsPath,
  extractDlqFileInfo,
  extractDlqRequeueTarget,
};
