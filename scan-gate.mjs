export const SCAN_GATE_REASON = Object.freeze({
  ACCEPTED: 'accepted',
  EMPTY: 'empty',
  NOT_READY: 'not-ready',
  BUSY: 'busy',
  DUPLICATE: 'duplicate',
});

function normalizeScanValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function createScanGate({ normalize = normalizeScanValue } = {}) {
  if (typeof normalize !== 'function') {
    throw new TypeError('normalize must be a function');
  }

  let latchedValue = null;

  function admit(value, { ready = false, busy = false } = {}) {
    const normalizedValue = normalize(value);
    if (!normalizedValue) {
      return { accepted: false, reason: SCAN_GATE_REASON.EMPTY };
    }
    if (!ready) {
      return { accepted: false, reason: SCAN_GATE_REASON.NOT_READY };
    }
    if (busy) {
      return { accepted: false, reason: SCAN_GATE_REASON.BUSY };
    }
    if (normalizedValue === latchedValue) {
      return { accepted: false, reason: SCAN_GATE_REASON.DUPLICATE };
    }

    latchedValue = normalizedValue;
    return {
      accepted: true,
      reason: SCAN_GATE_REASON.ACCEPTED,
      value: normalizedValue,
    };
  }

  function rearm() {
    const changed = latchedValue !== null;
    latchedValue = null;
    return { rearmed: changed };
  }

  function reset() {
    latchedValue = null;
  }

  return {
    admit,
    rearm,
    reset,
    hasLatch: () => latchedValue !== null,
  };
}
