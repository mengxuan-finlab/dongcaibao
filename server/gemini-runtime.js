const { readFileSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { performance } = require('node:perf_hooks');

function installedSdkVersion() {
  let directory = dirname(require.resolve('@google/genai'));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (pkg.name === '@google/genai') return pkg.version;
    } catch { /* The entry point can be several directories below package.json. */ }
    directory = dirname(directory);
  }
  throw new Error('Cannot determine installed @google/genai version');
}

function httpStatus(error) {
  const status = Number(error?.status || error?.response?.status || error?.geminiHttpStatus);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function errorSource(error) {
  if (error?.geminiErrorSource) return error.geminiErrorSource;
  if (['AbortError', 'TimeoutError'].includes(error?.name)) return 'client_timeout';
  if (httpStatus(error) >= 400) return 'gemini_api';
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'].includes(error?.code || error?.cause?.code)) return 'network';
  return 'sdk';
}

function safeErrorMessage(error) {
  return String(error?.message || 'Unknown error')
    .replace(/AIza[\w-]+/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/([?&](?:key|api_key)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/("(?:api_key|apiKey|access_token|refresh_token)"\s*:\s*")[^"]+/gi, '$1[REDACTED]')
    .slice(0, 1200);
}

function retryDelayMs(index, { random = Math.random, retryAfterMs = 0 } = {}) {
  return Math.max(retryAfterMs, Math.min(8000, 1000 * (2 ** index) + Math.floor(random() * 250)));
}

// HTTP events measure time to headers; call events include body decoding (and streaming).
function createGeminiCaller({ client, log, fetchImpl = fetch, now = () => performance.now() }) {
  return async (args, context = {}, stream = false) => {
    const started = now();
    let status = null;
    let source = null;
    let retryAfterMs = 0;
    const emit = details => log({ ...context, model: args.model, ...details });
    const transport = args.config?.httpOptions?.fetch || fetchImpl;
    const observedFetch = async (url, init) => {
      const httpStarted = now();
      try {
        const response = await transport(url, init);
        status = response.status;
        source = response.ok ? null : 'gemini_api';
        const after = response.headers.get('retry-after');
        if (after) retryAfterMs = /^\d+(\.\d+)?$/.test(after)
          ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now()) || 0;
        emit({ event: 'gemini_http', phase: 'headers', durationMs: Math.round(now() - httpStarted), httpStatus: status, errorSource: source });
        return response;
      } catch (error) {
        source = init?.signal?.aborted ? 'client_timeout' : 'network';
        emit({ event: 'gemini_http', phase: 'headers', durationMs: Math.round(now() - httpStarted), httpStatus: null, errorSource: source });
        throw error;
      }
    };
    const request = { ...args, config: { ...args.config, httpOptions: {
      ...args.config?.httpOptions, retryOptions: { attempts: 1 }, fetch: observedFetch
    } } };
    const recordFailure = error => {
      error.geminiHttpStatus = status;
      error.geminiErrorSource = source || errorSource(error);
      error.retryAfterMs = retryAfterMs;
      emit({ event: 'gemini_call', outcome: 'failed', durationMs: Math.round(now() - started),
        httpStatus: httpStatus(error) || status, errorSource: error.geminiErrorSource, message: safeErrorMessage(error) });
    };
    try {
      if (!stream) {
        const result = await client.models.generateContent(request);
        emit({ event: 'gemini_call', outcome: 'success', durationMs: Math.round(now() - started), httpStatus: status, errorSource: null });
        return result;
      }
      const iterator = await client.models.generateContentStream(request);
      return (async function* () {
        let completed = false;
        let failed = false;
        try {
          yield* iterator;
          completed = true;
        } catch (error) {
          failed = true;
          recordFailure(error);
          throw error;
        } finally {
          if (!failed) emit({ event: 'gemini_call', outcome: completed ? 'success' : 'cancelled',
            durationMs: Math.round(now() - started), httpStatus: status, errorSource: null });
        }
      })();
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  };
}

module.exports = { installedSdkVersion, httpStatus, errorSource, safeErrorMessage, retryDelayMs, createGeminiCaller };
