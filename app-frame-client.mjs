export const APP_FRAME_CHANNEL = 'inventory-camera-app-shell';
export const APP_FRAME_PROTOCOL_VERSION = 1;

const EMBEDDED_APP_VIEW = 'embedded-app';
const READY_TYPE = 'app-ready';
const CONNECT_TYPE = 'shell-connect';
const STATE_TYPE = 'app-state';
const SCAN_REQUEST_TYPE = 'scan-code';
const SCAN_RESULT_TYPE = 'scan-result';
const SCAN_ERROR_TYPE = 'scan-error';
const OPERATION_STATUS_TYPE = 'operation-status';
const DEFAULT_READY_TIMEOUT_MS = 15000;
const DEFAULT_CALL_TIMEOUT_MS = 15000;
const MAX_SESSION_CALLS = 512;
const MAX_SCAN_CODE_LENGTH = 512;
const MAX_DIAGNOSTICS = 8;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const GOOGLE_USER_CONTENT_SUFFIX = '.googleusercontent.com';
const APP_STATES = new Set(['initializing', 'registration-required', 'ready', 'init-error']);
const SCAN_OUTCOMES = new Set(['found', 'not-found']);
const OPERATION_OUTCOMES = new Set(['success', 'rejected', 'runner-failure']);

export class AppFrameClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppFrameClientError';
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

function hasExactKeys(value, expectedKeys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  return actualKeys.length === sortedExpected.length
    && actualKeys.every((key, index) => key === sortedExpected[index]);
}

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedCallLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return MAX_SESSION_CALLS;
  return Math.min(parsed, MAX_SESSION_CALLS);
}

function validateExecEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new AppFrameClientError('INVALID_ENDPOINT', 'Enter a valid Apps Script /exec URL.');
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
    throw new AppFrameClientError(
      'INVALID_ENDPOINT',
      'The app frame endpoint must be an HTTPS script.google.com /macros/s/.../exec URL.',
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

function normalizeScanCode(value) {
  if (typeof value !== 'string') {
    throw new AppFrameClientError('INVALID_SCAN_CODE', 'A decoded text value is required.');
  }
  const code = value.trim();
  if (
    code.length < 1
    || code.length > MAX_SCAN_CODE_LENGTH
    || CONTROL_CHARACTER_PATTERN.test(code)
  ) {
    throw new AppFrameClientError(
      'INVALID_SCAN_CODE',
      'Decoded text must contain 1 to 512 characters without control characters.',
    );
  }
  return code;
}

function validBaseMessage(value, session) {
  return isRecord(value)
    && value.channel === APP_FRAME_CHANNEL
    && value.protocolVersion === APP_FRAME_PROTOCOL_VERSION
    && value.nonce === session.nonce;
}

function validScanResult(value) {
  return hasExactKeys(value, ['ok', 'outcome'])
    && value.ok === true
    && SCAN_OUTCOMES.has(value.outcome);
}

function normalizedScanError(value) {
  if (!hasExactKeys(value, ['code', 'message'])) return null;
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code) || !message || message.length > 512) {
    return null;
  }
  return new AppFrameClientError(code, message);
}

function createBaseMessage(type, nonce) {
  return {
    channel: APP_FRAME_CHANNEL,
    protocolVersion: APP_FRAME_PROTOCOL_VERSION,
    type,
    nonce,
  };
}

export function createAppFrameClient(config = {}) {
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
  const onAppState = typeof config.onAppState === 'function' ? config.onAppState : null;
  const onOperationStatus = typeof config.onOperationStatus === 'function'
    ? config.onOperationStatus
    : null;
  const readyTimeoutMs = positiveTimeout(config.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const callTimeoutMs = positiveTimeout(config.callTimeoutMs, DEFAULT_CALL_TIMEOUT_MS);
  const maxCalls = boundedCallLimit(config.maxCalls);

  if (
    !cryptoObject
    || (
      typeof cryptoObject.randomUUID !== 'function'
      && typeof cryptoObject.getRandomValues !== 'function'
    )
  ) {
    throw new AppFrameClientError(
      'CRYPTO_UNAVAILABLE',
      'The embedded app frame requires a cryptographically secure UUID source.',
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
    throw new AppFrameClientError(
      'APP_FRAME_ENVIRONMENT_UNAVAILABLE',
      'The embedded app frame requires browser messaging, DOM, and timer APIs.',
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
      throw new AppFrameClientError('CRYPTO_FAILURE', 'The secure UUID source failed.');
    }
    if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
      throw new AppFrameClientError(
        'INVALID_RANDOM_UUID',
        'The secure UUID source did not return a UUID v4 value.',
      );
    }
    return value;
  }

  function createUniqueUuid(duplicateCode, duplicateMessage) {
    const value = createUuid();
    if (issuedIds.has(value)) {
      throw new AppFrameClientError(duplicateCode, duplicateMessage);
    }
    issuedIds.add(value);
    return value;
  }

  function noteDiagnostic(reason, event) {
    if (!onDiagnostic || diagnosticCount >= MAX_DIAGNOSTICS) return;
    diagnosticCount += 1;
    const candidateOrigin = typeof event?.origin === 'string' && event.origin.length <= 512
      ? event.origin
      : 'unavailable';
    try {
      onDiagnostic({ reason, candidateOrigin });
    } catch {
      // Diagnostic callbacks must never interfere with the fail-closed handshake.
    }
  }

  function notifyAppState(state) {
    if (!onAppState) return;
    try {
      onAppState(state);
    } catch {
      // Application-state rendering must not affect message validation.
    }
  }

  function notifyOperationStatus(operation, outcome) {
    if (!onOperationStatus) return;
    try {
      onOperationStatus({ operation, outcome });
    } catch {
      // Operation-status rendering must not affect message validation.
    }
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
    session.appState = 'unknown';
    if (activeSession === session) activeSession = null;

    if (session.listenerAttached) {
      try {
        eventTarget.removeEventListener('message', session.onMessage);
      } catch {
        // Best-effort cleanup; the closed session also rejects every late message.
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

  function acceptReady(session, event, data) {
    if (!hasExactKeys(data, ['channel', 'protocolVersion', 'type', 'nonce'])) {
      noteDiagnostic('READY_SHAPE_REJECTED', event);
      return;
    }
    if (data.channel !== APP_FRAME_CHANNEL) {
      noteDiagnostic('READY_CHANNEL_REJECTED', event);
      return;
    }
    if (data.protocolVersion !== APP_FRAME_PROTOCOL_VERSION) {
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

    try {
      session.pinnedSource.postMessage(
        createBaseMessage(CONNECT_TYPE, session.nonce),
        session.pinnedOrigin,
      );
    } catch {
      closeSession(session, new AppFrameClientError(
        'POST_MESSAGE_FAILED',
        'The app frame connection could not be sent.',
      ));
      return;
    }

    const resolveReady = session.resolveReady;
    session.resolveReady = null;
    session.rejectReady = null;
    resolveReady({
      channel: APP_FRAME_CHANNEL,
      protocolVersion: APP_FRAME_PROTOCOL_VERSION,
      origin: session.pinnedOrigin,
    });
  }

  function handlePinnedMessage(session, data) {
    if (!validBaseMessage(data, session)) return;

    if (data.type === STATE_TYPE) {
      if (!hasExactKeys(data, ['channel', 'protocolVersion', 'type', 'nonce', 'state'])) return;
      if (!APP_STATES.has(data.state)) return;
      session.appState = data.state;
      notifyAppState(data.state);
      return;
    }

    if (data.type === OPERATION_STATUS_TYPE) {
      if (!hasExactKeys(
        data,
        ['channel', 'protocolVersion', 'type', 'nonce', 'operation', 'outcome'],
      )) return;
      if (data.operation !== 'update-quantity' || !OPERATION_OUTCOMES.has(data.outcome)) return;
      notifyOperationStatus(data.operation, data.outcome);
      return;
    }

    if (data.type !== SCAN_RESULT_TYPE && data.type !== SCAN_ERROR_TYPE) return;
    if (typeof data.callId !== 'string' || !UUID_V4_PATTERN.test(data.callId)) return;

    if (data.type === SCAN_RESULT_TYPE) {
      if (!hasExactKeys(
        data,
        ['channel', 'protocolVersion', 'type', 'nonce', 'callId', 'result'],
      )) return;
      settleCall(session, data.callId, (pending) => {
        if (!validScanResult(data.result)) {
          pending.reject(new AppFrameClientError(
            'INVALID_APP_FRAME_RESPONSE',
            'The app frame returned an invalid scan result.',
          ));
          return;
        }
        pending.resolve({ ok: true, outcome: data.result.outcome });
      });
      return;
    }

    if (!hasExactKeys(
      data,
      ['channel', 'protocolVersion', 'type', 'nonce', 'callId', 'error'],
    )) return;
    settleCall(session, data.callId, (pending) => {
      const error = normalizedScanError(data.error);
      pending.reject(error || new AppFrameClientError(
        'INVALID_APP_FRAME_RESPONSE',
        'The app frame returned an invalid scan error.',
      ));
    });
  }

  function handleMessage(session, event) {
    if (activeSession !== session || session.closed || !event) return;
    const data = event.data;

    if (session.state === 'connecting') {
      if (!isRecord(data) || data.type !== READY_TYPE) return;
      acceptReady(session, event, data);
      return;
    }

    if (
      session.state !== 'ready'
      || event.source !== session.pinnedSource
      || event.origin !== session.pinnedOrigin
    ) {
      return;
    }
    handlePinnedMessage(session, data);
  }

  function embed(endpoint, container) {
    const url = validateExecEndpoint(endpoint);
    if (!container || typeof container.appendChild !== 'function') {
      throw new AppFrameClientError('INVALID_CONTAINER', 'An embedded app container is required.');
    }

    const nonce = createUniqueUuid(
      'DUPLICATE_NONCE',
      'The secure UUID source repeated an app-frame session nonce.',
    );
    const frame = documentObject.createElement('iframe');
    if (!frame || typeof frame !== 'object') {
      throw new AppFrameClientError('FRAME_CREATION_FAILED', 'The app iframe could not be created.');
    }

    url.searchParams.set('view', EMBEDDED_APP_VIEW);
    url.searchParams.set('nonce', nonce);
    frame.title = 'Inventory application';
    frame.referrerPolicy = 'no-referrer';
    frame.src = url.href;

    if (activeSession) {
      closeSession(activeSession, new AppFrameClientError(
        'APP_FRAME_REPLACED',
        'The embedded app frame was replaced by a new session.',
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
      appState: 'unknown',
      nonce,
      frame,
      pinnedSource: null,
      pinnedOrigin: '',
      callCount: 0,
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
        closeSession(session, new AppFrameClientError(
          'APP_FRAME_READY_TIMEOUT',
          `The embedded app did not become ready within ${readyTimeoutMs} ms.`,
        ));
      }, readyTimeoutMs);
      container.appendChild(frame);
      if (!frame.contentWindow || typeof frame.contentWindow.postMessage !== 'function') {
        throw new AppFrameClientError(
          'FRAME_WINDOW_UNAVAILABLE',
          'The embedded app iframe window is unavailable.',
        );
      }
    } catch (error) {
      const frameError = error instanceof AppFrameClientError
        ? error
        : new AppFrameClientError('FRAME_CREATION_FAILED', 'The app iframe could not be attached.');
      closeSession(session, frameError);
    }

    return readyPromise;
  }

  async function submitScan(value) {
    const code = normalizeScanCode(value);
    const session = activeSession;
    if (
      !session
      || session.state !== 'ready'
      || session.appState !== 'ready'
      || !session.pinnedSource
      || !session.pinnedOrigin
    ) {
      throw new AppFrameClientError('APP_NOT_READY', 'The embedded inventory app is not ready.');
    }
    if (session.pendingCalls.size > 0) {
      throw new AppFrameClientError('SCAN_BUSY', 'Wait for the current inventory lookup to finish.');
    }
    if (session.callCount >= maxCalls) {
      throw new AppFrameClientError(
        'APP_FRAME_CALL_LIMIT_REACHED',
        'This embedded app session reached its bounded scan-call limit.',
      );
    }

    const callId = createUniqueUuid(
      'DUPLICATE_CALL_ID',
      'The secure UUID source repeated an app-frame call ID.',
    );
    session.callCount += 1;

    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      session.pendingCalls.set(callId, pending);
      pending.timer = setTimer(() => {
        if (activeSession !== session) return;
        settleCall(session, callId, (current) => {
          current.reject(new AppFrameClientError(
            'APP_FRAME_CALL_TIMEOUT',
            `The inventory lookup exceeded ${callTimeoutMs} ms.`,
            { callId },
          ));
        });
      }, callTimeoutMs);

      try {
        session.pinnedSource.postMessage({
          ...createBaseMessage(SCAN_REQUEST_TYPE, session.nonce),
          callId,
          code,
        }, session.pinnedOrigin);
      } catch {
        settleCall(session, callId, (current) => {
          current.reject(new AppFrameClientError(
            'POST_MESSAGE_FAILED',
            'The decoded value could not be sent to the embedded app.',
          ));
        });
      }
    });
  }

  function teardown() {
    if (!activeSession) return false;
    closeSession(activeSession, new AppFrameClientError(
      'APP_FRAME_TORN_DOWN',
      'The embedded app frame was torn down.',
    ));
    return true;
  }

  return {
    embed,
    submitScan,
    teardown,
    getState() {
      return activeSession ? activeSession.state : 'idle';
    },
    getAppState() {
      return activeSession ? activeSession.appState : 'unknown';
    },
    isReady() {
      return activeSession?.state === 'ready' && activeSession.appState === 'ready';
    },
  };
}

export const appFrameClientInternals = {
  hasExactKeys,
  isPlausibleAppsScriptUserContentOrigin,
  normalizeScanCode,
  validScanResult,
  validateExecEndpoint,
};
