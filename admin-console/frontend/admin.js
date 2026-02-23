    const tabs = [...document.querySelectorAll('.tab')];
    const panels = [...document.querySelectorAll('.panel')];
    const state = {
      studies: [],
      studyInstances: new Map(),
      instanceToStudy: new Map(),
      selectedStudyIds: new Set(),
      selectedInstanceIds: new Set(),
      openStudyIds: new Set(),
      studyLoadState: new Map(),
      dlq: [],
      dlpPaging: { limit: 50, offset: 0, total: 0 },
      lastSearchParams: { key: '', value: '', studyLimit: 50, studyOffset: 0 },
      lastTotals: { totalStudies: 0, totalInstances: 0 },
      monitoring: {
        enabled: false,
        interval: 10000,
        intervalId: null,
        history: [],
        charts: {},
      },
    };
    const wsState = {
      socket: null,
      isOpen: false,
      connectPromise: null,
      pending: new Map(),
    };
    const modalState = {
      currentData: null,
      objectUrl: null,
      copyFeedbackTimeoutId: null,
      errorDetails: null,
    };
    const authState = {
      isIap: false,
      email: null,
      userId: null,
      principal: null,
      logoutUrl: null,
    };

    const WS_PROTOCOL_VERSION = 1;
    const WS_HEADER_SIZE = 32;
    const WS_GZIP_THRESHOLD_BYTES = 32768;
    const WS_COMPRESSION = Object.freeze({ none: 0, gzip: 1 });
    const WS_PAYLOAD_TYPE = Object.freeze({ json: 0, text: 1, binary: 2 });
    const WS_EMPTY_MESSAGE_ID = new Uint8Array(16);
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    function setAuthPanelVisible(isVisible) {
      const panel = document.getElementById('auth-panel');
      if (!panel) return;
      panel.style.display = isVisible ? 'inline-flex' : 'none';
    }

    function updateAuthPanel() {
      const emailEl = document.getElementById('auth-user-email');
      const logoutEl = document.getElementById('auth-logout');
      if (!emailEl || !logoutEl) return;

      if (!authState.isIap) {
        setAuthPanelVisible(false);
        return;
      }

      const display = authState.email || authState.userId || authState.principal || '';
      emailEl.textContent = display;
      logoutEl.href = authState.logoutUrl || '/api/auth/logout';
      setAuthPanelVisible(Boolean(display));
    }

    async function loadAuthUser() {
      try {
        const response = await fetch('/api/auth/user');
        if (!response.ok) {
          setAuthPanelVisible(false);
          return;
        }
        const data = await response.json();
        authState.isIap = Boolean(data?.isIap);
        authState.email = data?.email || null;
        authState.userId = data?.userId || null;
        authState.principal = data?.principal || null;
        authState.logoutUrl = data?.logoutUrl || null;
        updateAuthPanel();
      } catch (error) {
        console.error('Failed to load auth user:', error);
        setAuthPanelVisible(false);
      }
    }

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

    function setModalCopyButtonState(stateName) {
      const btn = document.getElementById('modal-copy-btn');
      if (!btn) return;
      const icon = btn.querySelector('i');
      if (!icon) return;

      if (stateName === 'copied') {
        btn.title = 'Copied!';
        btn.setAttribute('aria-label', 'Copied');
        icon.className = 'fa-solid fa-check';
        return;
      }

      if (stateName === 'failed') {
        btn.title = 'Copy failed';
        btn.setAttribute('aria-label', 'Copy failed');
        icon.className = 'fa-solid fa-triangle-exclamation';
        return;
      }

      btn.title = 'Copy JSON to clipboard';
      btn.setAttribute('aria-label', 'Copy JSON');
      icon.className = 'fa-solid fa-copy';
    }

    function flashModalCopyFeedback(stateName, durationMs = 1800) {
      if (modalState.copyFeedbackTimeoutId) {
        clearTimeout(modalState.copyFeedbackTimeoutId);
        modalState.copyFeedbackTimeoutId = null;
      }
      setModalCopyButtonState(stateName);
      modalState.copyFeedbackTimeoutId = setTimeout(() => {
        setModalCopyButtonState('default');
        modalState.copyFeedbackTimeoutId = null;
      }, durationMs);
    }

    function getModalErrorDetails(data, title = '') {
      if (!data || typeof data !== 'object') return null;
      const isErrorDialog = String(title || '').toLowerCase().includes('error');
      if (!isErrorDialog) return null;

      const details = {
        message: data.error || data.message || null,
        code: typeof data.code !== 'undefined' ? data.code : null,
        action: data.action || null,
        requestId: data.requestId || null,
        details: typeof data.details !== 'undefined' ? data.details : null,
      };

      const hasAnyValue = Object.values(details).some((value) => value !== null);
      return hasAnyValue ? details : null;
    }

    function hideModalErrorPanel() {
      const panel = document.getElementById('modal-error-panel');
      const btn = document.getElementById('modal-error-btn');
      if (panel) panel.style.display = 'none';
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function renderModalErrorPanel(errorDetails) {
      const panelContent = document.getElementById('modal-error-panel-content');
      if (!panelContent) return;
      panelContent.textContent = JSON.stringify(errorDetails, null, 2);
    }

    function syncModalErrorControls() {
      const btn = document.getElementById('modal-error-btn');
      if (!btn) return;

      if (modalState.errorDetails) {
        btn.style.display = 'inline-flex';
        btn.setAttribute('aria-expanded', 'false');
        renderModalErrorPanel(modalState.errorDetails);
      } else {
        btn.style.display = 'none';
        hideModalErrorPanel();
      }
    }

    function activateTab(tabName) {
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabName));
      panels.forEach((panel) => panel.classList.toggle('active', panel.id === tabName));
    }

    tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

    function openModal(title, html, mode = 'default', data = null, objectUrl = null) {
      modalState.currentData = data;
      modalState.errorDetails = getModalErrorDetails(data, title);
      setModalObjectUrl(objectUrl);
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-copy-btn').style.display = data ? 'inline-block' : 'none';
      if (!data && modalState.copyFeedbackTimeoutId) {
        clearTimeout(modalState.copyFeedbackTimeoutId);
        modalState.copyFeedbackTimeoutId = null;
      }
      setModalCopyButtonState('default');
      syncModalErrorControls();
      document.getElementById('modal-content').innerHTML = html;
      const modalContent = document.querySelector('#modal .modal-content');
      modalContent.classList.toggle('compact', mode === 'compact');
      modalContent.classList.toggle('image-fit', mode === 'image-fit');
      modalContent.classList.toggle('content-fit', mode === 'content-fit');
      document.getElementById('modal').classList.add('open');
    }

    document.getElementById('modal-close').addEventListener('click', () => {
      const modalContent = document.querySelector('#modal .modal-content');
      modalContent.classList.remove('compact', 'image-fit', 'content-fit');
      document.getElementById('modal').classList.remove('open');
      hideModalErrorPanel();
      releaseModalObjectUrl();
    });

    document.getElementById('modal-error-btn').addEventListener('click', () => {
      if (!modalState.errorDetails) return;
      const panel = document.getElementById('modal-error-panel');
      const btn = document.getElementById('modal-error-btn');
      if (!panel || !btn) return;

      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      btn.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
    });

    document.getElementById('modal-copy-btn').addEventListener('click', async () => {
      if (!modalState.currentData) return;
      const btn = document.getElementById('modal-copy-btn');
      btn.disabled = true;
      try {
        await navigator.clipboard.writeText(JSON.stringify(modalState.currentData, null, 2));
        flashModalCopyFeedback('copied');
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        flashModalCopyFeedback('failed');
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('modal').addEventListener('click', (event) => {
      if (event.target.id !== 'modal') return;
      const modalContent = document.querySelector('#modal .modal-content');
      modalContent.classList.remove('compact', 'image-fit', 'content-fit');
      document.getElementById('modal').classList.remove('open');
      hideModalErrorPanel();
      releaseModalObjectUrl();
    });

    document.addEventListener('click', (event) => {
      const panel = document.getElementById('modal-error-panel');
      const button = document.getElementById('modal-error-btn');
      if (!panel || !button || panel.style.display === 'none') return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      hideModalErrorPanel();
    });

    function setModalObjectUrl(url) {
      releaseModalObjectUrl();
      if (url) {
        modalState.objectUrl = url;
      }
    }

    function releaseModalObjectUrl() {
      if (modalState.objectUrl) {
        URL.revokeObjectURL(modalState.objectUrl);
        modalState.objectUrl = null;
      }
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

    function connectWebSocket() {
      if (wsState.connectPromise) return wsState.connectPromise;
      wsState.connectPromise = new Promise((resolve, reject) => {
        try {
          setWsStatus('connecting');
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
          socket.binaryType = 'arraybuffer';
          wsState.socket = socket;

          socket.addEventListener('open', () => {
            wsState.isOpen = true;
            setWsStatus('connected');
            resolve();
          });

          socket.addEventListener('message', async (event) => {
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
            wsState.isOpen = false;
            setWsStatus('disconnected');
            wsState.connectPromise = null;
            for (const [, pending] of wsState.pending) {
              pending.reject(createWsRequestError('WebSocket disconnected', { action: pending.action }));
            }
            wsState.pending.clear();
            setTimeout(() => connectWebSocket().catch(() => {}), 1200);
          });

          socket.addEventListener('error', () => {
            setWsStatus('error');
            if (!wsState.isOpen) {
              wsState.connectPromise = null;
              reject(new Error('WebSocket connection failed'));
            }
          });
        } catch (error) {
          wsState.connectPromise = null;
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

    function updatePaginationControls() {
      const { totalStudies } = state.lastTotals;
      const { studyLimit, studyOffset } = state.lastSearchParams;
      const showingStart = totalStudies > 0 ? studyOffset + 1 : 0;
      const showingEnd = Math.min(studyOffset + studyLimit, totalStudies);
      document.getElementById('study-page-info').textContent = totalStudies > 0
        ? `${showingStart}-${showingEnd} of ${totalStudies}`
        : '0 of 0';
      document.getElementById('studies-prev').disabled = studyOffset <= 0;
      document.getElementById('studies-next').disabled = showingEnd >= totalStudies;
    }

    function getSopClassIcon(sopClassUid, modality = '') {
      if (!sopClassUid) return { icon: 'fa-solid fa-circle-question', label: 'Unknown' };
      const uid = String(sopClassUid).toLowerCase();
      const normalizedModality = String(modality || '').toUpperCase();
      const storageRoot = '1.2.840.10008.5.1.4.1.1.';
      const subtype = uid.startsWith(storageRoot) ? uid.slice(storageRoot.length) : '';
      if (/^(1\.1|1\.2)(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-image', label: '2D Image' };
      if (/^(2|4)(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-cube', label: '3D Volume' };
      if (/^(3|12\.1)(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-film', label: 'CINE / Video' };
      if (/^7(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-desktop', label: 'Secondary Capture' };
      if (/^11(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-glasses', label: 'Presentation State' };
      if (/^88(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-clipboard', label: 'Structured Report' };
      if (/^66(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-puzzle-piece', label: 'Segmentation' };
      if (/^9(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-heart-pulse', label: 'Waveform' };
      if (/^104(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-file-lines', label: 'Document' };
      if (/^(481|482|483|484)(?:\.[0-9]+)?$/.test(subtype)) return { icon: 'fa-solid fa-radiation', label: 'Radiotherapy' };

      if (normalizedModality === 'SC') return { icon: 'fa-solid fa-desktop', label: 'Secondary Capture' };
      if (normalizedModality === 'OT') return { icon: 'fa-solid fa-file-lines', label: 'Document' };
      if (normalizedModality === 'PR') return { icon: 'fa-solid fa-glasses', label: 'Presentation State' };
      if (normalizedModality === 'KO') return { icon: 'fa-solid fa-clipboard', label: 'Structured Report' };

      return { icon: 'fa-solid fa-cube', label: 'Object' };
    }

    function getTransferSyntaxIcon(transferSyntaxUid) {
      if (!transferSyntaxUid) return { icon: 'fa-solid fa-circle-question', label: 'Unknown' };
      const uid = String(transferSyntaxUid).toLowerCase();
      const uncompressed = uid.startsWith('1.2.840.10008.1.2')
        && !uid.startsWith('1.2.840.10008.1.2.4')
        && !uid.startsWith('1.2.840.10008.1.2.5');
      if (uncompressed) return { icon: 'fa-solid fa-database', label: 'Uncompressed' };
      return { icon: 'fa-solid fa-file-zipper', label: 'Compressed' };
    }

    function applySelectAllLoaded(checked) {
      state.studies.forEach((study) => {
        if (!study.studyId) return;
        if (checked) {
          state.selectedStudyIds.add(study.studyId);
        } else {
          state.selectedStudyIds.delete(study.studyId);
        }
      });

      document.querySelectorAll('.study-check').forEach((checkbox) => {
        checkbox.checked = checked;
      });

      document.querySelectorAll('.instance-check').forEach((checkbox) => {
        checkbox.checked = checked;
        if (checked) {
          state.selectedInstanceIds.add(checkbox.value);
        } else {
          state.selectedInstanceIds.delete(checkbox.value);
        }
      });

      syncSelectionControls();
    }

    function syncSelectionControls() {
      const visibleStudyIds = state.studies
        .map((study) => study.studyId)
        .filter(Boolean);
      const loadedInstanceIds = [...state.studyInstances.values()]
        .flatMap((items) => items.map((item) => item?.id).filter(Boolean));

      const selectedVisibleStudies = visibleStudyIds.filter((id) => state.selectedStudyIds.has(id)).length;
      const selectedLoadedInstances = loadedInstanceIds.filter((id) => state.selectedInstanceIds.has(id)).length;

      const hasStudies = visibleStudyIds.length > 0;
      const hasLoadedInstances = loadedInstanceIds.length > 0;

      const allStudiesSelected = hasStudies && selectedVisibleStudies === visibleStudyIds.length;
      const allLoadedInstancesSelected = hasLoadedInstances && selectedLoadedInstances === loadedInstanceIds.length;
      const allSelected = allStudiesSelected && (!hasLoadedInstances || allLoadedInstancesSelected);
      const anySelected = selectedVisibleStudies > 0 || selectedLoadedInstances > 0;

      const selectAllStudies = document.getElementById('select-all-studies');
      if (selectAllStudies) {
        selectAllStudies.checked = allStudiesSelected;
        selectAllStudies.indeterminate = selectedVisibleStudies > 0 && !allStudiesSelected;
      }

      const selectAllInstances = document.getElementById('select-all-instances');
      if (selectAllInstances) {
        selectAllInstances.checked = allLoadedInstancesSelected;
        selectAllInstances.indeterminate = selectedLoadedInstances > 0 && !allLoadedInstancesSelected;
      }

      const selectAllHeader = document.getElementById('select-all-header');
      if (selectAllHeader) {
        selectAllHeader.checked = allSelected;
        selectAllHeader.indeterminate = anySelected && !allSelected;
      }

      const bulkAction = document.getElementById('study-bulk-action');
      const bulkApply = document.getElementById('study-bulk-apply');
      const hasSelectedStudies = state.selectedStudyIds.size > 0;
      if (bulkAction) {
        bulkAction.disabled = !hasSelectedStudies;
        if (!hasSelectedStudies) {
          bulkAction.value = '';
        }
      }
      if (bulkApply) {
        const selectedAction = bulkAction ? bulkAction.value : '';
        bulkApply.disabled = !hasSelectedStudies || !selectedAction;
      }
    }

    function inferContentKind(item) {
      const input = item?.info?.embedding?.input || {};
      const mimeType = String(input.mimeType || '').trim().toLowerCase();
      const sourcePath = String(input.path || item?.path || '').trim().toLowerCase();

      if (mimeType.startsWith('image/')) return 'image';
      if (mimeType.startsWith('text/')) return 'text';
      if (mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('html') || mimeType.includes('csv')) {
        return 'text';
      }

      if (/\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(sourcePath)) return 'image';
      if (/\.(txt|md|json|xml|html?|csv|log)$/i.test(sourcePath)) return 'text';

      return 'content';
    }

    function getContentActionUi(item) {
      const contentKind = inferContentKind(item);
      if (contentKind === 'image') {
        return { title: 'View Image', iconClass: 'fa-solid fa-eye' };
      }
      if (contentKind === 'text') {
        return { title: 'View Text', iconClass: 'fa-solid fa-eye' };
      }
      return { title: 'View Content', iconClass: 'fa-solid fa-eye' };
    }

    function renderStudies() {
      const container = document.getElementById('instances-body');
      container.innerHTML = '';

      if (!state.studies.length) {
        const emptyTemplate = document.getElementById('instance-empty-template');
        container.appendChild(emptyTemplate.content.cloneNode(true));
        syncSelectionControls();
        return;
      }

      // Add studies header
      const header = document.createElement('div');
      header.className = 'studies-header-row';
      header.style.cssText = 'display: flex; gap: 10px; align-items: center; padding: 10px; background: var(--surface-alt); font-weight: 600; font-size: 13px; margin-bottom: 12px; border-radius: 6px; border: 1px solid var(--border);';
      header.innerHTML = `
        <div style="flex: 0 0 40px; text-align: center;"><input type="checkbox" id="select-all-header" title="Select all loaded studies and instances" aria-label="Select all loaded studies and instances" /></div>
        <div style="flex: 0 0 20px;"></div>
        <div style="flex: 1; min-width: 0;">Patient Name</div>
        <div style="flex: 0 0 120px;">Patient ID</div>
        <div style="flex: 0 0 120px;">Accession #</div>
        <div style="flex: 0 0 130px;">Study Date</div>
        <div style="flex: 0 0 85px;">Study Time</div>
        <div style="flex: 1; min-width: 0;">Study Description</div>
        <div style="flex: 0 0 110px;">Modalities</div>
        <div style="flex: 0 0 70px; display: flex; align-items: center; justify-content: center;" title="Number of series" aria-label="Number of series"><i class="fa-solid fa-cubes" aria-hidden="true"></i></div>
        <div style="flex: 0 0 80px; display: flex; align-items: center; justify-content: center;" title="Number of instances" aria-label="Number of instances"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></div>
        <div style="flex: 0 0 90px; text-align: center;">Actions</div>
      `;
      container.appendChild(header);

      const studyTemplate = document.getElementById('study-group-template');
      const seriesTemplate = document.getElementById('series-group-template');
      const rowTemplate = document.getElementById('instance-row-template');

      state.studies.forEach((study) => {
        const studyUid = study.studyId || 'UNKNOWN_STUDY';
        const studyNode = studyTemplate.content.cloneNode(true);
        const studyDetails = studyNode.querySelector('details');
        const studySummary = studyNode.querySelector('summary');
        const seriesContainer = studyNode.querySelector('.series-container');
        studySummary.classList.add('studies-summary-row');

        studyDetails.dataset.studyId = studyUid;
        studyDetails.open = state.openStudyIds.has(studyUid);

        const patient = study.patientName || study.patientId || 'Unknown patient';
        const patientId = study.patientId || '—';
        const accessionNumber = study.accessionNumber || '—';
        const studyTime = study.studyTime || '—';
        const studyDate = study.studyDate || 'Unknown date';
        const studyDesc = study.studyDescription || '';
        const studyModalities = study.studyModalities || '';
        const modalitiesDisplay = studyModalities || '—';
        const studyDescDisplay = studyDesc || '—';
        const instanceCount = Number(study.instanceCount || 0);
        const seriesCount = Number(study.seriesCount || 0);
        const studyChecked = state.selectedStudyIds.has(studyUid) ? 'checked' : '';
        const downloadTitle = 'Download study source data';
        studySummary.innerHTML = `
          <div style="flex: 0 0 40px; text-align: center;"><input type="checkbox" class="study-check" data-study-id="${escapeHtml(studyUid)}" ${studyChecked} /></div>
          <div style="flex: 0 0 20px; display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-chevron-right chevron" aria-hidden="true"></i></div>
          <div style="flex: 1; min-width: 0;"><span class="cell-ellipsis" title="${escapeHtml(patient)}">${escapeHtml(patient)}</span></div>
          <div style="flex: 0 0 120px;"><span class="cell-ellipsis" title="${escapeHtml(patientId)}">${escapeHtml(patientId)}</span></div>
          <div style="flex: 0 0 120px;"><span class="cell-ellipsis" title="${escapeHtml(accessionNumber)}">${escapeHtml(accessionNumber)}</span></div>
          <div style="flex: 0 0 130px;"><span class="cell-ellipsis" title="${escapeHtml(studyDate)}">${escapeHtml(studyDate)}</span></div>
          <div style="flex: 0 0 85px;"><span class="cell-ellipsis" title="${escapeHtml(studyTime)}">${escapeHtml(studyTime)}</span></div>
          <div style="flex: 1; min-width: 0;"><span class="cell-ellipsis" title="${escapeHtml(studyDescDisplay)}">${escapeHtml(studyDescDisplay)}</span></div>
          <div style="flex: 0 0 110px;"><span class="cell-ellipsis" title="${escapeHtml(modalitiesDisplay)}">${escapeHtml(modalitiesDisplay)}</span></div>
          <div style="flex: 0 0 70px; text-align: center;"><strong>${seriesCount}</strong></div>
          <div style="flex: 0 0 80px; text-align: center;"><strong>${instanceCount}</strong></div>
          <div style="flex: 0 0 90px; text-align: center;">
            <div class="icon-btn-group">
              <button class="icon-btn" data-action="study-download" data-study-id="${escapeHtml(studyUid)}" title="${escapeHtml(downloadTitle)}" aria-label="${escapeHtml(downloadTitle)}"><i class="fa-solid fa-download" aria-hidden="true"></i></button>
              <button class="icon-btn" data-action="study-metadata" data-study-id="${escapeHtml(studyUid)}" title="View normalized study metadata"><i class="fa-solid fa-code" aria-hidden="true"></i></button>
            </div>
          </div>
        `;

        const loadState = state.studyLoadState.get(studyUid);
        const studyItems = state.studyInstances.get(studyUid);

        if (studyItems && Array.isArray(studyItems)) {
          renderStudyInstances(seriesContainer, studyItems, seriesTemplate, rowTemplate);
        } else if (loadState?.status === 'loading') {
          seriesContainer.innerHTML = '<div class="muted">Loading instances...</div>';
        } else if (loadState?.status === 'error') {
          seriesContainer.innerHTML = `<div class="muted">Failed to load instances: ${escapeHtml(loadState.message || 'unknown error')}</div>`;
        } else {
          seriesContainer.innerHTML = '<div class="muted">Expand to load instances.</div>';
        }

        container.appendChild(studyNode);
      });

      syncSelectionControls();
    }

    function renderStudyInstances(container, studyItems, seriesTemplate, rowTemplate) {
      container.innerHTML = '';
      const seriesMap = new Map();
      for (const item of studyItems) {
        const seriesUid = item?.metadata?.SeriesInstanceUID || 'UNKNOWN_SERIES';
        if (!seriesMap.has(seriesUid)) seriesMap.set(seriesUid, []);
        seriesMap.get(seriesUid).push(item);
      }

      // Add series header
      const seriesHeader = document.createElement('div');
      seriesHeader.style.cssText = 'display: flex; align-items: center; padding: 8px; background: var(--surface-muted); font-weight: 500; font-size: 12px; border-bottom: 1px solid var(--border); margin-bottom: 0;';
      seriesHeader.innerHTML = `
        <div style="width: 20px; flex-shrink: 0; text-align: center; color: transparent;">•</div>
        <div style="flex: 2; min-width: 300px; margin-right: 16px; text-align: left;">Series UID</div>
        <div style="width: 80px; margin-right: 16px; text-align: left;">Modality</div>
        <div style="width: 80px; margin-right: 16px; text-align: center;" title="Number of instances" aria-label="Number of instances"><i class="fa-solid fa-layer-group" aria-hidden="true"></i></div>
        <div style="flex: 1; margin-right: 16px; text-align: left; min-width: 0;">Series Description</div>
        <div style="width: 90px; text-align: center;">Series Type</div>
      `;
      container.appendChild(seriesHeader);

      const clinicalModalityOrder = [
        'CT',
        'MR',
        'PT',
        'NM',
        'US',
        'XA',
        'RF',
        'CR',
        'DX',
        'MG',
        'SC',
        'PR',
        'KO',
        'SR',
        'SEG',
        'RTSTRUCT',
        'RTPLAN',
        'RTDOSE',
        'RTIMAGE',
        'OT',
      ];
      const modalityRank = new Map(clinicalModalityOrder.map((code, index) => [code, index]));

      const sortedSeriesEntries = [...seriesMap.entries()].sort(([seriesUidA, seriesItemsA], [seriesUidB, seriesItemsB]) => {
        const modalityA = String(seriesItemsA?.[0]?.metadata?.Modality || '').toUpperCase();
        const modalityB = String(seriesItemsB?.[0]?.metadata?.Modality || '').toUpperCase();
        const rankA = modalityRank.has(modalityA) ? modalityRank.get(modalityA) : Number.MAX_SAFE_INTEGER;
        const rankB = modalityRank.has(modalityB) ? modalityRank.get(modalityB) : Number.MAX_SAFE_INTEGER;

        if (rankA !== rankB) return rankA - rankB;

        const modalityCompare = modalityA.localeCompare(modalityB);
        if (modalityCompare !== 0) return modalityCompare;

        return String(seriesUidA || '').localeCompare(String(seriesUidB || ''));
      });

      sortedSeriesEntries.forEach(([seriesUid, seriesItems]) => {
        const seriesNode = seriesTemplate.content.cloneNode(true);
        const seriesSummary = seriesNode.querySelector('summary');
        const seriesBody = seriesNode.querySelector('tbody');

        const seriesMeta = seriesItems[0]?.metadata || {};
        const modality = seriesMeta.Modality || 'Unknown';
        const seriesDesc = seriesMeta.SeriesDescription || '';
        const sopClassUid = seriesMeta.SOPClassUID || '';
        const transferSyntaxUid = seriesMeta.TransferSyntaxUID || '';
        const sopClassInfo = getSopClassIcon(sopClassUid, modality);
        const transferInfo = getTransferSyntaxIcon(transferSyntaxUid);
        const compressionClass = transferInfo?.label === 'Compressed' ? 'compressed' : 'uncompressed';
        const typeTitleParts = [sopClassInfo?.label, transferInfo?.label].filter(Boolean);
        const typeTitleText = typeTitleParts.length ? typeTitleParts.join(' • ') : 'Unknown type';
        const typeCompressionIcon = transferInfo?.label === 'Compressed' ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
        const typeIconsHtml = `<span class="series-type-chip ${compressionClass}" aria-hidden="true"><i class="${sopClassInfo?.icon || 'fa-solid fa-circle-question'} type-icon"></i><i class="${typeCompressionIcon} series-type-compression"></i></span>`;
        seriesSummary.innerHTML = `
          <div style="width: 20px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;"><i class="fa-solid fa-chevron-right chevron" aria-hidden="true"></i></div>
          <div style="flex: 2; min-width: 300px; margin-right: 16px; text-align: left; overflow: hidden;"><span class="truncate" title="${escapeHtml(seriesUid)}">${escapeHtml(seriesUid)}</span></div>
          <div style="width: 80px; margin-right: 16px; text-align: left;"><strong>${escapeHtml(modality)}</strong></div>
          <div style="width: 80px; margin-right: 16px; text-align: center;"><strong>${seriesItems.length}</strong></div>
          <div style="flex: 1; margin-right: 16px; text-align: left; min-width: 0; overflow: hidden;">${escapeHtml(seriesDesc || '')}</div>
          <div style="width: 90px; display: flex; gap: 8px; align-items: center; justify-content: center;" title="${escapeHtml(typeTitleText)}">${typeIconsHtml}</div>
        `;

        const sortedItems = [...seriesItems].sort((a, b) => {
          const uidA = a?.metadata?.SOPInstanceUID || '';
          const uidB = b?.metadata?.SOPInstanceUID || '';
          return uidA.localeCompare(uidB);
        });

        sortedItems.forEach((item) => {
          const metadata = item.metadata || {};
          const info = item.info || {};
          const sopInstanceUid = metadata.SOPInstanceUID || 'N/A';

          const input = info?.embedding?.input;
          const hasContentInput = !!input?.path;
          const contentActionUi = getContentActionUi(item);
          const emb = item.hasEmbeddingVector
            ? `Vector: ${item.embeddingVectorLength} dims`
            : 'Vector: none';

          const rowNode = rowTemplate.content.cloneNode(true);
          const cells = rowNode.querySelectorAll('td');
          const checked = state.selectedInstanceIds.has(item.id) ? 'checked' : '';
          cells[0].innerHTML = `<input type="checkbox" class="instance-check" value="${item.id}" data-study-id="${escapeHtml(item.metadata?.StudyInstanceUID || '')}" ${checked} />`;
          cells[1].innerHTML = `<span class="muted" style="font-size:12px;" title="${escapeHtml(sopInstanceUid)}">${escapeHtml(sopInstanceUid.split('.').pop())}</span>`;
          cells[2].textContent = item.timestamp?.value || item.timestamp || '';
          cells[3].innerHTML = `${emb}`;
          cells[4].innerHTML = `<div class="icon-btn-group">
              <button class="icon-btn" data-action="content" data-id="${item.id}" title="${escapeHtml(contentActionUi.title)}" aria-label="${escapeHtml(contentActionUi.title)}" ${hasContentInput ? '' : 'disabled'}><i class="${contentActionUi.iconClass}" aria-hidden="true"></i></button>
              <button class="icon-btn" data-action="detail" data-id="${item.id}" title="View raw data" aria-label="View raw data"><i class="fa-solid fa-database" aria-hidden="true"></i></button>
            </div>`;

          seriesBody.appendChild(rowNode);
        });

        container.appendChild(seriesNode);
      });
    }

    async function runSearch(options = {}) {
      const { resetOffset = true, overrideOffset = null } = options;
      const key = document.getElementById('search-key').value.trim();
      const value = document.getElementById('search-value').value.trim();
      const studyLimit = 50; // Fixed page size for studies
      const studyOffset = overrideOffset !== null
        ? overrideOffset
        : (resetOffset ? 0 : state.lastSearchParams.studyOffset || 0);

      state.lastSearchParams = { key, value, studyLimit, studyOffset };
      const searchBtn = document.getElementById('search-btn');
      const searchStatus = document.getElementById('search-status');
      searchBtn.disabled = true;
      try {
        const result = await wsCall('studies.search', { key, value, studyLimit, studyOffset });
        state.studies = result.items || [];
        state.lastTotals = {
          totalStudies: Number(result.totalStudies || 0),
          totalInstances: Number(result.totalInstances || 0),
        };
        state.studyInstances.clear();
        state.instanceToStudy.clear();
        state.selectedStudyIds.clear();
        state.selectedInstanceIds.clear();
        state.openStudyIds.clear();
        state.studyLoadState.clear();

        renderStudies();
        updatePaginationControls();
        if (searchStatus) {
          searchStatus.textContent = '';
        }
      } catch (error) {
        console.error('Search failed:', error);
        if (searchStatus) {
          searchStatus.textContent = `Search failed: ${formatRequestError(error)}`;
        }
      } finally {
        searchBtn.disabled = false;
      }
    }

    function findLoadedInstance(id) {
      for (const items of state.studyInstances.values()) {
        const found = items.find((item) => item.id === id);
        if (found) return found;
      }
      return null;
    }

    async function loadStudyInstances(studyId) {
      if (!studyId) return;
      if (state.studyInstances.has(studyId)) return;
      if (state.studyLoadState.get(studyId)?.status === 'loading') return;

      state.studyLoadState.set(studyId, { status: 'loading' });
      renderStudies();
      try {
        const result = await wsCall('studies.instances', { studyId, limit: 5000 });
        const items = result.items || [];
        state.studyInstances.set(studyId, items);
        items.forEach((item) => {
          if (item?.id) state.instanceToStudy.set(item.id, studyId);
        });
        state.studyLoadState.delete(studyId);
        renderStudies();
      } catch (error) {
        state.studyLoadState.set(studyId, { status: 'error', message: formatRequestError(error) });
        renderStudies();
      }
    }

    function parseDownloadFilename(contentDisposition, fallback = 'study-archive') {
      if (!contentDisposition) return fallback;
      const match = String(contentDisposition).match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      if (!match) return fallback;
      const value = match[1] || match[2] || fallback;
      try {
        return decodeURIComponent(value);
      } catch (_) {
        return value;
      }
    }

    async function downloadStudyArchive(studyId) {
      const response = await fetch(`/api/studies/${encodeURIComponent(studyId)}/download`);
      if (!response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch (_) {}
        throw createWsRequestError(payload?.reason || payload?.error || `HTTP ${response.status}`, {
          code: response.status,
          action: 'studies.download',
          details: payload || undefined,
        });
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition');
      const fileName = parseDownloadFilename(disposition, `${studyId}.zip`);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    }

    document.getElementById('search-btn').addEventListener('click', runSearch);

    document.getElementById('studies-prev').addEventListener('click', () => {
      const { studyLimit, studyOffset } = state.lastSearchParams;
      const nextOffset = Math.max(studyOffset - studyLimit, 0);
      runSearch({ resetOffset: false, overrideOffset: nextOffset });
    });

    document.getElementById('studies-next').addEventListener('click', () => {
      const { studyLimit, studyOffset } = state.lastSearchParams;
      const nextOffset = studyOffset + studyLimit;
      runSearch({ resetOffset: false, overrideOffset: nextOffset });
    });

    document.getElementById('instances-body').addEventListener('click', async (evt) => {
      if (evt.target.classList.contains('study-check')) {
        evt.stopPropagation();
        return;
      }
      const button = evt.target.closest('button');
      if (!button) return;
      const action = button.dataset.action;

      if (action === 'study-metadata') {
        evt.preventDefault();
        evt.stopPropagation();
        const studyId = button.dataset.studyId;
        if (!studyId) return;
        try {
          const normalized = await wsCall('studies.metadata', { studyId });
          openModal('Study Metadata (Normalized JSON)', renderCollapsibleJson(normalized), 'default', normalized);
        } catch (error) {
          const errorData = {
            error: formatRequestError(error),
            code: error.code,
            action: error.action,
            requestId: error.requestId,
            details: error.details,
          };
          openModal('Error', renderCollapsibleJson(errorData), 'default', errorData);
        }
        return;
      }

      if (action === 'study-download') {
        evt.preventDefault();
        evt.stopPropagation();
        const studyId = button.dataset.studyId;
        if (!studyId) return;
        button.disabled = true;
        try {
          await downloadStudyArchive(studyId);
        } catch (error) {
          const errorData = {
            error: formatRequestError(error),
            code: error.code,
            action: error.action,
            requestId: error.requestId,
            details: error.details,
          };
          openModal('Error', renderCollapsibleJson(errorData), 'default', errorData);
        } finally {
          button.disabled = false;
        }
        return;
      }

      const id = button.dataset.id;
      const item = findLoadedInstance(id);
      if (!item) return;

      try {
        if (action === 'detail') {
          const detail = await wsCall('instances.get', { id });
          openModal('JSON Details', renderCollapsibleJson(detail), 'default', detail);
          return;
        }

        if (action === 'content') {
          const dicomUIDs = {
            studyUid: item.metadata?.StudyInstanceUID,
            seriesUid: item.metadata?.SeriesInstanceUID,
            sopInstanceUid: item.metadata?.SOPInstanceUID,
          };
          const hasAllUIDs = dicomUIDs.studyUid && dicomUIDs.seriesUid && dicomUIDs.sopInstanceUid;
          const content = await wsCall('instances.content', hasAllUIDs ? dicomUIDs : { id });
          if (content.contentType === 'image') {
            const imageUrl = content.imageUrl
              ? content.imageUrl
              : `data:${content.mimeType};base64,${content.dataBase64}`;
            const objectUrl = content.imageUrl ? content.imageUrl : null;
            openModal('Image Content', `<div><img class="preview" src="${imageUrl}" /></div>`, 'image-fit', null, objectUrl);
          } else {
            const formattedText = formatTextContentForDisplay(content.text, content.mimeType);
            openModal('Text Content', `<div class="content-text" title="${escapeHtml(content.mimeType || 'text/plain')}">${formattedText}</div>`, 'content-fit');
          }
        }
      } catch (error) {
        const errorData = {
          error: formatRequestError(error),
          code: error.code,
          action: error.action,
          requestId: error.requestId,
          details: error.details,
        };
        openModal('Error', renderCollapsibleJson(errorData), 'default', errorData);
      }
    });

    document.getElementById('instances-body').addEventListener('toggle', (evt) => {
      const details = evt.target;
      if (!details || details.tagName !== 'DETAILS') return;
      const studyId = details.dataset.studyId;
      if (!studyId) return;
      if (details.open) {
        state.openStudyIds.add(studyId);
        loadStudyInstances(studyId);
      } else {
        state.openStudyIds.delete(studyId);
      }
    }, true);

    document.getElementById('instances-body').addEventListener('change', (evt) => {
      if (evt.target.id === 'select-all-header') {
        applySelectAllLoaded(evt.target.checked);
        return;
      }

      const studyCheck = evt.target.closest('.study-check');
      if (studyCheck) {
        const studyId = studyCheck.dataset.studyId;
        if (!studyId) return;
        if (studyCheck.checked) {
          state.selectedStudyIds.add(studyId);
        } else {
          state.selectedStudyIds.delete(studyId);
        }

        const details = studyCheck.closest('details');
        if (details) {
          details.querySelectorAll('.instance-check').forEach((checkbox) => {
            checkbox.checked = studyCheck.checked;
            if (studyCheck.checked) {
              state.selectedInstanceIds.add(checkbox.value);
            } else {
              state.selectedInstanceIds.delete(checkbox.value);
            }
          });
        }
        syncSelectionControls();
        return;
      }

      const instanceCheck = evt.target.closest('.instance-check');
      if (instanceCheck) {
        const instanceId = instanceCheck.value;
        if (instanceCheck.checked) {
          state.selectedInstanceIds.add(instanceId);
        } else {
          state.selectedInstanceIds.delete(instanceId);
        }

        const studyId = instanceCheck.dataset.studyId || state.instanceToStudy.get(instanceId);
        if (studyId && !instanceCheck.checked && state.selectedStudyIds.has(studyId)) {
          state.selectedStudyIds.delete(studyId);
          const studyBox = document.querySelector(`.study-check[data-study-id="${CSS.escape(studyId)}"]`);
          if (studyBox) studyBox.checked = false;
        }

        syncSelectionControls();
      }
    });

    document.getElementById('study-bulk-action').addEventListener('change', () => {
      syncSelectionControls();
    });

    document.getElementById('study-bulk-apply').addEventListener('click', async () => {
      const studyIds = [...state.selectedStudyIds];
      const instanceIds = [...state.selectedInstanceIds].filter((id) => {
        const studyId = state.instanceToStudy.get(id);
        return !studyId || !state.selectedStudyIds.has(studyId);
      });

      const bulkAction = document.getElementById('study-bulk-action');
      const action = bulkAction?.value || '';
      if (!action || !studyIds.length) return;

      if (action === 'delete') {
        const parts = [];
        if (studyIds.length) parts.push(`${studyIds.length} study(ies)`);
        if (instanceIds.length) parts.push(`${instanceIds.length} instance(s)`);
        if (!confirm(
          `You are about to permanently delete ${parts.join(' and ')}.\n\n` +
          `This action cannot be undone. Continue?`,
        )) return;
      }

      if (action === 'reprocess' && !confirm(
        `You are about to request reprocessing for ${studyIds.length} study(ies).\n\n` +
        `This will update source-object metadata and trigger processing. Continue?`,
      )) {
        return;
      }

      const btn = document.getElementById('study-bulk-apply');
      btn.disabled = true;
      try {
        if (action === 'delete') {
          if (studyIds.length) {
            await wsCall('studies.delete', { studyIds });
          }
          if (instanceIds.length) {
            await wsCall('instances.delete', { ids: instanceIds });
          }
          state.selectedStudyIds.clear();
          state.selectedInstanceIds.clear();
          renderStudies();
          updatePaginationControls();
          if (bulkAction) bulkAction.value = '';
          syncSelectionControls();
          return;
        }

        if (action === 'reprocess') {
          const result = await wsCall('studies.reprocess', { studyIds });
          const failureCount = Array.isArray(result.failures) ? result.failures.length : 0;
          const missingCount = Array.isArray(result.missingStudyIds) ? result.missingStudyIds.length : 0;
          alert(
            `Reprocessing requested for ${result.reprocessedStudyCount || 0} study(ies), ` +
            `${result.reprocessedFileCount || 0} file(s). ` +
            `Missing studies: ${missingCount}. Failures: ${failureCount}.`,
          );
          if (bulkAction) bulkAction.value = '';
          syncSelectionControls();
        }
      } catch (error) {
        const label = action === 'reprocess' ? 'Reprocess' : 'Delete';
        alert(`${label} failed: ${formatRequestError(error)}`);
      } finally {
        btn.disabled = false;
      }
    });

    function renderDlp() {
      const tbody = document.getElementById('dlp-body');
      tbody.innerHTML = state.dlq.map((item) => `
        <tr>
          <td><input type="checkbox" class="dlq-check" value="${item.messageId}" /></td>
          <td>${item.messageId || ''}</td>
          <td>${item.publishTime?.value || item.publishTime || ''}</td>
          <td>${item.gcsPath ? `<span class="truncate" title="${escapeHtml(item.gcsPath)}">${escapeHtml(item.gcsPath)}</span>` : '<span class="muted">unparsed</span>'}</td>
          <td>${item.generation || ''}</td>
        </tr>
      `).join('');
    }

    function renderDlpPaging(summary = {}) {
      const { limit, offset, total } = state.dlpPaging;
      const showingStart = total > 0 ? offset + 1 : 0;
      const showingEnd = Math.min(offset + limit, total);
      const pageInfo = document.getElementById('dlp-page-info');
      if (pageInfo) {
        pageInfo.textContent = total > 0 ? `${showingStart}-${showingEnd} of ${total}` : '0 of 0';
      }

      const prevBtn = document.getElementById('dlp-prev');
      const nextBtn = document.getElementById('dlp-next');
      if (prevBtn) prevBtn.disabled = offset <= 0;
      if (nextBtn) nextBtn.disabled = showingEnd >= total;


    }

    async function refreshDlp(options = {}) {
      const { resetOffset = false, overrideOffset = null } = options;
      const limit = state.dlpPaging.limit;
      const offset = overrideOffset !== null
        ? overrideOffset
        : (resetOffset ? 0 : state.dlpPaging.offset || 0);

      const refreshBtn = document.getElementById('dlp-refresh');
      const prevBtn = document.getElementById('dlp-prev');
      const nextBtn = document.getElementById('dlp-next');
      refreshBtn.disabled = true;
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;

      try {
        const [summary, list] = await Promise.all([
          wsCall('dlq.summary', { limit: 500 }),
          wsCall('dlq.items', { limit, offset }),
        ]);

        const total = Number(summary.totalCount || 0);
        const normalizedOffset = Math.max(offset, 0);
        if (normalizedOffset > 0 && total > 0 && normalizedOffset >= total) {
          const lastOffset = Math.floor((total - 1) / limit) * limit;
          await refreshDlp({ resetOffset: false, overrideOffset: lastOffset });
          return;
        }

        state.dlpPaging.offset = normalizedOffset;
        state.dlpPaging.total = total;
        state.dlq = list.items || [];
        renderDlp();
        renderDlpPaging(summary);
      } catch (error) {
        console.error('Error refreshing DLP:', error);
      } finally {
        refreshBtn.disabled = false;
        if (prevBtn) prevBtn.disabled = false;
        if (nextBtn) nextBtn.disabled = false;
      }
    }

    document.getElementById('dlp-refresh').addEventListener('click', () => refreshDlp({ resetOffset: true }));
    document.getElementById('dlp-prev').addEventListener('click', () => {
      const nextOffset = Math.max(state.dlpPaging.offset - state.dlpPaging.limit, 0);
      refreshDlp({ resetOffset: false, overrideOffset: nextOffset });
    });
    document.getElementById('dlp-next').addEventListener('click', () => {
      const nextOffset = state.dlpPaging.offset + state.dlpPaging.limit;
      refreshDlp({ resetOffset: false, overrideOffset: nextOffset });
    });
    document.getElementById('select-all-dlp').addEventListener('change', (evt) => {
      document.querySelectorAll('.dlq-check').forEach((c) => c.checked = evt.target.checked);
    });

    document.getElementById('dlp-requeue').addEventListener('click', async () => {
      const messageIds = [...document.querySelectorAll('.dlq-check:checked')].map((c) => c.value);
      if (!messageIds.length) return;
      const btn = document.getElementById('dlp-requeue');
      btn.disabled = true;
      try {
        const result = await wsCall('dlq.requeue', { messageIds });
        await refreshDlp();
        alert(`Requeued ${result.requeuedCount} file(s), deleted ${result.deletedMessageCount} message(s).`);
      } catch (error) {
        alert(`Requeue failed: ${formatRequestError(error)}`);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('dlp-delete').addEventListener('click', async () => {
      const messageIds = [...document.querySelectorAll('.dlq-check:checked')].map((c) => c.value);
      if (!messageIds.length) return;
      if (!confirm(`Delete ${messageIds.length} queue message(s)?`)) return;
      const btn = document.getElementById('dlp-delete');
      btn.disabled = true;
      try {
        const result = await wsCall('dlq.delete', { messageIds });
        await refreshDlp();
        alert(`Deleted ${result.deletedCount} message(s).`);
      } catch (error) {
        alert(`Delete failed: ${formatRequestError(error)}`);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById('upload-run').addEventListener('click', async () => {
      const fileInput = document.getElementById('upload-file');
      const file = fileInput.files?.[0];
      if (!file) {
        alert('Choose a file first.');
        return;
      }
      const output = document.getElementById('upload-output');
      output.textContent = 'Uploading and processing...';
      const btn = document.getElementById('upload-run');
      btn.disabled = true;

      try {
        const bytes = new Uint8Array(await file.arrayBuffer());

        const progressLines = [];
        const result = await wsCallBinary('process.run', {
          fileName: file.name,
          fileSizeBytes: bytes.length,
          mimeType: file.type || 'application/dicom',
        }, bytes, {
          onProgress: (event) => {
            const detail = event.detail ? ` ${JSON.stringify(event.detail)}` : '';
            progressLines.push(`[${new Date().toISOString()}] ${event.stage}${detail}`);
            output.textContent = `${progressLines.join('\n')}\n\nWaiting for completion...`;
          },
        });

        output.textContent = `${progressLines.join('\n')}\n\n${JSON.stringify(result, null, 2)}`;
      } catch (error) {
        output.textContent = `Failed: ${formatRequestError(error)}`;
      } finally {
        btn.disabled = false;
      }
    });

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function renderCollapsibleJson(data) {
      if (!data || typeof data !== 'object') {
        return `<div class="json-viewer"><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></div>`;
      }

      const viewerId = `json-viewer-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      function hasNestedArrays(obj) {
        if (Array.isArray(obj)) {
          return obj.some(item => {
            if (typeof item === 'object' && item !== null) {
              return Object.values(item).some(v => Array.isArray(v) || (typeof v === 'object' && v !== null)) || hasNestedArrays(item);
            }
            return false;
          });
        } else if (typeof obj === 'object' && obj !== null) {
          return Object.values(obj).some(v => (Array.isArray(v) || (typeof v === 'object' && v !== null && !Array.isArray(v))) && hasNestedArrays(v));
        }
        return false;
      }

      function renderObjectProperties(obj, depth = 0) {
        const keys = Object.keys(obj).filter(k => k !== '__typename');
        let html = '';
        for (const key of keys) {
          const value = obj[key];
          const isArray = Array.isArray(value);
          const valuePreview = isArray
            ? `array[${value.length}]`
            : typeof value === 'object' && value !== null
            ? 'object'
            : typeof value === 'string'
            ? `"${value}"`
            : String(value);

          if (isArray) {
            html += `<div class="json-section"><div class="json-section-toggle" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.querySelector('i').style.transform = this.nextElementSibling.classList.contains('collapsed') ? 'rotate(0deg)' : 'rotate(90deg)';"><i class="fa-solid fa-chevron-right" style="transition: transform 0.2s;"></i><span style="color: var(--json-key);">"${escapeHtml(String(key))}"</span>: ${escapeHtml(valuePreview)}</div>
            <div class="json-section-content collapsed" style="margin: 0 0 0 14px;">`;
            if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
              for (let i = 0; i < value.length; i++) {
                html += `<div style="padding: 0 2px; margin: 0 0 1px 0; background: var(--json-section-bg); border-left: 2px solid var(--json-section-border); border-top-left-radius: 4px; border-bottom-left-radius: 4px;">`;
                html += renderObjectProperties(value[i], depth + 1);
                html += `</div>`;
              }
            } else {
              html += `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
            }
            html += `</div></div>`;
          } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            html += `<div class="json-section"><div class="json-section-toggle" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.querySelector('i').style.transform = this.nextElementSibling.classList.contains('collapsed') ? 'rotate(0deg)' : 'rotate(90deg)';"><i class="fa-solid fa-chevron-right" style="transition: transform 0.2s;"></i><span style="color: var(--json-key);">"${escapeHtml(String(key))}"</span>: ${escapeHtml(valuePreview)}</div>
            <div class="json-section-content collapsed" style="margin: 0 0 0 14px;">`;
            html += renderObjectProperties(value, depth + 1);
            html += `</div></div>`;
          } else {
            html += `<div class="json-section" style="color: var(--text);"><span style="color: var(--json-key);">"${escapeHtml(String(key))}"</span>: ${escapeHtml(valuePreview)}</div>`;
          }
        }
        return html;
      }

      const isArray = Array.isArray(data);
      let html = '';
      
      if (hasNestedArrays(data)) {
        html += `<div style="margin-bottom: 4px;">
        <button class="icon-btn" onclick="document.querySelectorAll('#${viewerId} .json-section .json-section-content').forEach(el => { el.classList.remove('collapsed'); el.previousElementSibling.querySelector('i').style.transform = 'rotate(90deg)'; })" title="Expand all sections" style="font-size: 14px; padding: 4px 8px; margin-right: 4px;"><i class="fa-solid fa-expand" aria-hidden="true"></i></button>
        <button class="icon-btn" onclick="document.querySelectorAll('#${viewerId} .json-section .json-section-content').forEach(el => { el.classList.add('collapsed'); el.previousElementSibling.querySelector('i').style.transform = 'rotate(0deg)'; })" title="Collapse all sections" style="font-size: 14px; padding: 4px 8px;"><i class="fa-solid fa-compress" aria-hidden="true"></i></button>
      </div>`;
      }

      html += `<div id="${viewerId}" class="json-viewer">`;

      if (isArray) {
        if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null) {
          for (let i = 0; i < data.length; i++) {
            html += `<div style="padding: 0 2px; margin: 0 0 1px 0; background: var(--json-section-bg); border-left: 2px solid var(--json-section-border); border-top-left-radius: 4px; border-bottom-left-radius: 4px;">`;
            html += renderObjectProperties(data[i]);
            html += `</div>`;
          }
        } else {
          html += `<div class="json-section" style="margin: 0;">
            <div class="json-section-toggle" onclick="this.nextElementSibling.classList.toggle('collapsed'); this.querySelector('i').style.transform = this.nextElementSibling.classList.contains('collapsed') ? 'rotate(0deg)' : 'rotate(90deg)';"><i class="fa-solid fa-chevron-right" style="transition: transform 0.2s;"></i>array[${data.length}]</div>
            <div class="json-section-content collapsed" style="margin: 0 0 0 14px;"><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></div>
          </div>`;
        }
      } else {
        html += renderObjectProperties(data);
      }

      html += '</div>';
      return html;
    }

    function formatTextContentForDisplay(text, mimeType = 'text/plain') {
      let value = String(text ?? '');
      const mime = String(mimeType || '').toLowerCase();

      const hasLiteralEscapedNewline = value.includes('\\n') || value.includes('\\r\\n');
      const hasRealNewline = value.includes('\n') || value.includes('\r');
      if (hasLiteralEscapedNewline && !hasRealNewline) {
        value = value
          .replace(/\\r\\n/g, '\n')
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t');
      }

      value = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      if (mime.includes('json')) {
        try {
          value = JSON.stringify(JSON.parse(value), null, 2);
        } catch (_) {}
      }

      if (mime.includes('html')) {
        value = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<[^>]+>/g, '');
      }

      return escapeHtml(value);
    }

    loadAuthUser();
    connectWebSocket().catch((error) => {
      setWsStatus('error', formatRequestError(error));
    });
    runSearch();

    // === MONITORING TAB ===
    const monitoringEnabledCheckbox = document.getElementById('monitoring-enabled');
    const monitoringIntervalInput = document.getElementById('monitoring-interval');
    const monitoringRefreshBtn = document.getElementById('monitoring-refresh');
    const monitoringClearBtn = document.getElementById('monitoring-clear');

    function initializeCharts() {
      const styles = getComputedStyle(document.documentElement);
      const chartTextColor = styles.getPropertyValue('--text').trim() || '#d4d4d4';
      const chartGridColor = 'rgba(212, 212, 212, 0.12)';

      const chartConfig = {
        type: 'line',
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              ticks: { color: chartTextColor },
              grid: { color: chartGridColor },
            },
            y: {
              beginAtZero: true,
              ticks: { color: chartTextColor },
              grid: { color: chartGridColor },
            },
          },
          plugins: {
            legend: {
              position: 'top',
              labels: { color: chartTextColor },
            },
          },
        },
      };

      // Studies chart
      const ctxStudies = document.getElementById('chart-studies').getContext('2d');
      state.monitoring.charts.studies = new Chart(ctxStudies, {
        ...chartConfig,
        data: {
          labels: [],
          datasets: [{
            label: 'Total Studies',
            data: [],
            borderColor: '#2563eb',
            backgroundColor: 'rgba(37, 99, 235, 0.1)',
            tension: 0.3,
          }],
        },
      });

      // Instances chart
      const ctxInstances = document.getElementById('chart-instances').getContext('2d');
      state.monitoring.charts.instances = new Chart(ctxInstances, {
        ...chartConfig,
        data: {
          labels: [],
          datasets: [{
            label: 'Total Instances',
            data: [],
            borderColor: '#059669',
            backgroundColor: 'rgba(5, 150, 105, 0.1)',
            tension: 0.3,
          }],
        },
      });

      // DLP chart
      const ctxDlq = document.getElementById('chart-dlq').getContext('2d');
      state.monitoring.charts.dlq = new Chart(ctxDlq, {
        ...chartConfig,
        data: {
          labels: [],
          datasets: [{
            label: 'Failed Queue Messages',
            data: [],
            borderColor: '#dc2626',
            backgroundColor: 'rgba(220, 38, 38, 0.1)',
            tension: 0.3,
          }],
        },
      });
    }

    async function collectMonitoringData() {
      const btn = document.getElementById('monitoring-refresh');
      btn.disabled = true;
      try {
        const [instancesResult, dlqResult] = await Promise.all([
          wsCall('instances.counts', {}),
          wsCall('dlq.summary', {}),
        ]);

        const timestamp = new Date().toLocaleTimeString();
        const dataPoint = {
          timestamp,
          totalStudies: Number(instancesResult.totalStudies || 0),
          totalInstances: Number(instancesResult.totalInstances || 0),
          totalDlq: Number(dlqResult.totalCount || 0),
        };

        state.monitoring.history.push(dataPoint);
        if (state.monitoring.history.length > 50) {
          state.monitoring.history.shift();
        }

        updateMonitoringCharts();
        updateMonitoringStatus();
      } catch (error) {
        console.error('Error collecting monitoring data:', error);
      } finally {
        btn.disabled = false;
      }
    }

    function updateMonitoringCharts() {
      const studies = state.monitoring.charts.studies;
      const instances = state.monitoring.charts.instances;
      const dlq = state.monitoring.charts.dlq;

      studies.data.labels = state.monitoring.history.map((d) => d.timestamp);
      studies.data.datasets[0].data = state.monitoring.history.map((d) => d.totalStudies);
      studies.update();

      instances.data.labels = state.monitoring.history.map((d) => d.timestamp);
      instances.data.datasets[0].data = state.monitoring.history.map((d) => d.totalInstances);
      instances.update();

      dlq.data.labels = state.monitoring.history.map((d) => d.timestamp);
      dlq.data.datasets[0].data = state.monitoring.history.map((d) => d.totalDlq);
      dlq.update();
    }

    function updateMonitoringStatus() {
      const history = state.monitoring.history;
      if (!history.length) return;

      const latest = history[history.length - 1];
      document.getElementById('monitoring-status').textContent = 
        `Last update: ${latest.timestamp} | Studies: ${latest.totalStudies} | Instances: ${latest.totalInstances} | Failed Queue: ${latest.totalDlq} | History: ${history.length} points`;

      const historyHtml = history
        .slice()
        .reverse()
        .slice(0, 10)
        .map((d) => `<div class="muted">${d.timestamp}: Studies=${d.totalStudies}, Instances=${d.totalInstances}, FailedQueue=${d.totalDlq}</div>`)
        .join('');
      document.getElementById('monitoring-history').innerHTML = historyHtml;
    }

    function startMonitoring() {
      if (state.monitoring.intervalId) clearInterval(state.monitoring.intervalId);
      state.monitoring.interval = Math.max(1000, parseInt(monitoringIntervalInput.value || 10000, 10));
      collectMonitoringData();
      state.monitoring.intervalId = setInterval(collectMonitoringData, state.monitoring.interval);
    }

    function stopMonitoring() {
      if (state.monitoring.intervalId) {
        clearInterval(state.monitoring.intervalId);
        state.monitoring.intervalId = null;
      }
    }

    monitoringEnabledCheckbox.addEventListener('change', (evt) => {
      state.monitoring.enabled = evt.target.checked;
      if (state.monitoring.enabled) {
        startMonitoring();
      } else {
        stopMonitoring();
      }
    });

    monitoringRefreshBtn.addEventListener('click', collectMonitoringData);

    monitoringClearBtn.addEventListener('click', () => {
      state.monitoring.history = [];
      updateMonitoringCharts();
      document.getElementById('monitoring-status').textContent = 'History cleared.';
      document.getElementById('monitoring-history').innerHTML = '';
    });

    monitoringIntervalInput.addEventListener('change', () => {
      if (state.monitoring.enabled) {
        stopMonitoring();
        startMonitoring();
      }
    });

    // Initialize charts when page loads
    initializeCharts();
  
