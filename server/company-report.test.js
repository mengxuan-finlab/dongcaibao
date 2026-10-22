const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { buildContract, providerSchema, safeErrorMessage, reportErrorResponse, validateReport, generateValidatedReport, collectSearchResults, createReportCache } = require('./company-report');

const server = readFileSync(`${__dirname}/server.js`, 'utf8');
const promptCode = server.slice(server.indexOf('const getBasePrompt ='), server.indexOf('const getProPrompt ='));
const basePrompt = new Function(promptCode + '\nreturn getBasePrompt("AAPL", "facts", "US");')();
const { schema } = buildContract(basePrompt);

function sample(node, path = 'report', index = 0) {
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, sample(child, `${path}.${key}`, index)]));
  if (node.type === 'array') return Array.from({ length: node.minItems }, (_, i) => sample(node.items, `${path}[${i}]`, i));
  return node.enum ? node.enum[index % node.enum.length] : `${path} 的完整分析內容`;
}

test('contract keeps all original sections and minimum analysis counts', () => {
  const report = sample(schema);
  validateReport(report, schema);
  assert.equal(Object.keys(report.dashboard).length, 11);
  assert.equal(report.dashboard.research.metrics.length, 6);
  assert.equal(report.timeline.items.length, 4);
  assert.equal(report.dashboard.newsTags.length, 5);
  assert.equal(report.valueChain.company, 'AAPL');
  const contract = buildContract(basePrompt);
  assert.equal(contract.prompt.includes('<!--'), false);
});

test('missing chapter, empty field and duplicate news categories are rejected', () => {
  const report = sample(schema);
  delete report.dashboard.governance;
  assert.throws(() => validateReport(report, schema), /governance/);
  const blank = sample(schema);
  blank.coreSummary.identity = ' ';
  assert.throws(() => validateReport(blank, schema), /identity/);
  const duplicate = sample(schema);
  duplicate.dashboard.newsTags[1].category = duplicate.dashboard.newsTags[0].category;
  assert.throws(() => validateReport(duplicate, schema), /duplicate/);
});

test('value-chain lists retain more than three items without retrying or truncation', async () => {
  const report = sample(schema);
  for (const key of ['upstream', 'offerings', 'customers', 'revenue']) {
    report.valueChain[key] = Array.from({ length: 9 }, (_, i) => `${key} ${i}`);
  }
  let calls = 0;
  const generated = await generateValidatedReport({
    basePrompt, models: ['model'], isRetryable: () => false,
    generate: async () => { calls++; return { text: JSON.stringify(report) }; }
  });
  assert.equal(calls, 1);
  const legacy = frontendReader()({ text: generated.text });
  for (const key of ['upstream', 'offerings', 'customers', 'revenue']) {
    assert.equal(generated.report.valueChain[key].length, 9);
    assert.equal(legacy.valueChain[key].length, 9);
  }
});

test('empty value-chain lists, wrong types and blank entries remain invalid', () => {
  const report = sample(schema);
  report.valueChain.upstream = [];
  assert.throws(() => validateReport(report, schema), /upstream: expected at least 1 items, received 0/);
  report.valueChain.upstream = 'not an array';
  assert.throws(() => validateReport(report, schema), /received string/);
  report.valueChain.upstream = ['valid', ' '];
  assert.throws(() => validateReport(report, schema), /non-empty text/);
});

test('a primary 504 can fall back to a complete report with five product examples', async () => {
  const report = sample(schema);
  report.productPortfolio.items[0].examples = ['product 1', 'product 2', 'product 3', 'product 4', 'product 5'];
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['gemini-3.8-flash', 'gemini-3.6-flash'],
    isRetryable: error => error.status === 504, sleep: async () => {},
    generate: async request => {
      seen.push(request.model);
      if (request.model === 'gemini-3.8-flash') throw Object.assign(new Error('DEADLINE_EXCEEDED'), { status: 504 });
      return { text: JSON.stringify(report) };
    }
  });
  assert.equal(seen.join(','), 'gemini-3.8-flash,gemini-3.8-flash,gemini-3.8-flash,gemini-3.6-flash');
  assert.equal(result.report.productPortfolio.items[0].examples.length, 5);
  assert.equal(frontendReader()({ text: result.text }).productPortfolio.items[0].examples.length, 5);
  assert.equal(frontendReader()({ report: result.report }).productPortfolio.items[0].examples.length, 5);
});

test('product examples still reject empty lists, wrong types and blank entries', () => {
  const report = sample(schema);
  report.productPortfolio.items[0].examples = [];
  assert.throws(() => validateReport(report, schema), /examples: expected at least 1 items, received 0/);
  report.productPortfolio.items[0].examples = 'not a list';
  assert.throws(() => validateReport(report, schema), /received string/);
  report.productPortfolio.items[0].examples = [' '];
  assert.throws(() => validateReport(report, schema), /non-empty text/);
});

test('truncated output retries on fallback and retains legacy markers', async () => {
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => true,
    generate: async request => {
      seen.push(request);
      return seen.length === 1
        ? { text: '{', candidates: [{ finishReason: 'MAX_TOKENS' }] }
        : { text: JSON.stringify(sample(schema)), candidates: [{ finishReason: 'STOP' }] };
    }
  });
  assert.equal(seen.length, 2);
  assert.equal(result.modelName, 'fallback');
  assert.equal(seen[0].config.responseMimeType, 'application/json');
  assert.equal(result.text.includes('<!-- RESEARCH_DASHBOARD_END -->'), true);
});

test('invalid complete JSON is retried instead of returning a partial report', async () => {
  let calls = 0;
  await assert.rejects(generateValidatedReport({
    basePrompt, models: ['model'], isRetryable: () => true,
    generate: async () => { calls++; return { text: '{}' }; }
  }), { statusCode: 503 });
  assert.equal(calls, 2);
});

test('non-retryable configuration errors are not multiplied', async () => {
  let calls = 0;
  await assert.rejects(generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => false,
    generate: async () => { calls++; throw Object.assign(new Error('invalid key'), { status: 401 }); }
  }), { status: 401 });
  assert.equal(calls, 1);
});

function timing() {
  let clock = 0;
  const delays = [];
  return { now: () => clock, random: () => 0, delays,
    advance: ms => { clock += ms; }, sleep: async ms => { clock += ms; delays.push(ms); } };
}

test('503 retries the same model with bounded exponential backoff before fallback', async () => {
  const clock = timing();
  const seen = [];
  const events = [];
  await assert.rejects(generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => true,
    ...clock, log: event => events.push(event),
    generate: async request => {
      seen.push(request.model);
      clock.advance(10);
      throw Object.assign(new Error('busy'), { status: 503 });
    }
  }), { code: 'REPORT_AI_UNAVAILABLE', errorSource: 'gemini_api', upstreamStatus: 503 });
  assert.deepEqual(seen, ['primary', 'primary', 'primary', 'fallback']);
  assert.deepEqual(clock.delays, [1000, 2000]);
  const attempts = events.filter(event => event.event === 'company_report_attempt');
  assert.equal(attempts.length, 4);
  assert.equal(attempts.every(event => event.status === 503 && event.durationMs === 10), true);
});

test('slow 504 retries cannot consume the reserved fallback time or exceed 130 seconds', async () => {
  const clock = timing();
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => true, ...clock,
    generate: async request => {
      seen.push({ model: request.model, timeout: request.config.httpOptions.timeout });
      assert.equal(request.config.httpOptions.retryOptions.attempts, 1);
      if (request.model === 'fallback') return { text: JSON.stringify(sample(schema)) };
      clock.advance(request.config.httpOptions.timeout);
      throw Object.assign(new Error('deadline exceeded'), { status: 504 });
    }
  });
  assert.equal(result.modelName, 'fallback');
  assert.deepEqual(seen, [
    { model: 'primary', timeout: 65000 }, { model: 'primary', timeout: 24000 },
    { model: 'fallback', timeout: 40000 }
  ]);
  assert.equal(clock.now() <= 130000, true);
});

test('JSON and schema failures keep HTTP 200 and do not trigger API backoff', async () => {
  for (const [text, source] of [['{', 'json_parse'], ['{}', 'report_validation']]) {
    const clock = timing();
    const events = [];
    await assert.rejects(generateValidatedReport({
      basePrompt, models: ['primary', 'fallback'], isRetryable: () => true,
      ...clock, log: event => events.push(event), generate: async () => ({ text })
    }), { code: 'REPORT_INVALID_OUTPUT', errorSource: source });
    assert.deepEqual(clock.delays, []);
    assert.equal(events.every(event => event.status === 200 && event.errorSource === source), true);
  }
});

test('long Retry-After skips a retry that cannot fit the total budget', async () => {
  const clock = timing();
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => true, ...clock,
    generate: async request => {
      seen.push(request.model);
      if (request.model === 'primary') throw Object.assign(new Error('busy'), { status: 503, retryAfterMs: 180000 });
      return { text: JSON.stringify(sample(schema)) };
    }
  });
  assert.equal(result.modelName, 'fallback');
  assert.deepEqual(seen, ['primary', 'fallback']);
  assert.deepEqual(clock.delays, []);
});

test('Gemini 3.8 reports use compatible parameters and fall back to 3.6', async () => {
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['gemini-3.8-flash', 'gemini-3.6-flash'], isRetryable: () => true, sleep: async () => {},
    generate: async request => {
      seen.push(request);
      if (request.model === 'gemini-3.8-flash') throw Object.assign(new Error('temporarily unavailable'), { status: 503 });
      return { text: JSON.stringify(sample(schema)) };
    }
  });
  assert.equal(seen[0].model, 'gemini-3.8-flash');
  assert.equal(result.modelName, 'gemini-3.6-flash');
  for (const request of seen) {
    assert.equal(request.config.temperature, 1);
    assert.equal(request.config.thinkingConfig.thinkingLevel, 'low');
    assert.equal(request.config.thinkingConfig.thinkingBudget, undefined);
    assert.equal(request.config.httpOptions.apiVersion, 'v1beta');
    assert.equal(request.config.maxOutputTokens, 32768);
  }
  assert.equal(result.report.dashboard.research.metrics.length, 6);
});

test('explicit Gemini 2.5 overrides retain their existing generation settings', async () => {
  let request;
  await generateValidatedReport({
    basePrompt, models: ['gemini-2.5-flash'], isRetryable: () => false,
    generate: async args => { request = args; return { text: JSON.stringify(sample(schema)) }; }
  });
  assert.equal(request.config.temperature, 0.3);
  assert.equal(request.config.thinkingConfig.thinkingBudget, 1024);
  assert.equal(request.config.thinkingConfig.thinkingLevel, undefined);
});

test('server defaults to Gemini 3.8 and 3.6 while preserving deployment overrides', () => {
  const start = server.indexOf('const GEMINI_PRIMARY_MODEL =');
  const end = server.indexOf('console.log(`[AI 模型設定]', start);
  const settings = new Function('process', server.slice(start, end) + '\nreturn [GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL];');
  assert.equal(settings({ env: {} }).join(','), 'gemini-3.8-flash,gemini-3.6-flash');
  assert.equal(settings({ env: { GEMINI_MODEL: ' gemini-2.5-flash ', GEMINI_FALLBACK_MODEL: 'custom' } }).join(','), 'gemini-2.5-flash,custom');
  assert.equal(settings({ env: { GEMINI_MODEL: ' ', GEMINI_FALLBACK_MODEL: '' } }).join(','), 'gemini-3.8-flash,gemini-3.6-flash');
});

test('provider schema is simpler while local completeness checks remain strict', () => {
  const remote = providerSchema(schema);
  assert.equal(remote.properties.timeline.properties.items.minItems, undefined);
  assert.equal(schema.properties.timeline.properties.items.minItems, 4);
  assert.equal(remote.required.length, 5);
  const report = sample(schema);
  report.timeline.items.pop();
  assert.throws(() => validateReport(report, schema), /timeline.items/);
});

test('400 retries once without provider schema and accepts complete fenced JSON', async () => {
  const seen = [];
  const result = await generateValidatedReport({
    basePrompt, models: ['gemini-2.5-flash'], isRetryable: () => false,
    generate: async request => {
      seen.push(request);
      if (seen.length === 1) throw Object.assign(new Error('schema rejected'), { status: 400 });
      return { text: '```json\n' + JSON.stringify(sample(schema)) + '\n```' };
    }
  });
  assert.equal(seen.length, 2);
  assert.equal(!!seen[0].config.responseJsonSchema, true);
  assert.equal(seen[1].config.responseJsonSchema, undefined);
  assert.equal(seen[1].contents.includes('"productPortfolio"'), true);
  assert.equal(result.report.dashboard.research.metrics.length, 6);
});

test('JSON fallback still rejects partial reports and has bounded attempts', async () => {
  let calls = 0;
  await assert.rejects(generateValidatedReport({
    basePrompt, models: ['model'], isRetryable: () => false,
    generate: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('schema rejected'), { status: 400 });
      return { text: '{}' };
    }
  }), { statusCode: 503 });
  assert.equal(calls, 3);
});

test('persistent 400 stops after compatibility retry', async () => {
  let calls = 0;
  await assert.rejects(generateValidatedReport({
    basePrompt, models: ['primary', 'fallback'], isRetryable: () => false,
    generate: async () => { calls++; throw Object.assign(new Error('bad request'), { status: 400 }); }
  }), { status: 400 });
  assert.equal(calls, 2);
});

test('provider errors are classified and secret values are redacted from diagnostics', () => {
  assert.equal(reportErrorResponse({ status: 400 }).code, 'REPORT_REQUEST_REJECTED');
  assert.equal(reportErrorResponse({ status: 429 }).code, 'REPORT_AI_LIMIT');
  assert.equal(reportErrorResponse({ status: 403 }).code, 'REPORT_AI_CONFIG');
  assert.equal(reportErrorResponse({ statusCode: 503, message: 'incomplete' }).message, 'incomplete');
  const message = safeErrorMessage(new Error('AIzaSECRET https://example.com?key=secret Bearer token {"apiKey":"private"}'));
  for (const secret of ['AIzaSECRET', '=secret', 'Bearer token', '"private"']) assert.equal(message.includes(secret), false);
  assert.equal(safeErrorMessage(new Error('x'.repeat(2000))).length, 1200);
});

const fulfilled = rows => ({ status: 'fulfilled', value: { data: { organic_results: rows } } });
const row = id => ({ title: id, snippet: `${id} facts`, link: `https://example.com/${id}` });

test('search interleaves topics, deduplicates sources and exposes partial coverage', () => {
  const response = collectSearchResults([
    fulfilled([row('a'), row('b'), row('c'), row('d')]),
    fulfilled([row('a'), row('e'), row('f'), row('g')]),
    { status: 'rejected', reason: new Error('503') }
  ], ['business', 'competition', 'filings'], 5);
  assert.equal(response.results.length, 5);
  assert.equal(response.results[2].query, 'competition');
  assert.equal(new Set(response.results.map(item => item.link)).size, 5);
  assert.equal(response.limited, true);
  assert.throws(() => collectSearchResults([fulfilled([row('a')])], ['query'], 12), { statusCode: 503 });
});

test('complete reports are cached and expired reports regenerate', async () => {
  let clock = 0;
  let calls = 0;
  const get = createReportCache({ now: () => clock, ttlMs: 10 });
  const produce = async () => ({ sourceInfo: { limited: false }, version: ++calls });
  assert.equal((await get('AAPL', produce)).cached, false);
  assert.equal((await get('AAPL', produce)).cached, true);
  assert.equal(calls, 1);
  clock = 11;
  assert.equal((await get('AAPL', produce)).version, 2);
});

test('default cache lifetime is three days and reads never extend it', async () => {
  let clock = 0;
  let calls = 0;
  let savedExpiry;
  const get = createReportCache({ now: () => clock, store: {
    read: async () => null,
    write: async (key, value, expires) => { savedExpiry = expires; }
  } });
  const produce = async () => ({ sourceInfo: { limited: false }, version: ++calls });
  await get('AAPL', produce);
  assert.equal(savedExpiry, 3 * 24 * 3600000);
  clock = 2 * 24 * 3600000;
  assert.equal((await get('AAPL', produce)).cached, true);
  clock = 3 * 24 * 3600000 - 1;
  assert.equal((await get('AAPL', produce)).cached, true);
  assert.equal(calls, 1);
  clock = 3 * 24 * 3600000;
  assert.equal((await get('AAPL', produce)).version, 2);
});

test('concurrent requests coalesce; failures and limited reports are not cached', async () => {
  const get = createReportCache();
  let release;
  let calls = 0;
  const produce = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = get('AAPL', produce);
  const second = get('AAPL', produce);
  await Promise.resolve();
  release({ sourceInfo: { limited: false } });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  let partialCalls = 0;
  const partial = async () => { partialCalls++; return { sourceInfo: { limited: true } }; };
  await get('partial', partial);
  await get('partial', partial);
  assert.equal(partialCalls, 2);
  await assert.rejects(get('failed', async () => { throw new Error('503'); }), /503/);
  assert.equal((await get('failed', async () => ({ sourceInfo: { limited: false } }))).cached, false);
});

test('persistent reports survive process-cache recreation without extending their TTL', async () => {
  const rows = new Map();
  let clock = 0;
  let calls = 0;
  const store = {
    read: async key => rows.get(key),
    write: async (key, value, expires) => rows.set(key, { value, expires })
  };
  const options = { store, now: () => clock, ttlMs: 100 };
  const produce = async () => ({ report: sample(schema), sourceInfo: { limited: false }, version: ++calls });
  const validate = value => validateReport(value.report, schema);
  assert.equal((await createReportCache(options)('AAPL', produce, validate)).cacheTier, 'generated');
  clock = 90;
  const restarted = createReportCache(options);
  assert.equal((await restarted('AAPL', produce, validate)).cacheTier, 'database');
  assert.equal(calls, 1);
  clock = 101;
  assert.equal((await restarted('AAPL', produce, validate)).version, 2);
  assert.equal(calls, 2);
});

test('persistent cache failures and malformed records do not hide a newly generated report', async () => {
  for (const read of [async () => { throw new Error('database offline'); }, async () => ({ expires: 100, value: { report: {} } })]) {
    let calls = 0;
    const get = createReportCache({ now: () => 0, store: { read, write: async () => { throw new Error('write failed'); } } });
    const produce = async () => { calls++; return { report: sample(schema), sourceInfo: { limited: false } }; };
    const validate = value => validateReport(value.report, schema);
    assert.equal((await get('AAPL', produce, validate)).cached, false);
    assert.equal((await get('AAPL', produce, validate)).cacheTier, 'memory');
    assert.equal(calls, 1);
  }
});

test('incomplete or failed generation is never written to persistent storage', async () => {
  let writes = 0;
  const get = createReportCache({ store: { read: async () => null, write: async () => { writes++; } } });
  await get('limited', async () => ({ report: sample(schema), sourceInfo: { limited: true } }));
  await assert.rejects(get('failed', async () => { throw new Error('API failed'); }));
  await assert.rejects(get('invalid', async () => ({ report: {}, sourceInfo: { limited: false } }), value => validateReport(value.report, schema)));
  assert.equal(writes, 0);
});

function frontendReader() {
  const html = readFileSync(`${__dirname}/../client/stock_integration.html`, 'utf8');
  const extractors = html.slice(html.indexOf('  function normalizeValueChainItems'), html.indexOf('  function safeText'));
  const legacyHelpers = html.slice(html.indexOf('  function findJsonObjectEnd'), html.indexOf('  function renderValueChainList'));
  const reader = html.slice(html.indexOf('  function readCompanySections'), html.indexOf('  document.getElementById("symbolInput").addEventListener'));
  return new Function(extractors + legacyHelpers + reader + '\nreturn readCompanySections;')();
}

test('frontend renders structured reports and compatible legacy markers', async () => {
  const read = frontendReader();
  const report = sample(schema);
  assert.equal(read({ report }).dashboard, report.dashboard);
  const generated = await generateValidatedReport({
    basePrompt, models: ['model'], isRetryable: () => true,
    generate: async () => ({ text: JSON.stringify(report) })
  });
  const parsed = read({ text: generated.text });
  assert.equal(parsed.coreSummary.company, 'AAPL');
  assert.equal(Object.keys(parsed.dashboard).length, 11);
});

test('frontend rejects missing sections instead of hiding them silently', () => {
  const read = frontendReader();
  assert.throws(() => read({ report: { coreSummary: {} } }), /不完整/);
  assert.throws(() => read({ text: 'partial report' }), /未完整/);
});
