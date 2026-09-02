export const TRANSPORT_VARIANTS = [
  'text-plain',
  'form-urlencoded',
  'application-json',
  'no-cors',
  'get',
];

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[Math.max(0, index)];
}

export function summarizeMeasurements(rows) {
  const elapsed = rows
    .filter((row) => row.ok && Number.isFinite(row.elapsedMs))
    .map((row) => row.elapsedMs);
  return {
    count: rows.length,
    successes: rows.filter((row) => row.ok).length,
    failures: rows.filter((row) => !row.ok).length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
  };
}

export async function runTransportVariant(backend, endpoint, variant, options = {}) {
  const started = performance.now();
  try {
    const result = await backend.call('transportProbe', [], {
      endpoint,
      transportVariant: variant,
      timeoutMs: options.timeoutMs,
    });
    return {
      variant,
      ok: true,
      elapsedMs: Math.round(performance.now() - started),
      requestIdMatched: result.body.requestId === result.requestId,
      responseReceived: true,
      responseReadable: true,
      responseStatus: result.meta.status,
      responseType: result.meta.type,
      serverReportedOk: result.body.ok === true,
    };
  } catch (error) {
    return {
      variant,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      requestIdMatched: error?.details?.requestIdMatched === true,
      responseReceived: error?.details?.responseReceived === true,
      responseReadable: error?.details?.bodyReadable === true,
      serverReportedOk: false,
      errorCode: error.code || error.name || 'ERROR',
      errorMessage: String(error.message || error),
    };
  }
}

export async function runSequentialProbe(backend, endpoint, count, options = {}) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(await runTransportVariant(backend, endpoint, options.variant || 'text-plain', options));
  }
  return { rows, summary: summarizeMeasurements(rows) };
}
