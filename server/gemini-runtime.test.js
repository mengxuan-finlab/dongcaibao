const test = require('node:test');
const assert = require('node:assert/strict');
const { GoogleGenAI } = require('@google/genai');
const { installedSdkVersion, createGeminiCaller, httpStatus, errorSource, retryDelayMs } = require('./gemini-runtime');

const failure = status => new Response(JSON.stringify({ error: { code: status, message: 'test failure' } }), {
  status, headers: { 'content-type': 'application/json' }
});
const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), {
  status: 200, headers: { 'content-type': 'application/json' }
});
const client = () => new GoogleGenAI({ apiKey: 'test-only-not-a-real-key', apiVersion: 'v1beta' });

test('installed SDK is pinned to the audited 2.24.0 package', () => {
  assert.equal(installedSdkVersion(), '2.24.0');
});

test('real SDK has no automatic HTTP retries when retryOptions are absent', async () => {
  let calls = 0;
  await assert.rejects(client().models.generateContent({
    model: 'gemini-3.8-flash', contents: 'test', config: { httpOptions: {
      fetch: async () => { calls++; return failure(503); }
    } }
  }), { status: 503 });
  assert.equal(calls, 1);
});

test('real SDK uses five attempts when retryOptions exists but attempts is omitted', async () => {
  let calls = 0;
  await assert.rejects(client().models.generateContent({
    model: 'gemini-3.8-flash', contents: 'test', config: { httpOptions: {
      retryOptions: { initialDelay: 0.001, maxDelay: 0.001, jitter: 0 },
      fetch: async () => { calls++; return failure(503); }
    } }
  }), { status: 503 });
  assert.equal(calls, 5);
});

test('observed calls disable SDK retries and record HTTP status, timing, source and Retry-After', async () => {
  let calls = 0;
  let clock = 0;
  const events = [];
  const call = createGeminiCaller({ client: client(), now: () => clock, log: event => events.push(event), fetchImpl: async () => {
    calls++;
    clock += 20;
    const response = failure(503);
    response.headers.set('retry-after', '2');
    return response;
  } });
  await assert.rejects(call({ model: 'gemini-3.8-flash', contents: 'private prompt', config: {
    httpOptions: { retryOptions: { attempts: 5 } }
  } }, { requestId: 'test-id', attempt: 1 }), error => {
    assert.equal(error.geminiErrorSource, 'gemini_api');
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'gemini_http');
  assert.equal(events[1].event, 'gemini_call');
  assert.equal(events[1].httpStatus, 503);
  assert.equal(events[1].durationMs, 20);
  assert.equal(events[1].requestId, 'test-id');
  assert.equal(JSON.stringify(events).includes('private prompt'), false);
  assert.equal(JSON.stringify(events).includes('test-only-not-a-real-key'), false);
});

test('real SDK sends timeout as X-Server-Timeout and client abort bounds stalled fetches', async () => {
  const events = [];
  const call = createGeminiCaller({ client: client(), log: event => events.push(event), fetchImpl: async (url, init) => {
    assert.equal(new Headers(init.headers).get('x-server-timeout'), '1');
    return new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('abort did not arrive')), 1000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(keepAlive);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    });
  } });
  await assert.rejects(call({ model: 'gemini-3.8-flash', contents: 'test', config: {
    httpOptions: { timeout: 30 }, abortSignal: AbortSignal.timeout(50)
  } }), error => error.geminiErrorSource === 'client_timeout');
  assert.equal(events.at(-1).httpStatus, null);
  assert.equal(events.at(-1).errorSource, 'client_timeout');
});

test('successful real SDK calls produce a successful completion log', async () => {
  const events = [];
  const call = createGeminiCaller({ client: client(), log: event => events.push(event), fetchImpl: async () => success() });
  assert.equal((await call({ model: 'gemini-3.8-flash', contents: 'test' })).text, 'ok');
  assert.equal(events.at(-1).outcome, 'success');
  assert.equal(events.at(-1).httpStatus, 200);
});

test('network and SDK validation failures remain distinguishable without fake HTTP codes', async () => {
  const events = [];
  const call = createGeminiCaller({ client: client(), log: event => events.push(event), fetchImpl: async () => {
    throw new TypeError('fetch failed');
  } });
  await assert.rejects(call({ model: 'gemini-3.8-flash', contents: 'test' }));
  assert.equal(events.at(-1).httpStatus, null);
  assert.equal(events.at(-1).errorSource, 'network');
  assert.equal(httpStatus(new Error('bad config')), null);
  assert.equal(errorSource(new Error('bad config')), 'sdk');
});

test('backoff grows exponentially, has a cap, and honors a longer Retry-After', () => {
  assert.equal(retryDelayMs(0, { random: () => 0 }), 1000);
  assert.equal(retryDelayMs(1, { random: () => 0 }), 2000);
  assert.equal(retryDelayMs(10, { random: () => 0 }), 8000);
  assert.equal(retryDelayMs(0, { random: () => 0, retryAfterMs: 10000 }), 10000);
});

test('stream logs completion and distinguishes a stream read failure', async () => {
  for (const fail of [false, true]) {
    const events = [];
    const streamingClient = { models: { async generateContentStream(request) {
      await request.config.httpOptions.fetch('https://example.test', {});
      return (async function* () {
        yield { text: 'first' };
        if (fail) throw Object.assign(new Error('body aborted'), { name: 'AbortError' });
      })();
    } } };
    const call = createGeminiCaller({ client: streamingClient, log: event => events.push(event), fetchImpl: async () => success() });
    const stream = await call({ model: 'model', contents: 'test' }, { requestId: 'stream-id' }, true);
    const consume = async () => { for await (const chunk of stream) assert.equal(chunk.text, 'first'); };
    if (fail) await assert.rejects(consume()); else await consume();
    const completion = events.at(-1);
    assert.equal(completion.event, 'gemini_call');
    assert.equal(completion.outcome, fail ? 'failed' : 'success');
    assert.equal(completion.httpStatus, 200);
    assert.equal(completion.errorSource, fail ? 'client_timeout' : null);
  }
});

test('cancelled streams emit a terminal log instead of disappearing from diagnostics', async () => {
  const events = [];
  const call = createGeminiCaller({ client: { models: {
    generateContentStream: async () => (async function* () { yield { text: 'first' }; yield { text: 'second' }; })()
  } }, log: event => events.push(event) });
  for await (const chunk of await call({ model: 'model', contents: 'test' }, {}, true)) {
    assert.equal(chunk.text, 'first');
    break;
  }
  assert.equal(events.at(-1).outcome, 'cancelled');
});
