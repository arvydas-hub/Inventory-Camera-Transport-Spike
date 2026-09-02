import { createBackend } from './backend.mjs?v=0.3.18-transport-2';
import { createCameraLifecycle } from './camera-lifecycle.mjs?v=0.3.18-camera-cleanup-2';
import { runTransportVariant } from './probes.mjs?v=0.3.18-transport-2';
import { createBridgeClient } from './bridge-client.mjs?v=0.3.19-bridge-1';
import { createAppFrameClient } from './app-frame-client.mjs?v=0.3.20-shell-1';

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
const embedBridgeButton = document.getElementById('embedBridgeButton');
const bridgePingButton = document.getElementById('bridgePingButton');
const bridgeBatchButton = document.getElementById('bridgeBatchButton');
const appFrameContainer = document.getElementById('appFrameContainer');
const appFrameStatus = document.getElementById('appFrameStatus');
const embedAppFrameButton = document.getElementById('embedAppFrameButton');
const manualScanInput = document.getElementById('manualScanInput');
const manualScanButton = document.getElementById('manualScanButton');
const probeLog = document.getElementById('probeLog');

const backend = createBackend({ mode: 'direct-fetch', timeoutMs: 15000 });
let bridgeClient = null;
let bridgeBackend = null;
let appFrameClient = null;
let appScanInFlight = false;
let appSessionGeneration = 0;
let decodeCount = 0;
let scanSequence = 0;
let lastDecodedValue = '';
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
  const decodedValue = String(decodedText || '').trim();
  if (!decodedValue) return;
  const now = Date.now();
  if (decodedValue === lastDecodedValue && now - lastDecodeAt < 1200) return;
  lastDecodedValue = decodedValue;
  lastDecodeAt = now;
  decodeCount += 1;
  scanSequence += 1;
  const format = decodedResult?.result?.format?.formatName || 'unknown';
  const metadata = {
    sequence: scanSequence,
    valueLength: decodedValue.length,
    format,
  };
  setCameraStatus(`Continuous scanner active. Decodes: ${decodeCount}`, 'ok');
  logObservation('scanner-decoded', metadata);
  void submitInventoryScan(decodedValue, metadata);
}

async function startContinuousScanner() {
  if (typeof Html5Qrcode !== 'function') {
    setCameraStatus('html5-qrcode did not load.', 'error');
    logObservation('scanner-library-missing');
    return;
  }
  decodeCount = 0;
  lastDecodedValue = '';
  lastDecodeAt = 0;
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
    result.serverReportedOk
      ? 'ok'
      : (result.responseReadable ? `error (${result.errorCode || 'SERVER_ERROR'})` : 'not readable'),
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
      responseReceived: result.responseReceived,
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

function bridgeErrorText(error) {
  const code = error?.code || error?.name || 'BRIDGE_ERROR';
  return `${code}: ${String(error?.message || 'Bridge operation failed.')}`;
}

function bridgeSetupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTopLevelDocument() {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

function setAppFrameStatus(text, mode = '') {
  appFrameStatus.textContent = text;
  appFrameStatus.className = `status ${mode}`.trim();
}

function normalizedAppState(value) {
  const candidate = typeof value === 'string'
    ? value
    : (value?.state || value?.appState || value?.status || '');
  return String(candidate).trim().toLowerCase();
}

function normalizedOperationOutcome(value) {
  const candidate = value?.outcome || value?.state || value?.status || '';
  return String(candidate).trim().toLowerCase();
}

function renderAppFrameControls() {
  const ready = Boolean(appFrameClient?.isReady());
  manualScanButton.disabled = !ready || appScanInFlight;
}

function handleAppState(value) {
  const state = normalizedAppState(value);
  if (state === 'ready') {
    setAppFrameStatus('Embedded inventory app ready for staging scans.', 'ok');
  } else if (state === 'registration-required') {
    setAppFrameStatus('Register this device inside the embedded app before sending scans.', 'error');
  } else if (state === 'busy') {
    setAppFrameStatus('Embedded inventory app is busy. Wait for the current action to finish.');
  } else if (state === 'connecting' || state === 'initializing' || state === 'loaded') {
    setAppFrameStatus('Embedded inventory app is initializing...');
  } else if (state === 'closed' || state === 'disconnected' || state === 'idle') {
    setAppFrameStatus('Embedded inventory app is disconnected.');
  } else if (state === 'error' || state === 'init-error' || state === 'unavailable') {
    setAppFrameStatus('Embedded inventory app could not become ready.', 'error');
  }
  renderAppFrameControls();
}

function handleOperationStatus(update) {
  if (!update || update.operation !== 'update-quantity') return;
  const outcome = normalizedOperationOutcome(update);
  if (outcome === 'pending' || outcome === 'started' || outcome === 'updating') {
    setAppFrameStatus('Embedded app is updating the staging quantity...');
  } else if (outcome === 'success' || outcome === 'succeeded' || outcome === 'ok') {
    setAppFrameStatus('Embedded app quantity update succeeded.', 'ok');
  } else if (
    outcome === 'failure'
    || outcome === 'failed'
    || outcome === 'error'
    || outcome === 'rejected'
    || outcome === 'runner-failure'
  ) {
    setAppFrameStatus('Embedded app quantity update failed.', 'error');
  }
}

function handleAppFrameDiagnostic() {
  if (!appFrameClient?.isReady()) {
    setAppFrameStatus('Waiting for a verified message from the embedded staging app.');
  }
}

function ensureAppFrameClient() {
  if (!isTopLevelDocument()) {
    throw bridgeSetupError(
      'TOP_LEVEL_REQUIRED',
      'Experiment B3 must run from the top-level diagnostic page.',
    );
  }
  if (appFrameClient) return appFrameClient;

  appFrameClient = createAppFrameClient({
    readyTimeoutMs: 20000,
    callTimeoutMs: 20000,
    onAppState: handleAppState,
    onOperationStatus: handleOperationStatus,
    onDiagnostic: handleAppFrameDiagnostic,
  });
  return appFrameClient;
}

function appFrameErrorCode(error) {
  const candidate = String(error?.code || error?.name || 'APP_FRAME_ERROR').toUpperCase();
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(candidate) ? candidate : 'APP_FRAME_ERROR';
}

function scanLogDetails(metadata, outcome, elapsedMs) {
  return {
    sequence: metadata.sequence,
    outcome,
    elapsedMs,
    valueLength: metadata.valueLength,
    format: metadata.format,
  };
}

function scanResultOutcome(result) {
  if (!result || result.ok !== true) return 'error';
  if (result.outcome === 'found' || result.outcome === 'not-found') return result.outcome;
  return 'error';
}

async function submitInventoryScan(value, metadata) {
  const code = String(value || '').trim();
  if (!code) return;

  if (!appFrameClient?.isReady()) {
    setAppFrameStatus('Scan was not sent because the embedded app is not ready.', 'error');
    logObservation('app-scan-result', scanLogDetails(metadata, 'not-ready', 0));
    renderAppFrameControls();
    return;
  }
  if (appScanInFlight) {
    setAppFrameStatus('Scan was not sent because the previous lookup is still running.');
    logObservation('app-scan-result', scanLogDetails(metadata, 'busy', 0));
    return;
  }

  const generation = appSessionGeneration;
  const startedAt = performance.now();
  appScanInFlight = true;
  renderAppFrameControls();
  setAppFrameStatus(`Looking up staging scan #${metadata.sequence}...`);

  try {
    const result = await appFrameClient.submitScan(code);
    if (generation !== appSessionGeneration) return;

    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    const outcome = scanResultOutcome(result);
    if (outcome === 'found') {
      setAppFrameStatus(`Staging scan #${metadata.sequence} found an item in ${elapsedMs} ms.`, 'ok');
    } else if (outcome === 'not-found') {
      setAppFrameStatus(`Staging scan #${metadata.sequence} did not find an item in ${elapsedMs} ms.`);
    } else {
      setAppFrameStatus(`Staging scan #${metadata.sequence} returned an invalid result.`, 'error');
    }
    logObservation('app-scan-result', scanLogDetails(metadata, outcome, elapsedMs));
  } catch (error) {
    if (generation !== appSessionGeneration) return;

    const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt));
    setAppFrameStatus(
      `Staging scan #${metadata.sequence} failed (${appFrameErrorCode(error)}).`,
      'error',
    );
    logObservation('app-scan-result', scanLogDetails(metadata, 'error', elapsedMs));
  } finally {
    if (generation === appSessionGeneration) {
      appScanInFlight = false;
      renderAppFrameControls();
    }
  }
}

async function embedInventoryApp() {
  embedAppFrameButton.disabled = true;
  appSessionGeneration += 1;
  appScanInFlight = false;
  renderAppFrameControls();
  setAppFrameStatus('Embedding the staging inventory app and verifying its handshake...');

  let activeClient;
  try {
    activeClient = ensureAppFrameClient();
  } catch (error) {
    setAppFrameStatus(`Embedded app setup failed (${appFrameErrorCode(error)}).`, 'error');
    embedAppFrameButton.disabled = false;
    return;
  }

  activeClient.teardown();
  appFrameContainer.replaceChildren();
  try {
    const appState = await activeClient.embed(gasExecUrl.value, appFrameContainer);
    embedAppFrameButton.textContent = 'Reload staging app';
    handleAppState(appState);
    if (activeClient.isReady()) {
      setAppFrameStatus('Embedded inventory app ready for staging scans.', 'ok');
    } else {
      handleAppState(activeClient.getAppState?.());
    }
  } catch (error) {
    setAppFrameStatus(`Embedded app handshake failed (${appFrameErrorCode(error)}).`, 'error');
  } finally {
    embedAppFrameButton.disabled = false;
    renderAppFrameControls();
  }
}

function sendManualStagingScan() {
  const code = manualScanInput.value.trim();
  if (!code) {
    setAppFrameStatus('Enter a mock staging code before sending.', 'error');
    return;
  }

  scanSequence += 1;
  const metadata = {
    sequence: scanSequence,
    valueLength: code.length,
    format: 'manual',
  };
  manualScanInput.value = '';
  void submitInventoryScan(code, metadata);
}

function teardownAppFrame() {
  appSessionGeneration += 1;
  appScanInFlight = false;
  appFrameClient?.teardown();
}

function ensureBridgeClient() {
  if (!isTopLevelDocument()) {
    throw bridgeSetupError(
      'TOP_LEVEL_REQUIRED',
      'Experiment B must run from the top-level diagnostic page.',
    );
  }
  if (bridgeClient && bridgeBackend) return bridgeClient;

  bridgeClient = createBridgeClient({
    readyTimeoutMs: 15000,
    callTimeoutMs: 15000,
    onDiagnostic(details) {
      logObservation('bridge-ready-rejected', details);
    },
  });
  bridgeBackend = createBackend({ mode: 'iframe-bridge', bridgeClient });
  return bridgeClient;
}

async function callBridgePing() {
  ensureBridgeClient();
  const startedAt = performance.now();
  const result = await bridgeBackend.call('bridgePing', []);
  if (!result || result.ok !== true || typeof result.receivedAt !== 'string') {
    throw new Error('The bridge returned an invalid ping result.');
  }
  return {
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    receivedAt: result.receivedAt,
  };
}

async function runSingleBridgePing() {
  bridgePingButton.disabled = true;
  bridgeBatchButton.disabled = true;
  bridgeStatus.textContent = 'Calling read-only bridgePing...';
  try {
    const result = await callBridgePing();
    bridgeStatus.textContent = `bridgePing succeeded in ${result.elapsedMs} ms.`;
    bridgeStatus.className = 'status ok';
    logObservation('bridge-ping-result', { ok: true, elapsedMs: result.elapsedMs });
  } catch (error) {
    bridgeStatus.textContent = bridgeErrorText(error);
    bridgeStatus.className = 'status error';
    logObservation('bridge-ping-result', {
      ok: false,
      errorCode: error?.code || error?.name || 'BRIDGE_ERROR',
    });
  } finally {
    const ready = Boolean(bridgeClient?.isReady());
    bridgePingButton.disabled = !ready;
    bridgeBatchButton.disabled = !ready;
  }
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

async function runBridgeReliability() {
  embedBridgeButton.disabled = true;
  bridgePingButton.disabled = true;
  bridgeBatchButton.disabled = true;
  const latencies = [];
  const failures = {};
  const total = 100;
  let attempted = 0;

  for (let index = 0; index < total; index += 1) {
    bridgeStatus.textContent = `Running bridge reliability check ${index + 1}/${total}...`;
    attempted += 1;
    try {
      const result = await callBridgePing();
      latencies.push(result.elapsedMs);
    } catch (error) {
      const code = error?.code || error?.name || 'BRIDGE_ERROR';
      failures[code] = (failures[code] || 0) + 1;
      break;
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const failed = attempted - sorted.length;
  const summary = {
    attempted,
    succeeded: sorted.length,
    failed,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    failures,
  };
  bridgeStatus.textContent = failed === 0
    ? `Bridge reliability passed 100/100 (p50 ${summary.p50Ms} ms, p95 ${summary.p95Ms} ms).`
    : `Bridge reliability stopped after failure: ${sorted.length}/${attempted} succeeded.`;
  bridgeStatus.className = failed === 0 ? 'status ok' : 'status error';
  logObservation('bridge-reliability-result', summary);
  embedBridgeButton.disabled = false;
  const ready = Boolean(bridgeClient?.isReady());
  bridgePingButton.disabled = !ready;
  bridgeBatchButton.disabled = !ready;
}

async function embedBridgeProbe() {
  embedBridgeButton.disabled = true;
  bridgePingButton.disabled = true;
  bridgeBatchButton.disabled = true;
  bridgeStatus.textContent = 'Inserting the staging bridge and waiting for a verified ready message...';
  bridgeStatus.className = 'status';
  let activeBridge;
  try {
    activeBridge = ensureBridgeClient();
  } catch (error) {
    bridgeStatus.textContent = bridgeErrorText(error);
    bridgeStatus.className = 'status error';
    logObservation('bridge-setup-failed', {
      errorCode: error?.code || error?.name || 'BRIDGE_ERROR',
    });
    embedBridgeButton.disabled = false;
    return;
  }
  activeBridge.teardown();
  bridgeContainer.replaceChildren();

  try {
    const readyPromise = activeBridge.embed(gasExecUrl.value, bridgeContainer);
    const frame = bridgeContainer.querySelector('iframe');
    if (frame) {
      frame.addEventListener('load', () => {
        logObservation('bridge-iframe-load-event');
      }, { once: true });
    }
    const ready = await readyPromise;
    bridgeStatus.textContent = 'Bridge ready; running the first read-only Apps Script ping...';
    bridgeStatus.className = 'status ok';
    logObservation('bridge-ready', { bridgeOrigin: ready.origin });
    bridgePingButton.disabled = false;
    bridgeBatchButton.disabled = false;
    await runSingleBridgePing();
  } catch (error) {
    bridgeStatus.textContent = bridgeErrorText(error);
    bridgeStatus.className = 'status error';
    logObservation('bridge-handshake-failed', {
      errorCode: error?.code || error?.name || 'BRIDGE_ERROR',
    });
  } finally {
    embedBridgeButton.disabled = false;
  }
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

if (!isTopLevelDocument()) {
  embedBridgeButton.disabled = true;
  bridgeStatus.textContent = 'Experiment B requires this diagnostic to be the top-level page.';
  bridgeStatus.className = 'status error';
  embedAppFrameButton.disabled = true;
  setAppFrameStatus('Experiment B3 requires this diagnostic to be the top-level page.', 'error');
  logObservation('bridge-top-level-required');
}

startCameraButton.addEventListener('click', startDirectCamera);
startScannerButton.addEventListener('click', startContinuousScanner);
stopCameraButton.addEventListener('click', () => stopAllCamera('manual'));
document.querySelectorAll('[data-transport-variant]').forEach((button) => {
  button.addEventListener('click', () => runTransport(button.dataset.transportVariant, button));
});
embedBridgeButton.addEventListener('click', embedBridgeProbe);
bridgePingButton.addEventListener('click', runSingleBridgePing);
bridgeBatchButton.addEventListener('click', runBridgeReliability);
embedAppFrameButton.addEventListener('click', embedInventoryApp);
manualScanButton.addEventListener('click', sendManualStagingScan);
manualScanInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendManualStagingScan();
});
document.getElementById('clearLogButton').addEventListener('click', () => {
  probeLog.textContent = '';
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCameraForLifecycle('document-hidden');
});
window.addEventListener('pagehide', () => stopCameraForLifecycle('pagehide'));
window.addEventListener('beforeunload', () => stopCameraForLifecycle('beforeunload'));
window.addEventListener('pagehide', () => bridgeClient?.teardown());
window.addEventListener('beforeunload', () => bridgeClient?.teardown());
window.addEventListener('pagehide', teardownAppFrame);
window.addEventListener('beforeunload', teardownAppFrame);
