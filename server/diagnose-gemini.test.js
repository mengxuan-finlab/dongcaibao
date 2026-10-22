const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runDiagnostics } = require('./diagnose-gemini');

test('diagnostics make four small, separate calls with no application retries or report dependencies', async () => {
  const requests = [];
  const results = await runDiagnostics({ models: ['gemini-3.8-flash', 'gemini-3.6-flash'], generate: async args => {
    requests.push(args);
    return { text: args.config.responseMimeType ? '{"status":"OK"}' : 'OK', candidates: [{ finishReason: 'STOP' }] };
  } });
  assert.equal(requests.length, 4);
  assert.equal(results.every(row => row.outcome === 'success'), true);
  for (const request of requests) {
    assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
    assert.equal(request.config.httpOptions.timeout, 65000);
    assert.equal(request.config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(request.config.maxOutputTokens, 1024);
    assert.equal(request.contents.length < 100, true);
  }
  assert.equal(requests[0].config.responseJsonSchema, undefined);
  assert.equal(requests[1].config.responseJsonSchema.properties.status.enum[0], 'OK');
});

test('upstream failures are recorded once per probe rather than retried', async () => {
  let calls = 0;
  let clock = 0;
  const results = await runDiagnostics({ models: ['model'], now: () => clock, generate: async () => {
    calls++;
    clock += 1500;
    throw Object.assign(new Error('high demand'), { status: 503 });
  } });
  assert.equal(calls, 2);
  assert.equal(results.every(row => row.httpStatus === 503 && row.errorSource === 'gemini_api' && row.durationMs === 1500), true);
});

test('probe output failures remain distinct from API rejection and redact provider secrets', async () => {
  const results = await runDiagnostics({ models: ['model'], generate: async args => ({ text: args.config.responseMimeType ? '{' : 'wrong answer' }) });
  assert.equal(results[0].errorSource, 'probe_output');
  assert.equal(results[1].errorSource, 'json_parse');
  assert.equal(results.every(row => row.httpStatus === 200), true);
  const errors = await runDiagnostics({ models: ['model'], generate: async () => { throw new Error('failed ?key=secret Bearer token'); } });
  assert.equal(JSON.stringify(errors).includes('=secret'), false);
  assert.equal(JSON.stringify(errors).includes('Bearer token'), false);
});

test('duplicate models do not generate duplicate diagnostic work', async () => {
  let calls = 0;
  await runDiagnostics({ models: ['model', 'model'], generate: async args => {
    calls++;
    return { text: args.config.responseMimeType ? '{"status":"OK"}' : 'OK' };
  } });
  assert.equal(calls, 2);
});

test('CLI fails safely without a key instead of issuing an API request', () => {
  assert.throws(() => execFileSync(process.execPath, [`${__dirname}/diagnose-gemini.js`], {
    env: { ...process.env, GEMINI_API_KEY: '', DOTENV_CONFIG_QUIET: 'true' }, encoding: 'utf8', stdio: 'pipe'
  }), error => error.status === 2 && error.stderr.includes('GEMINI_API_KEY is not configured'));
});
