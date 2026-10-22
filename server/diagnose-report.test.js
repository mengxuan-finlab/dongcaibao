const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { runReportComparison } = require('./diagnose-report');
const { getBasePrompt, detectMarket, buildSearchQueries } = require('./company-prompt');
const { buildContract, generateValidatedReport } = require('./company-report');

const basePrompt = getBasePrompt('AAPL', 'Fixed search snapshot', 'US');
const { schema } = buildContract(basePrompt);
function sample(node, index = 0) {
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, sample(child, index)]));
  if (node.type === 'array') return Array.from({ length: node.minItems }, (_, i) => sample(node.items, i));
  return node.enum ? node.enum[index % node.enum.length] : `analysis ${index}`;
}

test('report comparison changes only provider schema, preserving production prompt and generation settings', async () => {
  const requests = [];
  const generate = async request => { requests.push(request); return { text: JSON.stringify(sample(schema)) }; };
  const results = await runReportComparison({ basePrompt, model: 'gemini-3.6-flash', generate });
  assert.equal(results.length, 2);
  assert.equal(results.every(row => row.outcome === 'success'), true);
  assert.equal(requests[0].contents, requests[1].contents);
  assert.equal(!!requests[0].config.responseJsonSchema, true);
  assert.equal(requests[1].config.responseJsonSchema, undefined);
  let production;
  await generateValidatedReport({ basePrompt, models: ['gemini-3.6-flash'], isRetryable: () => false,
    generate: async request => { production = request; return { text: JSON.stringify(sample(schema)) }; } });
  const stable = ({ config, ...request }) => {
    const { responseJsonSchema, abortSignal, ...settings } = config;
    return { ...request, config: settings };
  };
  assert.deepEqual(stable(requests[0]), stable(requests[1]));
  assert.deepEqual(stable(requests[0]), stable(production));
  assert.deepEqual(requests[0].config.responseJsonSchema, production.config.responseJsonSchema);
});

test('503 schema failure does not retry or skip the JSON-only comparison', async () => {
  let calls = 0;
  const results = await runReportComparison({ basePrompt, model: 'gemini-3.6-flash', generate: async request => {
    calls++;
    if (request.config.responseJsonSchema) throw Object.assign(new Error('high demand'), { status: 503 });
    return { text: JSON.stringify(sample(schema)) };
  } });
  assert.equal(calls, 2);
  assert.equal(results[0].httpStatus, 503);
  assert.equal(results[0].errorSource, 'gemini_api');
  assert.equal(results[1].outcome, 'success');
});

test('HTTP success is distinguished from parsing and completeness failures without logging generated content', async () => {
  const results = await runReportComparison({ basePrompt, model: 'model', generate: async request => ({
    text: request.config.responseJsonSchema ? '{' : '{}'
  }) });
  assert.equal(results[0].errorSource, 'json_parse');
  assert.equal(results[1].errorSource, 'report_validation');
  assert.equal(results.every(row => row.httpStatus === 200), true);
  assert.equal(JSON.stringify(results).includes('Fixed search snapshot'), false);
});

test('CLI refuses invalid symbols and absent credentials before searching or generating', () => {
  for (const [args, message] of [[['bad/symbol'], 'Usage:'], [['AAPL'], 'GEMINI_API_KEY and SERPAPI_KEY']]) {
    assert.throws(() => execFileSync(process.execPath, [`${__dirname}/diagnose-report.js`, ...args], {
      env: { ...process.env, GEMINI_API_KEY: '', SERPAPI_KEY: '' }, encoding: 'utf8', stdio: 'pipe'
    }), error => error.status === 2 && error.stderr.includes(message));
  }
});

test('shared prompt helpers preserve US and TW query selection', () => {
  assert.equal(detectMarket('2330.TW'), 'TW');
  assert.equal(detectMarket('AAPL'), 'US');
  assert.equal(buildSearchQueries('aapl', 'US').length, 3);
  assert.equal(buildSearchQueries('2330.TW', 'TW').every(query => query.includes('2330.TW')), true);
});
