export class BackendError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    this.details = details;
  }
}

const ALLOWED_FUNCTIONS = new Set(['transportProbe', 'bridgePing']);
const DIRECT_VARIANTS = new Set([
  'text-plain',
  'form-urlencoded',
  'application-json',
  'no-cors',
  'get',
]);

function validateGasExecUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new BackendError('INVALID_ENDPOINT', 'Enter a valid staging Apps Script /exec URL.');
  }

  const validPath = /^\/macros\/s\/[^/]+\/exec\/?$/.test(parsed.pathname);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'script.google.com' || !validPath) {
    throw new BackendError(
      'INVALID_ENDPOINT',
      'The endpoint must be an HTTPS script.google.com /macros/s/.../exec URL.',
    );
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function createRequestId(randomUUID) {
  if (typeof randomUUID === 'function') return randomUUID();
  return `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function buildEnvelope(functionName, args, requestId, now) {
  return {
    action: functionName,
    requestId,
    sentAt: new Date(now()).toISOString(),
    args: Array.isArray(args) ? args : [],
  };
}

function requestForVariant(endpoint, envelope, variant) {
  if (!DIRECT_VARIANTS.has(variant)) {
    throw new BackendError('UNKNOWN_VARIANT', `Unsupported direct-fetch variant: ${variant}`);
  }

  const url = new URL(endpoint);
  url.searchParams.set('view', 'transport-probe');

  if (variant === 'get') {
    url.searchParams.set('action', envelope.action);
    url.searchParams.set('requestId', envelope.requestId);
    url.searchParams.set('sentAt', envelope.sentAt);
    return {
      url,
      init: {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
      },
    };
  }

  if (variant === 'form-urlencoded') {
    const form = new URLSearchParams();
    form.set('action', envelope.action);
    form.set('requestId', envelope.requestId);
    form.set('sentAt', envelope.sentAt);
    form.set('args', JSON.stringify(envelope.args));
    return {
      url,
      init: {
        method: 'POST',
        redirect: 'follow',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: form.toString(),
      },
    };
  }

  const isJson = variant === 'application-json';
  const init = {
    method: 'POST',
    redirect: 'follow',
    credentials: 'omit',
    headers: {
      'Content-Type': isJson ? 'application/json' : 'text/plain;charset=UTF-8',
    },
    body: JSON.stringify(envelope),
  };
  if (variant === 'no-cors') init.mode = 'no-cors';
  return { url, init };
}

async function parseReadableResponse(response, requestId) {
  if (!response || response.type === 'opaque') {
    throw new BackendError(
      'OPAQUE_RESPONSE',
      'The request may have been delivered, but browser JavaScript cannot read the response.',
      {
        responseReceived: Boolean(response),
        bodyReadable: false,
        responseType: response ? response.type : 'missing',
      },
    );
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    throw new BackendError('UNREADABLE_RESPONSE', 'The browser could not read the response body.', {
      responseReceived: true,
      bodyReadable: false,
      status: response.status,
      responseType: response.type,
    });
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new BackendError('INVALID_JSON', 'The readable response was not valid JSON.', {
      status: response.status,
      responseReceived: true,
      bodyReadable: true,
      responseType: response.type,
    });
  }

  if (!response.ok || body?.ok !== true) {
    throw new BackendError(
      body?.error?.code || 'SERVER_ERROR',
      body?.error?.message || `The backend returned status ${response.status}.`,
      {
        status: response.status,
        responseReceived: true,
        bodyReadable: true,
        responseType: response.type,
        requestIdMatched: body?.requestId === requestId,
      },
    );
  }
  if (body.requestId !== requestId) {
    throw new BackendError('REQUEST_ID_MISMATCH', 'The returned request ID did not match the request.', {
      status: response.status,
      responseReceived: true,
      bodyReadable: true,
      responseType: response.type,
    });
  }

  return {
    body,
    meta: {
      status: response.status,
      ok: response.ok,
      type: response.type,
    },
  };
}

export function createBackend(config = {}) {
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const randomUUID = config.randomUUID || globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const now = config.now || Date.now;
  const defaultTimeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 15000;
  let mode = config.mode || 'direct-fetch';

  async function directFetchCall(functionName, args, options = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new BackendError('FETCH_UNAVAILABLE', 'This browser does not expose fetch().');
    }

    const endpoint = validateGasExecUrl(options.endpoint || config.endpoint);
    const requestId = options.requestId || createRequestId(randomUUID);
    const variant = options.transportVariant || 'text-plain';
    const envelope = buildEnvelope(functionName, args, requestId, now);
    const request = requestForVariant(endpoint, envelope, variant);
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : defaultTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = now();

    try {
      const response = await fetchImpl(request.url, {
        ...request.init,
        signal: controller.signal,
      });
      const parsed = await parseReadableResponse(response, requestId);
      return {
        ok: true,
        requestId,
        elapsedMs: Math.max(0, now() - startedAt),
        transport: 'direct-fetch',
        variant,
        ...parsed,
      };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new BackendError('TIMEOUT', `The backend call exceeded ${timeoutMs} ms.`, {
          responseReceived: false,
          bodyReadable: false,
        });
      }
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        'FETCH_FAILED',
        'Browser fetch failed before a readable Apps Script response was available.',
        {
          responseReceived: false,
          bodyReadable: false,
          errorName: error?.name || 'Error',
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getMode() {
      return mode;
    },

    setMode(nextMode) {
      if (!['direct-fetch', 'iframe-bridge'].includes(nextMode)) {
        throw new BackendError('UNKNOWN_MODE', `Unsupported backend mode: ${nextMode}`);
      }
      mode = nextMode;
    },

    async call(functionName, args = [], options = {}) {
      if (!ALLOWED_FUNCTIONS.has(functionName)) {
        throw new BackendError('FUNCTION_NOT_ALLOWED', `Function is not allowlisted: ${functionName}`);
      }
      if (mode === 'direct-fetch') return directFetchCall(functionName, args, options);
      if (mode === 'iframe-bridge' && config.bridgeClient?.call) {
        return config.bridgeClient.call(functionName, args, options);
      }
      throw new BackendError('BRIDGE_NOT_READY', 'The iframe bridge has not completed its handshake.');
    },
  };
}

export const backendInternals = {
  validateGasExecUrl,
  requestForVariant,
  parseReadableResponse,
};
