const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { getBasePrompt, normalizeSymbol, detectMarket, buildSearchQueries } = require('./company-prompt');
const { buildContract, providerSchema, validateReport, collectSearchResults } = require('./company-report');
const { createGeminiCaller, installedSdkVersion, httpStatus, errorSource, safeErrorMessage } = require('./gemini-runtime');

async function runReportComparison({ basePrompt, model, generate, log = () => {}, timeoutMs = 65000, now = () => performance.now() }) {
  const { schema, prompt } = buildContract(basePrompt);
  const results = [];
  for (const useSchema of [true, false]) {
    const started = now();
    const row = { event: 'gemini_report_diagnostic', model, probe: useSchema ? 'with_schema' : 'without_schema',
      timeoutMs, promptChars: prompt.length, maxOutputTokens: 32768 };
    let received = false;
    let stage = 'api';
    try {
      const result = await generate({ model, contents: prompt, config: {
        responseMimeType: 'application/json',
        ...(useSchema ? { responseJsonSchema: providerSchema(schema) } : {}),
        temperature: model.startsWith('gemini-3.') ? 1 : 0.3, maxOutputTokens: 32768,
        ...(model.startsWith('gemini-3.') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
        ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
        httpOptions: { apiVersion: 'v1beta', timeout: timeoutMs, retryOptions: { attempts: 1 } },
        abortSignal: AbortSignal.timeout(timeoutMs)
      } }, { label: 'Report schema comparison', probe: row.probe, attempt: results.length + 1 });
      received = true;
      stage = 'generation_finish';
      row.finishReason = result.candidates?.[0]?.finishReason || null;
      if (row.finishReason && row.finishReason !== 'STOP') throw new Error(`Incomplete generation: ${row.finishReason}`);
      stage = 'json_parse';
      const report = JSON.parse(String(result.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
      stage = 'report_validation';
      validateReport(report, schema);
      Object.assign(row, { outcome: 'success', httpStatus: 200, errorSource: null });
    } catch (error) {
      Object.assign(row, { outcome: 'failed', httpStatus: received ? 200 : httpStatus(error),
        errorSource: received ? stage : errorSource(error), message: safeErrorMessage(error) });
    }
    row.durationMs = Math.round(now() - started);
    results.push(row);
    log(row);
  }
  return results;
}

async function main() {
  require('dotenv').config();
  const symbol = normalizeSymbol(process.argv[2] || 'AAPL');
  if (!/^[A-Z0-9][A-Z0-9.^-]{0,19}$/.test(symbol) || process.argv.length > 3) {
    console.error('Usage: npm run diagnose:report -- AAPL');
    process.exitCode = 2;
    return;
  }
  if (!process.env.GEMINI_API_KEY?.trim() || !process.env.SERPAPI_KEY?.trim()) {
    console.error('GEMINI_API_KEY and SERPAPI_KEY must be configured in your backend environment. Do not paste keys into chat.');
    process.exitCode = 2;
    return;
  }
  const { GoogleGenAI } = require('@google/genai');
  const axios = require('axios');
  const market = detectMarket(symbol);
  const queries = buildSearchQueries(symbol, market);
  const responses = await Promise.allSettled(queries.map(q => axios.get('https://serpapi.com/search.json', {
    params: { engine: 'google', q, api_key: process.env.SERPAPI_KEY, num: 4, hl: 'zh-tw', gl: 'tw' }, timeout: 20000
  })));
  const sources = collectSearchResults(responses, queries, 12);
  const context = sources.results.map((item, index) =>
    `[資料 ${index + 1}] 搜尋主題「${item.query}」｜${item.title}: ${item.snippet}\n網址：${item.link || '未提供'}`
  ).join('\n\n');
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash';
  const requestId = randomUUID();
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta', httpOptions: { retryOptions: { attempts: 1 } } });
  const call = createGeminiCaller({ client, log: row => console.log(JSON.stringify(row)) });
  console.log(JSON.stringify({ event: 'gemini_report_diagnostic_start', requestId, sdkVersion: installedSdkVersion(),
    model, symbol, maxCalls: 2, sdkAttempts: 1, sourceCount: sources.results.length, sourceLimited: sources.limited }));
  const results = await runReportComparison({ basePrompt: getBasePrompt(symbol, context, market), model,
    generate: (args, details) => call(args, { requestId, ...details }),
    log: row => console.log(JSON.stringify({ requestId, ...row })) });
  if (results.some(row => row.outcome !== 'success')) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ event: 'gemini_report_diagnostic_setup_failed', message: safeErrorMessage(error) }));
  process.exitCode = 1;
});

module.exports = { runReportComparison };
