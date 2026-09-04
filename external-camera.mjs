import { createCameraLifecycle } from './camera-lifecycle.mjs?v=0.3.18-camera-cleanup-2';
import {
  cameraErrorText,
  isCameraPermissionError,
  startCameraWithCompatibility,
} from './camera-compat.mjs?v=0.3.21-compat-1';
import { createScanGate } from './scan-gate.mjs?v=0.3.21-scan-gate-1';

export const EXTERNAL_CAMERA_CHANNEL = 'inventory-external-camera-window';
export const EXTERNAL_CAMERA_PROTOCOL_VERSION = 1;
export const EXTERNAL_CAMERA_MAX_CALLS = 512;
export const EXTERNAL_SCANNER_LIBRARY_URL = './vendor/html5-qrcode.min.js?v=2.3.8-660b1243';
export const EXTERNAL_SCANNER_LIBRARY_INTEGRITY = 'sha256-ZgsSQ3sddH4+aLi+BoXAjLcoFAEQrSE/FnsUtm+LHY4=';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SCAN_CHARS = 512;
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_READY_RETRY_MS = 400;
const DEFAULT_RECEIPT_TIMEOUT_MS = 8_000;
const DEFAULT_RESULT_TIMEOUT_MS = 70_000;
const ALLOWED_OUTCOMES = new Set(['found', 'not-found']);
const ALLOWED_ERROR_CODES = new Set([
  'APP_BUSY',
  'APP_LIMIT_REACHED',
  'APP_NOT_READY',
  'INVALID_SCAN',
  'LOOKUP_FAILURE',
  'LOOKUP_REJECTED',
]);

export class ExternalCameraWindowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExternalCameraWindowError';
    this.code = code;
  }
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum
    ? number
    : fallback;
}

function isAppsScriptUserContentOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 512) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    let expectedHost = hostname === 'script.googleusercontent.com';
    if (!expectedHost && hostname.endsWith('.googleusercontent.com')) {
      const label = hostname.slice(0, -'.googleusercontent.com'.length);
      expectedHost = label.length <= 63
        && label.endsWith('-script')
        && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(label);
    }
    return value === url.origin
      && url.protocol === 'https:'
      && !url.port
      && expectedHost;
  } catch {
    return false;
  }
}

export function parseExternalCameraLaunch(hashValue) {
  const raw = String(hashValue || '').replace(/^#/, '');
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()].sort();
  if (
    keys.length !== 4
    || keys[0] !== 'channel'
    || keys[1] !== 'nonce'
    || keys[2] !== 'parentOrigin'
    || keys[3] !== 'protocolVersion'
    || params.getAll('channel').length !== 1
    || params.getAll('nonce').length !== 1
    || params.getAll('parentOrigin').length !== 1
    || params.getAll('protocolVersion').length !== 1
  ) {
    throw new ExternalCameraWindowError(
      'INVALID_LAUNCH',
      'Open this camera from the staging inventory app.',
    );
  }

  const nonce = String(params.get('nonce') || '');
  const parentOrigin = String(params.get('parentOrigin') || '');
  const channel = String(params.get('channel') || '');
  const protocolVersion = Number(params.get('protocolVersion'));
  if (
    !UUID_V4_PATTERN.test(nonce)
    || !isAppsScriptUserContentOrigin(parentOrigin)
    || channel !== EXTERNAL_CAMERA_CHANNEL
    || protocolVersion !== EXTERNAL_CAMERA_PROTOCOL_VERSION
  ) {
    throw new ExternalCameraWindowError(
      'INVALID_LAUNCH',
      'Open this camera from the staging inventory app.',
    );
  }

  return Object.freeze({ nonce, parentOrigin, channel, protocolVersion });
}

export function clearExternalCameraLaunchFragment(locationObject, historyObject) {
  if (!locationObject || !historyObject || typeof historyObject.replaceState !== 'function') return;
  const pathname = String(locationObject.pathname || '/');
  const search = String(locationObject.search || '');
  historyObject.replaceState(null, '', `${pathname}${search}`);
}

function createSecureUuid(cryptoObject, issuedIds) {
  let value;
  try {
    if (typeof cryptoObject?.randomUUID === 'function') {
      value = cryptoObject.randomUUID();
    } else if (typeof cryptoObject?.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      cryptoObject.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  } catch {
    throw new ExternalCameraWindowError('CRYPTO_FAILURE', 'The secure ID source failed.');
  }
  if (!UUID_V4_PATTERN.test(String(value || '')) || issuedIds.has(value)) {
    throw new ExternalCameraWindowError('CRYPTO_FAILURE', 'The secure ID source returned an invalid value.');
  }
  issuedIds.add(value);
  return value;
}

function normalizeScanValue(value) {
  if (typeof value !== 'string') {
    throw new ExternalCameraWindowError('INVALID_SCAN', 'The decoded value is invalid.');
  }
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_SCAN_CHARS
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new ExternalCameraWindowError('INVALID_SCAN', 'The decoded value is invalid.');
  }
  return normalized;
}

export function createExternalCameraWindowClient(config = {}) {
  const openerWindow = config.openerWindow;
  const eventTarget = config.eventTarget;
  const targetOrigin = config.parentOrigin;
  const nonce = config.nonce;
  const cryptoObject = config.cryptoObject || globalThis.crypto;
  const setTimer = config.setTimeout || globalThis.setTimeout?.bind(globalThis);
  const clearTimer = config.clearTimeout || globalThis.clearTimeout?.bind(globalThis);
  const now = config.now || Date.now;
  const onConnected = typeof config.onConnected === 'function' ? config.onConnected : () => {};
  const onReceipt = typeof config.onReceipt === 'function' ? config.onReceipt : () => {};
  const onStop = typeof config.onStop === 'function' ? config.onStop : () => {};
  const onDiagnostic = typeof config.onDiagnostic === 'function' ? config.onDiagnostic : () => {};
  const readyTimeoutMs = positiveInteger(config.readyTimeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const readyRetryMs = positiveInteger(config.readyRetryMs, DEFAULT_READY_RETRY_MS);
  const receiptTimeoutMs = positiveInteger(
    config.receiptTimeoutMs,
    DEFAULT_RECEIPT_TIMEOUT_MS,
    60_000,
  );
  const resultTimeoutMs = positiveInteger(
    config.resultTimeoutMs ?? config.callTimeoutMs,
    DEFAULT_RESULT_TIMEOUT_MS,
    300_000,
  );
  const maxCalls = positiveInteger(config.maxCalls, EXTERNAL_CAMERA_MAX_CALLS, EXTERNAL_CAMERA_MAX_CALLS);

  if (!openerWindow || typeof openerWindow.postMessage !== 'function') {
    throw new ExternalCameraWindowError('OPENER_UNAVAILABLE', 'Open this camera from the staging inventory app.');
  }
  if (!eventTarget
      || typeof eventTarget.addEventListener !== 'function'
      || typeof eventTarget.removeEventListener !== 'function') {
    throw new ExternalCameraWindowError('EVENT_TARGET_UNAVAILABLE', 'The message channel is unavailable.');
  }
  if (!isAppsScriptUserContentOrigin(targetOrigin) || !UUID_V4_PATTERN.test(String(nonce || ''))) {
    throw new ExternalCameraWindowError('INVALID_LAUNCH', 'Open this camera from the staging inventory app.');
  }
  if (!cryptoObject
      || (typeof cryptoObject.randomUUID !== 'function'
        && typeof cryptoObject.getRandomValues !== 'function')) {
    throw new ExternalCameraWindowError('CRYPTO_UNAVAILABLE', 'Secure browser IDs are unavailable.');
  }
  if (typeof setTimer !== 'function' || typeof clearTimer !== 'function' || typeof now !== 'function') {
    throw new ExternalCameraWindowError('TIMER_UNAVAILABLE', 'The message timer is unavailable.');
  }

  const issuedIds = new Set([nonce]);
  const cameraNonce = createSecureUuid(cryptoObject, issuedIds);
  let started = false;
  let destroyed = false;
  let connected = false;
  let readyStartedAt = 0;
  let readyTimer = null;
  let pendingCall = null;
  let callCount = 0;

  function baseMessage(type) {
    return {
      channel: EXTERNAL_CAMERA_CHANNEL,
      protocolVersion: EXTERNAL_CAMERA_PROTOCOL_VERSION,
      type,
      nonce,
      cameraNonce,
    };
  }

  function openerIsClosed() {
    return externalCameraOpenerIsClosed(openerWindow);
  }

  function post(message) {
    if (destroyed || openerIsClosed()) {
      throw new ExternalCameraWindowError('OPENER_UNAVAILABLE', 'The inventory window is no longer available.');
    }
    openerWindow.postMessage(message, targetOrigin);
  }

  function clearReadyTimer() {
    if (readyTimer !== null) {
      clearTimer(readyTimer);
      readyTimer = null;
    }
  }

  function announceReady() {
    if (destroyed || connected) return;
    if (now() - readyStartedAt >= readyTimeoutMs) {
      clearReadyTimer();
      onDiagnostic({ code: 'HANDSHAKE_TIMEOUT' });
      return;
    }
    try {
      post(baseMessage('camera-ready'));
    } catch (error) {
      onDiagnostic({ code: error.code || 'OPENER_UNAVAILABLE' });
      return;
    }
    readyTimer = setTimer(announceReady, readyRetryMs);
  }

  function validBase(data) {
    return data.channel === EXTERNAL_CAMERA_CHANNEL
      && data.protocolVersion === EXTERNAL_CAMERA_PROTOCOL_VERSION
      && data.nonce === nonce
      && data.cameraNonce === cameraNonce;
  }

  function settlePending(action) {
    const pending = pendingCall;
    if (!pending) return;
    pendingCall = null;
    clearTimer(pending.timer);
    action(pending);
  }

  function armPendingTimeout(callId, timeoutMs, code, message) {
    return setTimer(() => {
      if (!pendingCall || pendingCall.callId !== callId) return;
      settlePending((pending) => pending.reject(new ExternalCameraWindowError(code, message)));
    }, timeoutMs);
  }

  function invalidCorrelatedResponse(data) {
    return pendingCall
      && typeof data?.callId === 'string'
      && data.callId === pendingCall.callId;
  }

  function handleResult(data) {
    if (!hasExactKeys(data, [
      'callId',
      'cameraNonce',
      'channel',
      'nonce',
      'protocolVersion',
      'result',
      'type',
    ])
        || !pendingCall
        || data.callId !== pendingCall.callId
        || pendingCall.received !== true
        || !hasExactKeys(data.result, ['ok', 'outcome'])
        || data.result.ok !== true
        || !ALLOWED_OUTCOMES.has(data.result.outcome)) {
      if (invalidCorrelatedResponse(data)) {
        settlePending((pending) => pending.reject(new ExternalCameraWindowError(
          'INVALID_RESPONSE',
          'The inventory window returned an invalid response.',
        )));
      }
      return;
    }
    settlePending((pending) => pending.resolve(Object.freeze({
      ok: true,
      outcome: data.result.outcome,
    })));
  }

  function handleError(data) {
    const validError = hasExactKeys(data, [
      'callId',
      'cameraNonce',
      'channel',
      'error',
      'nonce',
      'protocolVersion',
      'type',
      ])
      && pendingCall
      && data.callId === pendingCall.callId
      && hasExactKeys(data.error, ['code', 'message'])
      && ALLOWED_ERROR_CODES.has(data.error.code)
      && typeof data.error.message === 'string'
      && data.error.message.length > 0
      && data.error.message.length <= 160;
    if (!validError) {
      if (invalidCorrelatedResponse(data)) {
        settlePending((pending) => pending.reject(new ExternalCameraWindowError(
          'INVALID_RESPONSE',
          'The inventory window returned an invalid response.',
        )));
      }
      return;
    }
    settlePending((pending) => pending.reject(new ExternalCameraWindowError(
      data.error.code,
      data.error.message,
    )));
  }

  function onMessage(event) {
    if (destroyed || event.source !== openerWindow || event.origin !== targetOrigin) return;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data) || !validBase(data)) return;

    if (data.type === 'camera-stop') {
      if (!hasExactKeys(data, [
        'cameraNonce',
        'channel',
        'nonce',
        'protocolVersion',
        'type',
      ])) return;
      connected = false;
      try {
        onStop();
      } finally {
        teardown();
      }
      return;
    }

    if (data.type === 'camera-connect') {
      if (!hasExactKeys(data, [
        'cameraNonce',
        'channel',
        'nonce',
        'protocolVersion',
        'type',
      ])) return;
      const wasConnected = connected;
      connected = true;
      clearReadyTimer();
      try {
        post(baseMessage('camera-connected'));
      } catch (error) {
        connected = false;
        onDiagnostic({ code: error.code || 'OPENER_UNAVAILABLE' });
        return;
      }
      if (!wasConnected) onConnected();
      return;
    }
    if (!connected) return;
    if (data.type === 'scan-received') {
      if (!hasExactKeys(data, [
        'callId',
        'cameraNonce',
        'channel',
        'nonce',
        'protocolVersion',
        'type',
      ]) || !pendingCall || data.callId !== pendingCall.callId) {
        if (invalidCorrelatedResponse(data)) {
          settlePending((pending) => pending.reject(new ExternalCameraWindowError(
            'INVALID_RESPONSE',
            'The inventory window returned an invalid receipt.',
          )));
        }
        return;
      }
      const wasReceived = pendingCall.received;
      pendingCall.received = true;
      if (!wasReceived) {
        clearTimer(pendingCall.timer);
        pendingCall.timer = armPendingTimeout(
          pendingCall.callId,
          resultTimeoutMs,
          'LOOKUP_TIMEOUT',
          'The inventory lookup timed out.',
        );
        onReceipt();
      }
    } else if (data.type === 'scan-result') handleResult(data);
    else if (data.type === 'scan-error') handleError(data);
  }

  function start() {
    if (started || destroyed) return;
    started = true;
    readyStartedAt = now();
    eventTarget.addEventListener('message', onMessage);
    announceReady();
  }

  function submitScan(value) {
    if (destroyed || !connected) {
      return Promise.reject(new ExternalCameraWindowError(
        'APP_NOT_READY',
        'The inventory window is not connected.',
      ));
    }
    if (pendingCall) {
      return Promise.reject(new ExternalCameraWindowError('APP_BUSY', 'A lookup is already running.'));
    }
    if (callCount >= maxCalls) {
      return Promise.reject(new ExternalCameraWindowError(
        'APP_LIMIT_REACHED',
        'This camera session reached its lookup limit.',
      ));
    }

    let code;
    try {
      code = normalizeScanValue(value);
    } catch (error) {
      return Promise.reject(error);
    }
    let callId;
    try {
      callId = createSecureUuid(cryptoObject, issuedIds);
    } catch (error) {
      return Promise.reject(error);
    }
    callCount += 1;

    return new Promise((resolve, reject) => {
      const timer = armPendingTimeout(
        callId,
        receiptTimeoutMs,
        'RECEIPT_TIMEOUT',
        'The inventory window did not acknowledge the scan.',
      );
      pendingCall = { callId, resolve, reject, timer, received: false };
      try {
        post({ ...baseMessage('scan-code'), callId, code });
      } catch (error) {
        settlePending((pending) => pending.reject(error));
      }
    });
  }

  function teardown() {
    if (destroyed) return;
    try {
      post(baseMessage('camera-closing'));
    } catch {
      // The opener may already be gone; local camera cleanup must still continue.
    }
    destroyed = true;
    connected = false;
    clearReadyTimer();
    eventTarget.removeEventListener('message', onMessage);
    settlePending((pending) => pending.reject(new ExternalCameraWindowError(
      'CAMERA_CLOSED',
      'The camera page closed before the lookup completed.',
    )));
  }

  return Object.freeze({
    start,
    submitScan,
    teardown,
    isReady: () => connected && !destroyed && !openerIsClosed(),
    hasPendingCall: () => Boolean(pendingCall),
    getCallCount: () => callCount,
    getCameraNonce: () => cameraNonce,
  });
}

function scannerFormats(formatObject) {
  return [
    formatObject.QR_CODE,
    formatObject.CODE_128,
    formatObject.CODE_39,
    formatObject.CODE_93,
    formatObject.EAN_13,
    formatObject.EAN_8,
    formatObject.UPC_A,
    formatObject.UPC_E,
    formatObject.ITF,
    formatObject.DATA_MATRIX,
  ];
}

function cameraFailureMessage(error) {
  if (error?.code === 'CAMERA_SURFACE_UNAVAILABLE') {
    return 'The camera preview could not be displayed. Reload this camera tab and try again.';
  }
  if (isCameraPermissionError(error)) {
    return 'Camera permission was denied. Allow camera access for this page and try again.';
  }
  const text = cameraErrorText(error).toLowerCase();
  if (text.includes('notfounderror') || text.includes('no camera')) {
    return 'No camera was found on this device.';
  }
  if (text.includes('notreadableerror') || text.includes('trackstarterror')) {
    return 'The camera is busy. Close other camera apps and try again.';
  }
  return 'The camera could not start. Check browser camera access and try again.';
}

export function loadExternalScannerLibrary({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  source = EXTERNAL_SCANNER_LIBRARY_URL,
  integrity = EXTERNAL_SCANNER_LIBRARY_INTEGRITY,
} = {}) {
  if (
    typeof windowObject?.Html5Qrcode === 'function'
    && windowObject.Html5QrcodeSupportedFormats
  ) {
    return Promise.resolve();
  }
  if (!documentObject?.head || typeof documentObject.createElement !== 'function') {
    return Promise.reject(new ExternalCameraWindowError(
      'SCANNER_LIBRARY_UNAVAILABLE',
      'The scanner library could not be loaded.',
    ));
  }

  return new Promise((resolve, reject) => {
    const script = documentObject.createElement('script');
    script.src = source;
    script.async = true;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.setAttribute('data-inventory-camera-decoder', 'html5-qrcode-2.3.8');
    script.addEventListener('load', () => {
      if (
        typeof windowObject.Html5Qrcode === 'function'
        && windowObject.Html5QrcodeSupportedFormats
      ) {
        resolve();
      } else {
        reject(new ExternalCameraWindowError(
          'SCANNER_LIBRARY_INVALID',
          'The scanner library did not initialize.',
        ));
      }
    }, { once: true });
    script.addEventListener('error', () => reject(new ExternalCameraWindowError(
      'SCANNER_LIBRARY_UNAVAILABLE',
      'The scanner library could not be loaded.',
    )), { once: true });
    documentObject.head.appendChild(script);
  });
}

export function externalCameraOpenerIsClosed(openerWindow) {
  try {
    return !openerWindow || openerWindow.closed === true;
  } catch {
    // Some mobile browsers can temporarily make a live cross-origin WindowProxy
    // unreadable while changing tabs. Treat that as unknown; postMessage and the
    // authenticated parent stop message remain the authoritative liveness checks.
    return false;
  }
}

export function externalCameraReaderHasUsableWidth(reader) {
  let rectWidth = 0;
  try {
    rectWidth = Number(reader?.getBoundingClientRect?.().width) || 0;
  } catch {
    rectWidth = 0;
  }
  const clientWidth = Number(reader?.clientWidth) || 0;
  return Math.max(clientWidth, rectWidth) >= 1;
}

export function bootstrapExternalCameraPage({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  locationObject = globalThis.location,
  historyObject = globalThis.history,
  createClient = createExternalCameraWindowClient,
  createLifecycle = createCameraLifecycle,
  startCamera = startCameraWithCompatibility,
  scannerLibraryLoader = loadExternalScannerLibrary,
} = {}) {
  if (!windowObject || !documentObject || !locationObject) return null;

  const startButton = documentObject.getElementById('startButton');
  const stopButton = documentObject.getElementById('stopButton');
  const returnButton = documentObject.getElementById('returnButton');
  const status = documentObject.getElementById('status');
  const reader = documentObject.getElementById('reader');
  if (!startButton || !stopButton || !returnButton || !status || !reader) return null;

  const setStatus = (message, mode = '') => {
    status.textContent = message;
    status.className = mode;
  };

  let launch;
  try {
    launch = parseExternalCameraLaunch(locationObject.hash);
  } catch (error) {
    clearExternalCameraLaunchFragment(locationObject, historyObject);
    setStatus(error.message || 'Open this camera from the staging inventory app.', 'error');
    return null;
  }
  clearExternalCameraLaunchFragment(locationObject, historyObject);
  try { windowObject.name = ''; } catch {}

  if (externalCameraOpenerIsClosed(windowObject.opener)) {
    setStatus('Open this camera from the staging inventory app.', 'error');
    return null;
  }
  if (windowObject.isSecureContext !== true) {
    setStatus('Camera access requires a secure HTTPS page.', 'error');
    return null;
  }

  let connected = false;
  let lookupInFlight = false;
  let lastState = 'idle';
  let scannerReady = false;
  let scannerLoadPromise = null;
  let lifecycle = null;
  let client = null;
  let openerMonitor = null;
  let terminated = false;
  const scanGate = createScanGate();

  const updateButtons = () => {
    const idle = lastState === 'idle';
    startButton.disabled = terminated || !connected || !scannerReady || !idle || lookupInFlight;
    stopButton.disabled = terminated || !lastState.startsWith('scanner');
  };

  const stopOpenerMonitor = () => {
    if (openerMonitor === null) return;
    if (typeof windowObject.clearInterval === 'function') {
      windowObject.clearInterval(openerMonitor);
    }
    openerMonitor = null;
  };

  async function terminate(reason, message, mode = 'error') {
    if (terminated) return;
    terminated = true;
    connected = false;
    stopOpenerMonitor();
    updateButtons();
    if (client) client.teardown();
    if (lifecycle) await lifecycle.stop(reason);
    if (message) setStatus(message, mode);
  }

  function buildLifecycle() {
    const Html5QrcodeClass = windowObject.Html5Qrcode;
    const formatObject = windowObject.Html5QrcodeSupportedFormats;
    if (typeof Html5QrcodeClass !== 'function' || !formatObject) {
      throw new ExternalCameraWindowError(
        'SCANNER_LIBRARY_INVALID',
        'The scanner library did not initialize.',
      );
    }
    return createLifecycle({
      createScanner: () => new Html5QrcodeClass('reader', {
        formatsToSupport: scannerFormats(formatObject),
        verbose: false,
      }),
      reader,
      isHidden: () => documentObject.visibilityState === 'hidden',
      onStateChange(state) {
        lastState = state;
        reader.hidden = !state.startsWith('scanner');
        updateButtons();
      },
    });
  }

  function ensureScannerLibrary() {
    if (scannerLoadPromise) return scannerLoadPromise;
    scannerLoadPromise = Promise.resolve().then(() => scannerLibraryLoader({
      windowObject,
      documentObject,
    })).then(() => {
      if (terminated) return false;
      lifecycle = buildLifecycle();
      scannerReady = true;
      updateButtons();
      if (connected) setStatus('Connected. Tap Start camera when you are ready.', 'ok');
      return true;
    }).catch(() => {
      scannerReady = false;
      updateButtons();
      if (!terminated) {
        setStatus('The local scanner library did not load. Reload this page and try again.', 'error');
      }
      return false;
    });
    return scannerLoadPromise;
  }

  try {
    client = createClient({
      openerWindow: windowObject.opener,
      eventTarget: windowObject,
      parentOrigin: launch.parentOrigin,
      nonce: launch.nonce,
      cryptoObject: windowObject.crypto,
      setTimeout: windowObject.setTimeout.bind(windowObject),
      clearTimeout: windowObject.clearTimeout.bind(windowObject),
      onConnected() {
        connected = true;
        updateButtons();
        setStatus('Connected. Loading the local scanner library…');
        void ensureScannerLibrary();
      },
      onReceipt() {
        setStatus('Scan received by the inventory app. Waiting for the lookup…');
      },
      onStop() {
        void terminate(
          'parent-stop',
          'The inventory app closed this camera session.',
        );
      },
      onDiagnostic(details) {
        if (details?.code === 'HANDSHAKE_TIMEOUT') {
          void terminate(
            'handshake-timeout',
            'The inventory window did not answer. Return to it and open the camera again.',
          );
        } else if (details?.code === 'OPENER_UNAVAILABLE') {
          void terminate(
            'opener-unavailable',
            'The inventory window is no longer available. The camera has stopped.',
          );
        }
      },
    });
  } catch (error) {
    setStatus(error.message || 'The inventory connection could not start.', 'error');
    return null;
  }

  async function handleDecoded(decodedText) {
    const admission = scanGate.admit(decodedText, {
      ready: client.isReady(),
      busy: lookupInFlight,
    });
    if (!admission.accepted) return;

    lookupInFlight = true;
    updateButtons();
    setStatus('Code read. Stopping the camera before lookup…');
    if (lifecycle) await lifecycle.stop('decoded');
    setStatus('Looking up the scanned code in the inventory…');
    try {
      const result = await client.submitScan(admission.value);
      if (result.outcome === 'found') {
        setStatus('Item found. Return to the inventory window to view it.', 'ok');
      } else {
        setStatus('Item not found. Return to the inventory window for the result.');
      }
    } catch (error) {
      const code = String(error?.code || 'LOOKUP_FAILURE');
      setStatus(`The inventory lookup failed (${code}). Return to inventory and try again.`, 'error');
    } finally {
      lookupInFlight = false;
      updateButtons();
    }
  }

  async function startScanner() {
    if (!scannerReady || !lifecycle || !client.isReady() || lastState !== 'idle' || lookupInFlight) return;
    scanGate.rearm();
    setStatus('Starting camera…');
    const Html5QrcodeClass = windowObject.Html5Qrcode;
    const result = await startCamera({
      startAttempt: (source, scannerConfig) => lifecycle.startScanner((scanner) => {
        if (!externalCameraReaderHasUsableWidth(reader)) {
          throw new ExternalCameraWindowError(
            'CAMERA_SURFACE_UNAVAILABLE',
            'The camera preview area is not visible.',
          );
        }
        return scanner.start(source, scannerConfig, handleDecoded, () => {});
      }),
      enumerateCameras: () => Html5QrcodeClass.getCameras(),
      canContinue: () => client.isReady() && documentObject.visibilityState !== 'hidden',
    });
    if (result.ok) {
      setStatus('Camera ready. Hold one code inside the square.', 'ok');
    } else if (result.code === 'CAMERA_CANCELLED') {
      if (!terminated && documentObject.visibilityState === 'hidden') {
        setStatus('Camera start stopped because this tab stayed hidden. Return here and tap Start camera again.');
      }
    } else {
      setStatus(cameraFailureMessage(result.error), 'error');
    }
    updateButtons();
  }

  async function stopScanner(reason = 'manual') {
    if (lifecycle) await lifecycle.stop(reason);
    if (reason === 'manual') setStatus('Camera stopped.');
    updateButtons();
  }

  startButton.addEventListener('click', startScanner);
  stopButton.addEventListener('click', () => stopScanner('manual'));
  returnButton.addEventListener('click', () => {
    const cleanup = terminate('return-to-inventory');
    try { windowObject.opener.focus(); } catch {}
    try { windowObject.close(); } catch {}
    if (!windowObject.closed) {
      void cleanup.then(() => {
        setStatus('Return to the inventory tab; this browser kept the camera tab open.');
      });
    }
  });

  const stopForHiddenDocument = () => {
    if (
      documentObject.visibilityState === 'hidden'
      && lifecycle
      && lastState === 'scanner-running'
    ) {
      setStatus('Camera stopped because this tab was hidden. Tap Start camera to resume.');
      void lifecycle.stop('document-hidden').then(updateButtons);
    }
  };
  const teardown = () => { void terminate('page-exit'); };
  documentObject.addEventListener('visibilitychange', stopForHiddenDocument);
  windowObject.addEventListener('pagehide', teardown, { once: true });
  windowObject.addEventListener('beforeunload', teardown, { once: true });
  windowObject.addEventListener('pageshow', (event) => {
    if (event?.persisted && typeof windowObject.location?.reload === 'function') {
      windowObject.location.reload();
    }
  });

  client.start();
  if (typeof windowObject.setInterval === 'function') {
    openerMonitor = windowObject.setInterval(() => {
      if (externalCameraOpenerIsClosed(windowObject.opener)) {
        void terminate(
          'opener-closed',
          'The inventory window was closed. The camera has stopped.',
        );
      }
    }, 500);
  }
  updateButtons();
  return Object.freeze({
    client,
    getLifecycle: () => lifecycle,
    isScannerReady: () => scannerReady,
    teardown,
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootstrapExternalCameraPage();
}
