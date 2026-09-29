const PERMISSION_ERROR_NAMES = new Set([
  'notallowederror',
  'permissiondeniederror',
  'securityerror',
]);

const RETRYABLE_ERROR_NAMES = new Set([
  'aborterror',
  'constraintnotsatisfiederror',
  'devicesnotfounderror',
  'notfounderror',
  'notreadableerror',
  'overconstrainederror',
  'trackstarterror',
]);

export function cameraErrorText(error) {
  if (!error) return '';
  if (typeof error === 'string') return error;
  return [error.name, error.code, error.message]
    .filter(Boolean)
    .map((value) => String(value))
    .join(': ');
}

export function isCameraPermissionError(error) {
  const name = String(error?.name || '').trim().toLowerCase();
  if (PERMISSION_ERROR_NAMES.has(name)) return true;
  const text = cameraErrorText(error).toLowerCase();
  return text.includes('notallowederror')
    || text.includes('permissiondeniederror')
    || text.includes('securityerror')
    || text.includes('permission denied')
    || text.includes('not allowed');
}

export function isRetryableCameraError(error) {
  if (isCameraPermissionError(error)) return false;
  const name = String(error?.name || '').trim().toLowerCase();
  if (RETRYABLE_ERROR_NAMES.has(name)) return true;
  const text = cameraErrorText(error).toLowerCase();
  return [
    'overconstrained',
    'constraint not satisfied',
    'notfounderror',
    'no camera',
    'notreadableerror',
    'trackstarterror',
    'could not start video source',
    'aborterror',
  ].some((marker) => text.includes(marker));
}

export function boundedQrBox(viewfinderWidth, viewfinderHeight, { conservative = false } = {}) {
  const width = Number(viewfinderWidth);
  const height = Number(viewfinderHeight);
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 300;
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 300;
  const edge = Math.max(50, Math.min(safeWidth, safeHeight));
  const ratio = conservative ? 0.62 : 0.72;
  const preferred = Math.floor(edge * ratio);
  const cap = conservative ? 240 : 320;
  const size = Math.max(50, Math.min(edge, cap, preferred || edge));
  return { width: size, height: size };
}

export function scannerStartConfig({ conservative = false } = {}) {
  return {
    fps: conservative ? 5 : 8,
    qrbox: (width, height) => boundedQrBox(width, height, { conservative }),
    rememberLastUsedCamera: true,
  };
}

export function chooseRearCamera(devices) {
  const safeDevices = Array.isArray(devices)
    ? devices.filter((device) => device && typeof device.id === 'string' && device.id)
    : [];
  if (!safeDevices.length) return null;
  return safeDevices.find((device) => {
    const label = String(device.label || '').toLowerCase();
    return label.includes('back') || label.includes('rear') || label.includes('environment');
  }) || safeDevices[safeDevices.length - 1];
}

export async function startCameraWithCompatibility({
  startAttempt,
  enumerateCameras,
  canContinue = () => true,
} = {}) {
  if (typeof startAttempt !== 'function') {
    throw new TypeError('startAttempt must be a function');
  }

  const primary = await startAttempt(
    { facingMode: 'environment' },
    scannerStartConfig(),
  );
  if (
    primary?.ok
    || primary?.code !== 'SCANNER_START_FAILED'
    || !isRetryableCameraError(primary.error)
    || isCameraPermissionError(primary.error)
    || !canContinue()
  ) {
    return { ...primary, compatibilityFallback: false };
  }

  let devices = [];
  if (typeof enumerateCameras === 'function') {
    try {
      devices = await enumerateCameras();
    } catch (error) {
      if (isCameraPermissionError(error)) {
        return {
          ok: false,
          code: 'SCANNER_START_FAILED',
          error,
          compatibilityFallback: false,
        };
      }
      devices = [];
    }
  }
  if (!canContinue()) {
    return { ok: false, code: 'CAMERA_CANCELLED', compatibilityFallback: false };
  }

  const selected = chooseRearCamera(devices);
  const source = selected?.id || { facingMode: { exact: 'environment' } };
  const fallback = await startAttempt(
    source,
    scannerStartConfig({ conservative: true }),
  );
  return { ...fallback, compatibilityFallback: true };
}
