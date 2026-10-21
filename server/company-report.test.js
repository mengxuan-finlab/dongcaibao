const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { buildContract, validateReport, generateValidatedReport, collectSearchResults, createReportCache } = require('./company-report');

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
