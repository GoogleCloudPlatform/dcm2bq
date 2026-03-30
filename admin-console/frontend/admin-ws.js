/**
 * WebSocket management module for dcm2bq Admin Console.
 * Handles connection, reconnection, message encoding/decoding, and automatic recovery.
 */

const WS_PROTOCOL_VERSION = 1;
const WS_HEADER_SIZE = 32;
const WS_GZIP_THRESHOLD_BYTES = 32768;
const WS_RECONNECT_DELAY_MS = 1200;
const WS_STALE_CONNECT_MS = 10000;
const WS_COMPRESSION = Object.freeze({ none: 0, gzip: 1 });
const WS_PAYLOAD_TYPE = Object.freeze({ json: 0, text: 1, binary: 2 });
const WS_EMPTY_MESSAGE_ID = new Uint8Array(16);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const wsState = {
  socket: null,
  isOpen: false,
  connectPromise: null,
  connectStartedAt: 0,
  reconnectTimerId: null,
  pending: new Map(),
};

function createWsRequestError(message, fields = {}) {
  const error = new Error(message || 'WebSocket request failed');
  if (typeof fields.code !== 'undefined') error.code = fields.code;
  if (fields.action) error.action = fields.action;
  if (fields.requestId) error.requestId = fields.requestId;
  if (typeof fields.details !== 'undefined') error.details = fields.details;
  return error;
}

function formatRequestError(error) {
  const message = String(error?.message || 'Unknown error');
  const parts = [];
  if (typeof error?.code !== 'undefined') parts.push(`code ${error.code}`);
  if (error?.requestId) parts.push(`request ${error.requestId}`);
  return parts.length ? `${message} (${parts.join(', ')})` : message;
}

function createRequestId() {
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function chooseWsCompression(payloadLength) {
  if (payloadLength < WS_GZIP_THRESHOLD_BYTES) {
    return WS_COMPRESSION.none;
  }
  if (!window.CompressionStream || !window.DecompressionStream) {
    return WS_COMPRESSION.none;
  }
  return WS_COMPRESSION.gzip;
}

async function gzipBytes(bytes) {
  if (!window.CompressionStream) {
    throw new Error('CompressionStream is not available');
  }
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function gunzipBytes(bytes) {
  if (!window.DecompressionStream) {
    throw new Error('DecompressionStream is not available');
  }
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function encodeWsFrame({ messageIdBytes, payloadType, compression, payloadBytes }) {
  let finalPayload = payloadBytes;
  let compressionValue = compression;
  if (compression === WS_COMPRESSION.gzip) {
    try {
      finalPayload = await gzipBytes(payloadBytes);
    } catch (_) {
      finalPayload = payloadBytes;
      compressionValue = WS_COMPRESSION.none;
    }
  }

  const buffer = new ArrayBuffer(WS_HEADER_SIZE + finalPayload.length);
  const view = new DataView(buffer);
  view.setUint8(0, WS_PROTOCOL_VERSION);
  view.setUint8(1, 0);
  view.setUint8(2, compressionValue);
  view.setUint8(3, payloadType);
  const bytes = new Uint8Array(buffer);
  bytes.set(messageIdBytes || WS_EMPTY_MESSAGE_ID, 4);
  view.setUint32(20, finalPayload.length, false);
  bytes.set(finalPayload, WS_HEADER_SIZE);
  return buffer;
}

async function decodeWsFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('Invalid WS payload');
  }
  if (buffer.byteLength < WS_HEADER_SIZE) {
    throw new Error('WS frame too small');
  }
  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== WS_PROTOCOL_VERSION) {
    throw new Error('Unsupported WS protocol version');
  }
  const compression = view.getUint8(2);
  const payloadType = view.getUint8(3);
  const messageIdBytes = new Uint8Array(buffer.slice(4, 20));
  const payloadLength = view.getUint32(20, false);
  const payloadStart = WS_HEADER_SIZE;
  const payloadEnd = payloadStart + payloadLength;
  if (buffer.byteLength < payloadEnd) {
    throw new Error('WS frame payload incomplete');
  }
  let payloadBytes = new Uint8Array(buffer, payloadStart, payloadLength);
  if (compression === WS_COMPRESSION.gzip) {
    payloadBytes = await gunzipBytes(payloadBytes);
  } else if (compression !== WS_COMPRESSION.none) {
    throw new Error('Unsupported compression type');
  }
  return {
    messageIdBytes,
    messageIdHex: bytesToHex(messageIdBytes),
    payloadType,
    compression,
    payloadBytes,
  };
}

function parseBinaryPayload(payloadBytes) {
  if (payloadBytes.length < 4) {
    throw new Error('Binary payload too small');
  }
  const view = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
  const metaLength = view.getUint32(0, false);
  if (payloadBytes.length < 4 + metaLength) {
    throw new Error('Binary payload metadata incomplete');
  }
  const metaBytes = payloadBytes.slice(4, 4 + metaLength);
  const meta = JSON.parse(textDecoder.decode(metaBytes));
  const dataBytes = payloadBytes.slice(4 + metaLength);
  return { meta, dataBytes };
}

function buildBinaryPayload(meta, dataBytes) {
  const metaBytes = textEncoder.encode(JSON.stringify(meta || {}));
  const bodyBytes = dataBytes instanceof Uint8Array ? dataBytes : new Uint8Array(dataBytes || 0);
  const combined = new Uint8Array(4 + metaBytes.length + bodyBytes.length);
  const view = new DataView(combined.buffer);
  view.setUint32(0, metaBytes.length, false);
  combined.set(metaBytes, 4);
  combined.set(bodyBytes, 4 + metaBytes.length);
  return combined;
}

function setWsStatus(state, detail = '') {
  const node = document.getElementById('ws-status');
  if (!node) return;

  const states = {
    idle: { icon: 'fa-circle-minus', title: 'WebSocket: idle' },
    connecting: { icon: 'fa-circle-notch', title: 'WebSocket: connecting' },
    connected: { icon: 'fa-circle-check', title: 'WebSocket: connected' },
    disconnected: { icon: 'fa-circle-xmark', title: 'WebSocket: disconnected, reconnecting' },
    error: { icon: 'fa-triangle-exclamation', title: 'WebSocket: error' },
  };

  const config = states[state] || states.idle;
  node.classList.remove('idle', 'connecting', 'connected', 'disconnected', 'error');
  node.classList.add(state in states ? state : 'idle');

  const title = detail ? `${config.title} (${detail})` : config.title;
  node.title = title;
  node.setAttribute('aria-label', title);

  const iconNode = node.querySelector('i');
  if (iconNode) {
    iconNode.className = `fa-solid ${config.icon}`;
  }
}

function clearWsReconnectTimer() {
  if (wsState.reconnectTimerId) {
    clearTimeout(wsState.reconnectTimerId);
    wsState.reconnectTimerId = null;
  }
}

function isWsConnectStale() {
  if (!wsState.connectPromise || !wsState.connectStartedAt) return false;
  return (Date.now() - wsState.connectStartedAt) >= WS_STALE_CONNECT_MS;
}

function closeWsSocket(socket) {
  if (!socket) return;
  try {
    socket.close();
  } catch (_) {}
}

function resetWsConnectionState(socket = wsState.socket) {
  if (wsState.socket === socket) {
    wsState.socket = null;
  }
  wsState.isOpen = false;
  wsState.connectPromise = null;
  wsState.connectStartedAt = 0;
}

function scheduleWsReconnect(delay = WS_RECONNECT_DELAY_MS) {
  clearWsReconnectTimer();
  if (document.hidden) {
    setWsStatus('idle', 'waiting for page to become active');
    return;
  }
  wsState.reconnectTimerId = setTimeout(() => {
    wsState.reconnectTimerId = null;
    reconnectWebSocket('scheduled reconnect').catch(() => {});
  }, delay);
}

function reconnectWebSocket(reason = 'reconnect') {
  const socket = wsState.socket;
  const readyState = socket?.readyState;

  if (readyState === WebSocket.OPEN) {
    clearWsReconnectTimer();
    return Promise.resolve();
  }

  if (readyState === WebSocket.CONNECTING && wsState.connectPromise && !isWsConnectStale()) {
    return wsState.connectPromise;
  }

  if (socket && readyState !== WebSocket.CLOSED) {
    resetWsConnectionState(socket);
    closeWsSocket(socket);
  } else if (isWsConnectStale()) {
    resetWsConnectionState(socket);
  }

  return connectWebSocket(reason);
}

function handlePageActivated() {
  reconnectWebSocket('page became active').catch((error) => {
    setWsStatus(document.hidden ? 'idle' : 'error', formatRequestError(error));
    scheduleWsReconnect();
  });
}

function connectWebSocket() {
  if (wsState.socket && wsState.socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }

  if (wsState.connectPromise) {
    if (wsState.socket?.readyState === WebSocket.CONNECTING && !isWsConnectStale()) {
      return wsState.connectPromise;
    }

    const staleSocket = wsState.socket;
    resetWsConnectionState(staleSocket);
    closeWsSocket(staleSocket);
  }

  wsState.connectPromise = new Promise((resolve, reject) => {
    try {
      setWsStatus('connecting');
      wsState.connectStartedAt = Date.now();
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      socket.binaryType = 'arraybuffer';
      wsState.socket = socket;

      socket.addEventListener('open', () => {
        if (wsState.socket !== socket) {
          closeWsSocket(socket);
          return;
        }
        wsState.isOpen = true;
        wsState.connectStartedAt = 0;
        clearWsReconnectTimer();
        setWsStatus('connected');
        resolve();
      });

      socket.addEventListener('message', async (event) => {
        if (wsState.socket !== socket) return;
        if (!event.data || typeof event.data === 'string') {
          return;
        }

        let frame;
        try {
          frame = await decodeWsFrame(event.data);
        } catch (error) {
          console.warn('Failed to decode WS frame:', error);
          return;
        }

        const pending = wsState.pending.get(frame.messageIdHex);
        if (!pending) return;

        if (frame.payloadType === WS_PAYLOAD_TYPE.json) {
          let message;
          try {
            message = JSON.parse(textDecoder.decode(frame.payloadBytes));
          } catch (_) {
            wsState.pending.delete(frame.messageIdHex);
            pending.reject(createWsRequestError('Invalid JSON response from WebSocket', {
              action: pending.action,
              requestId: frame.messageIdHex,
            }));
            return;
          }

          if (message.type === 'progress') {
            if (pending.onProgress) pending.onProgress(message);
            return;
          }

          if (message.type === 'result') {
            wsState.pending.delete(frame.messageIdHex);
            pending.resolve(message.data);
            return;
          }

          if (message.type === 'error') {
            wsState.pending.delete(frame.messageIdHex);
            pending.reject(createWsRequestError(message.error || 'WebSocket request failed', {
              code: message.code,
              action: message.action || pending.action,
              requestId: message.requestId || frame.messageIdHex,
              details: message.details,
            }));
            return;
          }

          wsState.pending.delete(frame.messageIdHex);
          pending.reject(createWsRequestError(`Unsupported WebSocket message type: ${message.type || 'unknown'}`, {
            action: pending.action,
            requestId: frame.messageIdHex,
          }));
          return;
        }

        if (frame.payloadType === WS_PAYLOAD_TYPE.text) {
          const rawText = textDecoder.decode(frame.payloadBytes);
          const separatorIndex = rawText.indexOf('\n\n');
          let mimeType = 'text/plain';
          let text = rawText;
          if (separatorIndex > 0) {
            const header = rawText.slice(0, separatorIndex).trim();
            if (header.includes('/')) {
              mimeType = header;
              text = rawText.slice(separatorIndex + 2);
            }
          }
          wsState.pending.delete(frame.messageIdHex);
          pending.resolve({
            contentType: 'text',
            mimeType,
            text,
          });
          return;
        }

        if (frame.payloadType === WS_PAYLOAD_TYPE.binary) {
          let meta;
          let dataBytes;
          try {
            ({ meta, dataBytes } = parseBinaryPayload(frame.payloadBytes));
          } catch (error) {
            wsState.pending.delete(frame.messageIdHex);
            pending.reject(createWsRequestError('Invalid binary response from WebSocket', {
              action: pending.action,
              requestId: frame.messageIdHex,
            }));
            return;
          }

          if (meta?.type === 'error') {
            wsState.pending.delete(frame.messageIdHex);
            pending.reject(createWsRequestError(meta.error || 'WebSocket request failed', {
              code: meta.code,
              action: meta.action || pending.action,
              requestId: meta.requestId || frame.messageIdHex,
              details: meta.details,
            }));
            return;
          }

          if (meta?.contentType === 'image') {
            const mimeType = meta.mimeType || 'application/octet-stream';
            const blob = new Blob([dataBytes], { type: mimeType });
            const imageUrl = URL.createObjectURL(blob);
            wsState.pending.delete(frame.messageIdHex);
            pending.resolve({ contentType: 'image', mimeType, imageUrl });
            return;
          }

          if (meta?.contentType === 'text') {
            wsState.pending.delete(frame.messageIdHex);
            pending.resolve({
              contentType: 'text',
              mimeType: meta.mimeType || 'text/plain',
              text: textDecoder.decode(dataBytes),
            });
            return;
          }

          wsState.pending.delete(frame.messageIdHex);
          pending.reject(createWsRequestError('Unsupported binary response type', {
            action: pending.action,
            requestId: frame.messageIdHex,
          }));
        }
      });

      socket.addEventListener('close', () => {
        if (wsState.socket === socket) {
          resetWsConnectionState(socket);
        }
        setWsStatus(document.hidden ? 'idle' : 'disconnected');
        for (const [, pending] of wsState.pending) {
          pending.reject(createWsRequestError('WebSocket disconnected', { action: pending.action }));
        }
        wsState.pending.clear();
        scheduleWsReconnect();
      });

      socket.addEventListener('error', () => {
        if (wsState.socket !== socket) return;
        setWsStatus(document.hidden ? 'idle' : 'error');
        if (!wsState.isOpen) {
          resetWsConnectionState(socket);
          reject(new Error('WebSocket connection failed'));
        }
      });
    } catch (error) {
      resetWsConnectionState();
      reject(error);
    }
  });
  return wsState.connectPromise;
}

async function wsCall(action, payload = {}, options = {}) {
  await connectWebSocket();
  if (!wsState.socket || wsState.socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not connected');
  }

  const idBytes = createRequestId();
  const idHex = bytesToHex(idBytes);
  return await new Promise((resolve, reject) => {
    wsState.pending.set(idHex, {
      resolve,
      reject,
      action,
      onProgress: options.onProgress,
    });

    (async () => {
      const requestPayload = { action, payload };
      const payloadBytes = textEncoder.encode(JSON.stringify(requestPayload));
      const compression = chooseWsCompression(payloadBytes.length);
      const frame = await encodeWsFrame({
        messageIdBytes: idBytes,
        payloadType: WS_PAYLOAD_TYPE.json,
        compression,
        payloadBytes,
      });
      wsState.socket.send(frame);
    })().catch((error) => {
      wsState.pending.delete(idHex);
      reject(error);
    });
  });
}

async function wsCallBinary(action, payload = {}, dataBytes = new Uint8Array(0), options = {}) {
  await connectWebSocket();
  if (!wsState.socket || wsState.socket.readyState !== WebSocket.OPEN) {
    throw new Error('WebSocket is not connected');
  }

  const idBytes = createRequestId();
  const idHex = bytesToHex(idBytes);
  return await new Promise((resolve, reject) => {
    wsState.pending.set(idHex, {
      resolve,
      reject,
      action,
      onProgress: options.onProgress,
    });

    (async () => {
      const payloadBytes = buildBinaryPayload({ action, payload }, dataBytes);
      const compression = chooseWsCompression(payloadBytes.length);
      const frame = await encodeWsFrame({
        messageIdBytes: idBytes,
        payloadType: WS_PAYLOAD_TYPE.binary,
        compression,
        payloadBytes,
      });
      wsState.socket.send(frame);
    })().catch((error) => {
      wsState.pending.delete(idHex);
      reject(error);
    });
  });
}

function initializeWebSocket() {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      handlePageActivated();
    }
  });

  window.addEventListener('focus', () => {
    if (!document.hidden) {
      handlePageActivated();
    }
  });

  window.addEventListener('pageshow', () => {
    if (!document.hidden) {
      handlePageActivated();
    }
  });

  connectWebSocket().catch((error) => {
    setWsStatus('error', formatRequestError(error));
    scheduleWsReconnect();
  });
}
