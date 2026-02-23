const zlib = require("zlib");
const { promisify } = require("util");

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

const WS_PROTOCOL_VERSION = 1;
const WS_HEADER_SIZE = 32;
const WS_GZIP_THRESHOLD_BYTES = 32768;
const WS_COMPRESSION = Object.freeze({
  none: 0,
  gzip: 1,
});
const WS_PAYLOAD_TYPE = Object.freeze({
  json: 0,
  text: 1,
  binary: 2,
});
const EMPTY_WS_MESSAGE_ID = Buffer.alloc(16, 0);

function formatDurationMs(startNs) {
  return Number(process.hrtime.bigint() - startNs) / 1e6;
}

function formatWsMessageId(messageId) {
  if (!messageId || messageId.length !== 16) {
    return "unknown";
  }
  return messageId.toString("hex");
}

function getWsCompressionLabel(value) {
  if (value === WS_COMPRESSION.gzip) return "gzip";
  return "none";
}

function getWsPayloadTypeLabel(value) {
  if (value === WS_PAYLOAD_TYPE.text) return "text";
  if (value === WS_PAYLOAD_TYPE.binary) return "binary";
  return "json";
}

function chooseWsCompression(payloadLength, meta) {
  if (!payloadLength || payloadLength < WS_GZIP_THRESHOLD_BYTES) {
    return WS_COMPRESSION.none;
  }
  if (meta?.contentType === "image") {
    return WS_COMPRESSION.none;
  }
  return WS_COMPRESSION.gzip;
}

async function encodeWsFrame({ messageId, compression, payloadType, payloadBuffer }) {
  const header = Buffer.alloc(WS_HEADER_SIZE, 0);
  header.writeUInt8(WS_PROTOCOL_VERSION, 0);
  header.writeUInt8(0, 1);
  header.writeUInt8(compression, 2);
  header.writeUInt8(payloadType, 3);

  const safeMessageId = Buffer.isBuffer(messageId) && messageId.length === 16
    ? messageId
    : EMPTY_WS_MESSAGE_ID;
  safeMessageId.copy(header, 4);

  let body = Buffer.isBuffer(payloadBuffer) ? payloadBuffer : Buffer.from(payloadBuffer || "");
  let compressionValue = compression;
  if (compression === WS_COMPRESSION.gzip && body.length > 0) {
    try {
      body = await gzipAsync(body);
    } catch (_) {
      compressionValue = WS_COMPRESSION.none;
      header.writeUInt8(compressionValue, 2);
    }
  }

  header.writeUInt32BE(body.length, 20);
  return { frame: Buffer.concat([header, body]), compressedBytes: body.length };
}

async function decodeWsFrame(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (raw.length < WS_HEADER_SIZE) {
    throw new Error("WS frame too small");
  }

  const version = raw.readUInt8(0);
  if (version !== WS_PROTOCOL_VERSION) {
    throw new Error("Unsupported WS protocol version");
  }

  const compression = raw.readUInt8(2);
  const payloadType = raw.readUInt8(3);
  const messageId = raw.slice(4, 20);
  const payloadLength = raw.readUInt32BE(20);
  const payloadStart = WS_HEADER_SIZE;
  const payloadEnd = payloadStart + payloadLength;
  if (raw.length < payloadEnd) {
    throw new Error("WS frame payload incomplete");
  }

  let payloadBuffer = raw.slice(payloadStart, payloadEnd);
  if (compression === WS_COMPRESSION.gzip) {
    payloadBuffer = await gunzipAsync(payloadBuffer);
  } else if (compression !== WS_COMPRESSION.none) {
    throw new Error("Unsupported WS compression type");
  }

  return {
    messageId,
    messageIdHex: formatWsMessageId(messageId),
    compression,
    payloadType,
    payloadCompressedBytes: payloadLength,
    payloadBuffer,
  };
}

function buildBinaryPayload(meta, dataBuffer) {
  const metaJson = JSON.stringify(meta || {});
  const metaBuffer = Buffer.from(metaJson, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(metaBuffer.length, 0);
  return Buffer.concat([header, metaBuffer, dataBuffer]);
}

module.exports = {
  WS_COMPRESSION,
  WS_PAYLOAD_TYPE,
  formatDurationMs,
  getWsCompressionLabel,
  getWsPayloadTypeLabel,
  chooseWsCompression,
  encodeWsFrame,
  decodeWsFrame,
  buildBinaryPayload,
};
