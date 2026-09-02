import { createBackend } from './backend.mjs';
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
let directStream = null;
let scanner = null;
let scannerRunning = false;
let decodeCount = 0;
let lastDecodeSignature = '';
let lastDecodeAt = 0;
let cameraRequestGeneration = 0;

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

function stopDirectStream() {
  if (directStream) {
    directStream.getTracks().forEach((track) => track.stop());
    directStream = null;
  }
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
}

async function stopScanner() {
  if (!scanner || !scannerRunning) {
    reader.hidden = true;
    return;
  }
  try {
    await scanner.stop();
  } catch (error) {
    logObservation('scanner-stop-error', safeError(error));
  }
  try {
    scanner.clear();
  } catch {
    // A partially started library instance may have no surface to clear.
  }
  scannerRunning = false;
  reader.hidden = true;
}

async function stopAllCamera() {
  cameraRequestGeneration += 1;
  stopDirectStream();
  await stopScanner();
  setCameraStatus('Camera stopped.');
  logObservation('camera-stopped');
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
  if (scannerRunning) {
    setCameraStatus('Stop the continuous scanner before starting the direct camera probe.', 'error');
    return;
  }
  const requestGeneration = ++cameraRequestGeneration;
  stopDirectStream();
  setCameraStatus('Requesting top-level camera permission...');
  logObservation('camera-request', {
    origin: location.origin,
    secureContext: window.isSecureContext,
    cameraPolicy: cameraPolicyValue(),
  });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
      audio: false,
    });
    if (requestGeneration !== cameraRequestGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      logObservation('camera-request-cancelled');
      return;
    }
    directStream = stream;
    cameraPreview.srcObject = directStream;
    cameraPreview.hidden = false;
    await cameraPreview.play();
    const videoTrack = directStream.getVideoTracks()[0];
    setCameraStatus('Top-level camera stream opened.', 'ok');
    logObservation('camera-opened', { track: publicTrackSettings(videoTrack) });
  } catch (error) {
    stopDirectStream();
    setCameraStatus(`Camera failed: ${error?.name || 'Error'}`, 'error');
    logObservation('camera-failed', safeError(error));
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
  if (scannerRunning) return;
  cameraRequestGeneration += 1;
  stopDirectStream();
  if (typeof Html5Qrcode !== 'function') {
    setCameraStatus('html5-qrcode did not load.', 'error');
    logObservation('scanner-library-missing');
    return;
  }
  reader.hidden = false;
  scanner = scanner || new Html5Qrcode('reader');
  decodeCount = 0;
  setCameraStatus('Starting top-level continuous scanner...');
  logObservation('scanner-request', {
    origin: location.origin,
    secureContext: window.isSecureContext,
    cameraPolicy: cameraPolicyValue(),
  });
  try {
    await scanner.start(
      { facingMode: 'environment' },
      scannerConfig(),
      noteDecode,
      () => {},
    );
    scannerRunning = true;
    setCameraStatus('Continuous scanner active. Decodes: 0', 'ok');
    logObservation('scanner-opened');
  } catch (error) {
    scannerRunning = false;
    reader.hidden = true;
    setCameraStatus(`Scanner failed: ${error?.name || 'Error'}`, 'error');
    logObservation('scanner-failed', safeError(error));
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
stopCameraButton.addEventListener('click', stopAllCamera);
document.querySelectorAll('[data-transport-variant]').forEach((button) => {
  button.addEventListener('click', () => runTransport(button.dataset.transportVariant, button));
});
document.getElementById('embedBridgeButton').addEventListener('click', embedBridgeProbe);
document.getElementById('clearLogButton').addEventListener('click', () => {
  probeLog.textContent = '';
});
window.addEventListener('pagehide', () => {
  stopDirectStream();
  if (scanner && scannerRunning) scanner.stop().catch(() => {});
});
