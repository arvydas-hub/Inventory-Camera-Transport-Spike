export const BRIDGE_CHANNEL = 'inventory-camera-bridge';
export const BRIDGE_PROTOCOL_VERSION = 1;

const ALLOWED_FUNCTION = 'bridgePing';
const READY_TYPE = 'bridge-ready';
const REQUEST_TYPE = 'server-request';
const RESPONSE_TYPE = 'server-response';
const ERROR_TYPE = 'server-error';
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GOOGLE_USER_CONTENT_SUFFIX = '.googleusercontent.com';

export class BridgeClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeClientError';
    this.code = code;
    this.details = details;
  }
}

function configuredValue(config, key, fallback) {
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function validateExecEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new BridgeClientError('INVALID_ENDPOINT', 'Enter a valid Apps Script /exec URL.');
  }

  const validPath = /^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(url.pathname);
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'script.google.com'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !validPath
  ) {
    throw new BridgeClientError(
      'INVALID_ENDPOINT',
      'The bridge endpoint must be an HTTPS script.google.com /macros/s/.../exec URL.',
    );
  }

  url.search = '';
  url.hash = '';
  return url;
}

function isPlausibleAppsScriptUserContentOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) return false;

  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (
    url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || url.origin !== value
  ) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'script.googleusercontent.com') return true;
  if (!hostname.endsWith(GOOGLE_USER_CONTENT_SUFFIX)) return false;

  const productLabel = hostname.slice(0, -GOOGLE_USER_CONTENT_SUFFIX.length);
  return productLabel.length <= 63
    && productLabel.endsWith('-script')
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(productLabel);
}

function normalizedServerError(errorValue) {
  if (!isRecord(errorValue)) return null;

  const rawCode = typeof errorValue.code === 'string' ? errorValue.code : '';
  const rawMessage = typeof errorValue.message === 'string' ? errorValue.message : '';
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode) || !rawMessage || rawMessage.length > 512) {
    return null;
  }

  return new BridgeClientError(rawCode, rawMessage);
}

function validPingResult(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 2
    && keys[0] === 'ok'
    && keys[1] === 'receivedAt'
    && value.ok === true
    && typeof value.receivedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.receivedAt);
}

export function createBridgeClient(config = {}) {
  const eventTarget = configuredValue(
    config,
    'eventTarget',
    typeof window === 'undefined' ? null : window,
  );
  const documentObject = configuredValue(
    config,
    'document',
    typeof document === 'undefined' ? null : document,
  );
  const cryptoObject = configuredValue(config, 'crypto', globalThis.crypto);
  const setTimer = configuredValue(config, 'setTimeout', globalThis.setTimeout?.bind(globalThis));
  const clearTimer = configuredValue(config, 'clearTimeout', globalThis.clearTimeout?.bind(globalThis));
  const onDiagnostic = typeof config.onDiagnostic === 'function' ? config.onDiagnostic : null;
  const readyTimeoutMs = positiveTimeout(config.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const callTimeoutMs = positiveTimeout(config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);

  if (
    !cryptoObject
    || (
      typeof cryptoObject.randomUUID !== 'function'
      && typeof cryptoObject.getRandomValues !== 'function'
    )
  ) {
    throw new BridgeClientError(
      'CRYPTO_UNAVAILABLE',
      'The iframe bridge requires a cryptographically secure UUID source.',
    );
  }
  if (
    !eventTarget
    || typeof eventTarget.addEventListener !== 'function'
    || typeof eventTarget.removeEventListener !== 'function'
    || !documentObject
    || typeof documentObject.createElement !== 'function'
    || typeof setTimer !== 'function'
    || typeof clearTimer !== 'function'
  ) {
    throw new BridgeClientError(
      'BRIDGE_ENVIRONMENT_UNAVAILABLE',
      'The iframe bridge requires browser messaging, DOM, and timer APIs.',
    );
  }

  let activeSession = null;
  const issuedIds = new Set();
  let diagnosticCount = 0;

  function createUuid() {
    let value;
    try {
      if (typeof cryptoObject.randomUUID === 'function') {
        value = cryptoObject.randomUUID();
      } else {
        const bytes = new Uint8Array(16);
        cryptoObject.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    } catch {
      throw new BridgeClientError('CRYPTO_FAILURE', 'The secure UUID source failed.');
    }
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
      throw new BridgeClientError(
        'INVALID_RANDOM_UUID',
        'crypto.randomUUID() did not return a UUID v4 value.',
      );
    }
    return value;
  }

  function noteDiagnostic(reason, event) {
    if (!onDiagnostic || diagnosticCount >= 8) return;
    diagnosticCount += 1;
    const candidateOrigin = typeof event?.origin === 'string' && event.origin.length <= 512
      ? event.origin
      : 'unavailable';
    try {
      onDiagnostic({ reason, candidateOrigin });
    } catch {
      // Diagnostics must never interfere with the fail-closed handshake.
    }
  }

  function createUniqueUuid(duplicateCode, duplicateMessage) {
    const value = createUuid();
    if (issuedIds.has(value)) {
      throw new BridgeClientError(duplicateCode, duplicateMessage);
    }
    issuedIds.add(value);
    return value;
  }

  function removeFrame(frame) {
    try {
      if (typeof frame?.remove === 'function') frame.remove();
      else if (frame?.parentNode && typeof frame.parentNode.removeChild === 'function') {
        frame.parentNode.removeChild(frame);
      }
    } catch {
      // Best-effort cleanup; the session is already invalidated.
    }
  }

  function closeSession(session, error) {
    if (!session || session.closed) return;
    session.closed = true;
    session.state = 'closed';
    if (activeSession === session) activeSession = null;

    if (session.listenerAttached) {
      try {
        eventTarget.removeEventListener('message', session.onMessage);
      } catch {
        // Best-effort cleanup; source/origin/nonce checks still invalidate the session.
      }
      session.listenerAttached = false;
    }
    if (session.readyTimer !== null) clearTimer(session.readyTimer);
    session.readyTimer = null;

    if (session.rejectReady) {
      const rejectReady = session.rejectReady;
      session.resolveReady = null;
      session.rejectReady = null;
      rejectReady(error);
    }

    for (const pending of session.pendingCalls.values()) {
      clearTimer(pending.timer);
      pending.reject(error);
    }
    session.pendingCalls.clear();
    removeFrame(session.frame);
  }

  function settleCall(session, callId, settle) {
    const pending = session.pendingCalls.get(callId);
    if (!pending) return false;

    session.pendingCalls.delete(callId);
    clearTimer(pending.timer);
    settle(pending);
    return true;
  }

  function handleMessage(session, event) {
    if (activeSession !== session || session.closed || !event) return;

    const data = event.data;
    if (session.state === 'connecting') {
      if (!isRecord(data) || data.type !== READY_TYPE) return;
      if (data.channel !== BRIDGE_CHANNEL) {
        noteDiagnostic('READY_CHANNEL_REJECTED', event);
        return;
      }
      if (data.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
        noteDiagnostic('READY_VERSION_REJECTED', event);
        return;
      }
      if (data.nonce !== session.nonce) {
        noteDiagnostic('READY_NONCE_REJECTED', event);
        return;
      }
      if (!event.source || typeof event.source.postMessage !== 'function') {
        noteDiagnostic('READY_SOURCE_REJECTED', event);
        return;
      }
      if (!isPlausibleAppsScriptUserContentOrigin(event.origin)) {
        noteDiagnostic('READY_ORIGIN_REJECTED', event);
        return;
      }

      session.state = 'ready';
      session.pinnedSource = event.source;
      session.pinnedOrigin = event.origin;
      clearTimer(session.readyTimer);
      session.readyTimer = null;

      const resolveReady = session.resolveReady;
      session.resolveReady = null;
      session.rejectReady = null;
      resolveReady({
        channel: BRIDGE_CHANNEL,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        origin: session.pinnedOrigin,
      });
      return;
    }

    if (
      !isRecord(data)
      || data.channel !== BRIDGE_CHANNEL
      || data.protocolVersion !== BRIDGE_PROTOCOL_VERSION
      || data.nonce !== session.nonce
    ) {
      return;
    }

    if (
      session.state !== 'ready'
      || event.source !== session.pinnedSource
      || event.origin !== session.pinnedOrigin
      || (data.type !== RESPONSE_TYPE && data.type !== ERROR_TYPE)
      || typeof data.callId !== 'string'
      || !UUID_V4_PATTERN.test(data.callId)
    ) {
      return;
    }

    if (data.type === RESPONSE_TYPE) {
      settleCall(session, data.callId, (pending) => {
        if (!validPingResult(data.result)) {
          pending.reject(new BridgeClientError(
            'INVALID_BRIDGE_RESPONSE',
            'The bridge returned an invalid success response.',
          ));
          return;
        }
        pending.resolve(data.result);
      });
      return;
    }

    settleCall(session, data.callId, (pending) => {
      const serverError = normalizedServerError(data.error);
      pending.reject(serverError || new BridgeClientError(
        'INVALID_BRIDGE_RESPONSE',
        'The bridge returned an invalid error response.',
      ));
    });
  }

  function embed(endpoint, container) {
    const url = validateExecEndpoint(endpoint);
    if (!container || typeof container.appendChild !== 'function') {
      throw new BridgeClientError('INVALID_CONTAINER', 'A bridge iframe container is required.');
    }

    const nonce = createUniqueUuid(
      'DUPLICATE_NONCE',
      'crypto.randomUUID() repeated a bridge session nonce.',
    );
    const frame = documentObject.createElement('iframe');
    if (!frame || typeof frame !== 'object') {
      throw new BridgeClientError('FRAME_CREATION_FAILED', 'The bridge iframe could not be created.');
    }

    url.searchParams.set('view', 'bridge-probe');
    url.searchParams.set('nonce', nonce);
    frame.title = 'Apps Script bridge probe';
    frame.referrerPolicy = 'no-referrer';
    frame.src = url.href;

    if (activeSession) {
      closeSession(activeSession, new BridgeClientError(
        'BRIDGE_REPLACED',
        'The iframe bridge was replaced by a new session.',
      ));
    }

    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session = {
      closed: false,
      state: 'connecting',
      nonce,
      frame,
      pinnedSource: null,
      pinnedOrigin: '',
      pendingCalls: new Map(),
      readyTimer: null,
      resolveReady,
      rejectReady,
      onMessage: null,
      listenerAttached: false,
    };
    session.onMessage = (event) => handleMessage(session, event);
    activeSession = session;

    try {
      eventTarget.addEventListener('message', session.onMessage);
      session.listenerAttached = true;
      session.readyTimer = setTimer(() => {
        if (activeSession !== session || session.state !== 'connecting') return;
        closeSession(session, new BridgeClientError(
          'BRIDGE_READY_TIMEOUT',
          `The iframe bridge did not become ready within ${readyTimeoutMs} ms.`,
        ));
      }, readyTimeoutMs);
      container.appendChild(frame);
      if (!frame.contentWindow || typeof frame.contentWindow.postMessage !== 'function') {
        throw new BridgeClientError(
          'FRAME_WINDOW_UNAVAILABLE',
          'The bridge iframe window is unavailable.',
        );
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeClientError
        ? error
        : new BridgeClientError('FRAME_CREATION_FAILED', 'The bridge iframe could not be attached.');
      closeSession(session, bridgeError);
    }

    return readyPromise;
  }

  async function call(functionName, args = []) {
    if (functionName !== ALLOWED_FUNCTION) {
      throw new BridgeClientError(
        'FUNCTION_NOT_ALLOWED',
        `The iframe bridge does not allow function: ${String(functionName || '')}`,
      );
    }
    if (!Array.isArray(args) || args.length !== 0) {
      throw new BridgeClientError(
        'ARGS_NOT_ALLOWED',
        'The read-only bridgePing call does not accept arguments.',
      );
    }

    const session = activeSession;
    if (!session || session.state !== 'ready' || !session.pinnedSource || !session.pinnedOrigin) {
      throw new BridgeClientError('BRIDGE_NOT_READY', 'The iframe bridge is not ready.');
    }

    const callId = createUniqueUuid(
      'DUPLICATE_CALL_ID',
      'crypto.randomUUID() repeated a bridge call ID.',
    );

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      session.pendingCalls.set(callId, pending);
      pending.timer = setTimer(() => {
        if (activeSession !== session) return;
        settleCall(session, callId, (current) => {
          current.reject(new BridgeClientError(
            'BRIDGE_CALL_TIMEOUT',
            `The iframe bridge call exceeded ${callTimeoutMs} ms.`,
            { callId },
          ));
        });
      }, callTimeoutMs);

      try {
        session.pinnedSource.postMessage({
          channel: BRIDGE_CHANNEL,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          type: REQUEST_TYPE,
          nonce: session.nonce,
          callId,
          functionName: ALLOWED_FUNCTION,
          args: [],
        }, session.pinnedOrigin);
      } catch {
        settleCall(session, callId, (current) => {
          current.reject(new BridgeClientError(
            'POST_MESSAGE_FAILED',
            'The iframe bridge request could not be sent.',
          ));
        });
      }
    });
  }

  function teardown() {
    if (!activeSession) return false;
    closeSession(activeSession, new BridgeClientError(
      'BRIDGE_TORN_DOWN',
      'The iframe bridge was torn down.',
    ));
    return true;
  }

  return {
    embed,
    call,
    teardown,
    getState() {
      return activeSession ? activeSession.state : 'idle';
    },
    isReady() {
      return activeSession?.state === 'ready';
    },
  };
}

export const bridgeClientInternals = {
  isPlausibleAppsScriptUserContentOrigin,
  validateExecEndpoint,
  validPingResult,
};
