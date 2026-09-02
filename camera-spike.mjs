import { createBackend } from './backend.mjs';
import { createCameraLifecycle } from './camera-lifecycle.mjs?v=0.3.18-camera-cleanup-1';
import { runTransportVariant } from './probes.mjs';

const startCameraButton = document.getElementById('startCameraButton');
const startScannerButton = document.getElementById('startScannerButton');
const stopCameraButton = document.getElementById('stopCameraButton');
const cameraStatus = document.getElementById('cameraStatus');
const cameraPreview = document.getElementById('cameraPreview');
const reader = document.getElementById('reader');
const gasExecUrl = document.getElementById('gasExecUrl');
const transportResults = document.getElementById('transportResults');
const bridgeContainer = document.getElementById('bridgeContainer');
const bridgeStatus = document.getElementById('bridgeStatus');
const probeLog = document.getElementById('probeLog');

const backend = createBackend({ mode: 'direct-fetch', timeoutMs: 15000 });
let decodeCount = 0;
let lastDecodeSignature = '';
let lastDecodeAt = 0;

function cameraPolicyValue() {
  const policy = document.permissionsPolicy || document.featurePolicy;
  if (!policy || typeof policy.allowsFeature !== 'function') return 'unavailable';
  try {
    return String(policy.allowsFeature('camera'));
  } catch {
    return 'query-error';
  }
}

function safeError(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || undefined,
    message: String(error?.message || error || 'Unknown error'),
  };
}

function logObservation(kind, details = {}) {
  const record = {
    at: new Date().toISOString(),
    kind,
    ...details,
  };
  probeLog.textContent += `${JSON.stringify(record)}\n`;
  probeLog.scrollTop = probeLog.scrollHeight;
}

function setCameraStatus(text, mode = '') {
  cameraStatus.textContent = text;
  cameraStatus.className = `status ${mode}`.trim();
}

function renderCameraState(state) {
  const idle = state === 'idle';
  startCameraButton.disabled = !idle;
  startScannerButton.disabled = !idle;
  stopCameraButton.disabled = idle;
}

const cameraLifecycle = createCameraLifecycle({
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createScanner: () => new Html5Qrcode('reader'),
  preview: cameraPreview,
  reader,
  isHidden: () => document.visibilityState === 'hidden',
  onStateChange: renderCameraState,
});
renderCameraState(cameraLifecycle.getState());

async function stopAllCamera(reason = 'manual') {
  await cameraLifecycle.stop(reason);
  setCameraStatus('Camera stopped.');
  logObservation('camera-stopped', { reason });
}

function stopCameraForLifecycle(reason) {
  if (cameraLifecycle.getState() === 'idle') return;
  setCameraStatus('Camera stopped.');
  logObservation('camera-stopped', { reason });
  void cameraLifecycle.stop(reason);
}

function publicTrackSettings(track) {
  const settings = track?.getSettings ? track.getSettings() : {};
  return {
    width: settings.width,
    height: settings.height,
    frameRate: settings.frameRate,
    facingMode: settings.facingMode,
  };
}

async function startDirectCamera() {
  setCameraStatus('Requesting top-level camera permission...');
  logObservation('camera-request', {
    origin: location.origin,
    secureContext: window.isSecureContext,
    cameraPolicy: cameraPolicyValue(),
  });
  const result = await cameraLifecycle.startDirect({
      video: { facingMode: 'environment' },
      audio: false,
  });
  if (result.ok) {
    const videoTrack = result.stream.getVideoTracks()[0];
    setCameraStatus('Top-level camera stream opened.', 'ok');
    logObservation('camera-opened', { track: publicTrackSettings(videoTrack) });
  } else if (result.code === 'CAMERA_CANCELLED') {
    logObservation('camera-request-cancelled');
  } else if (result.code === 'CAMERA_BUSY') {
    setCameraStatus('Stop the current camera operation before starting another.', 'error');
  } else {
    setCameraStatus(`Camera failed: ${result.error?.name || 'Error'}`, 'error');
    logObservation('camera-failed', safeError(result.error));
  }
}

function scannerConfig() {
  return {
    fps: 10,
    qrbox(viewfinderWidth, viewfinderHeight) {
      const minEdge = Math.min(viewfinderWidth || 300, viewfinderHeight || 300);
      const size = Math.max(180, Math.floor(minEdge * 0.72));
      return { width: size, height: size };
    },
    aspectRatio: 1.333334,
    rememberLastUsedCamera: true,
    formatsToSupport: [
      Html5QrcodeSupportedFormats.QR_CODE,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.DATA_MATRIX,
    ],
  };
}

function noteDecode(decodedText, decodedResult) {
  const now = Date.now();
  const signature = `${String(decodedText).length}:${decodedResult?.result?.format?.formatName || ''}`;
  if (signature === lastDecodeSignature && now - lastDecodeAt < 1200) return;
  lastDecodeSignature = signature;
  lastDecodeAt = now;
  decodeCount += 1;
  setCameraStatus(`Continuous scanner active. Decodes: ${decodeCount}`, 'ok');
  logObservation('scanner-decoded', {
    sequence: decodeCount,
    valueLength: String(decodedText).length,
    format: decodedResult?.result?.format?.formatName || 'unknown',
  });
}

async function startContinuousScanner() {
  if (typeof Html5Qrcode !== 'function') {
    setCameraStatus('html5-qrcode did not load.', 'error');
    logObservation('scanner-library-missing');
    return;
  }
  decodeCount = 0;
  setCameraStatus('Starting top-level continuous scanner...');
  logObservation('scanner-request', {
    origin: location.origin,
    secureContext: window.isSecureContext,
    cameraPolicy: cameraPolicyValue(),
  });
  const result = await cameraLifecycle.startScanner((candidate) => (
    candidate.start(
      { facingMode: 'environment' },
      scannerConfig(),
      noteDecode,
      () => {},
    )
  ));
  if (result.ok) {
    setCameraStatus('Continuous scanner active. Decodes: 0', 'ok');
    logObservation('scanner-opened');
  } else if (result.code === 'CAMERA_CANCELLED') {
    logObservation('scanner-request-cancelled');
  } else if (result.code === 'CAMERA_BUSY') {
    setCameraStatus('Stop the current camera operation before starting another.', 'error');
  } else {
    setCameraStatus(`Scanner failed: ${result.error?.name || 'Error'}`, 'error');
    logObservation('scanner-failed', safeError(result.error));
  }
}

function appendTransportResult(result) {
  const row = document.createElement('tr');
  const cells = [
    result.variant,
    result.ok ? 'resolved' : `failed (${result.errorCode || 'ERROR'})`,
    result.responseReadable ? 'yes' : 'no',
    result.requestIdMatched ? 'yes' : 'no',
    result.serverReportedOk ? 'ok' : (result.ok ? 'unknown' : 'not readable'),
    `${result.elapsedMs} ms`,
  ];
  cells.forEach((value) => {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
  });
  transportResults.prepend(row);
}

async function runTransport(variant, button) {
  button.disabled = true;
  try {
    const result = await runTransportVariant(backend, gasExecUrl.value, variant);
    appendTransportResult(result);
    logObservation('transport-result', {
      variant: result.variant,
      ok: result.ok,
      responseReadable: result.responseReadable,
      requestIdMatched: result.requestIdMatched,
      serverReportedOk: result.serverReportedOk,
      elapsedMs: result.elapsedMs,
      errorCode: result.errorCode,
    });
  } finally {
    button.disabled = false;
  }
}

function embedBridgeProbe() {
  bridgeContainer.replaceChildren();
  let endpoint;
  try {
    endpoint = new URL(gasExecUrl.value);
  } catch {
    bridgeStatus.textContent = 'Enter a valid staging /exec URL first.';
    bridgeStatus.className = 'status error';
    return;
  }
  const nonce = crypto.randomUUID
    ? crypto.randomUUID()
    : `nonce-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  endpoint.searchParams.set('view', 'bridge-probe');
  endpoint.searchParams.set('nonce', nonce);
  endpoint.searchParams.set('parentOrigin', location.origin);
  const frame = document.createElement('iframe');
  frame.title = 'Apps Script bridge probe';
  frame.src = endpoint.href;
  frame.dataset.nonce = nonce;
  bridgeContainer.appendChild(frame);
  bridgeStatus.textContent = 'Bridge iframe inserted; waiting for load/console evidence.';
  bridgeStatus.className = 'status';
  logObservation('bridge-iframe-inserted', { parentOrigin: location.origin });
}

document.getElementById('environmentSummary').textContent = [
  `Origin: ${location.origin}`,
  `Secure context: ${window.isSecureContext}`,
  `Camera policy: ${cameraPolicyValue()}`,
  `Browser: ${navigator.userAgent}`,
].join(' | ');

logObservation('page-ready', {
  origin: location.origin,
  secureContext: window.isSecureContext,
  cameraPolicy: cameraPolicyValue(),
  userAgent: navigator.userAgent,
});

startCameraButton.addEventListener('click', startDirectCamera);
startScannerButton.addEventListener('click', startContinuousScanner);
stopCameraButton.addEventListener('click', () => stopAllCamera('manual'));
document.querySelectorAll('[data-transport-variant]').forEach((button) => {
  button.addEventListener('click', () => runTransport(button.dataset.transportVariant, button));
});
document.getElementById('embedBridgeButton').addEventListener('click', embedBridgeProbe);
document.getElementById('clearLogButton').addEventListener('click', () => {
  probeLog.textContent = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCameraForLifecycle('document-hidden');
});
window.addEventListener('pagehide', () => stopCameraForLifecycle('pagehide'));
window.addEventListener('beforeunload', () => stopCameraForLifecycle('beforeunload'));
