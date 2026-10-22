const { performance } = require('node:perf_hooks');
const { httpStatus, errorSource, safeErrorMessage, installedSdkVersion, createGeminiCaller } = require('./gemini-runtime');

const PROBES = [
  { name: 'plain_text', prompt: 'Reply with exactly OK. No explanation.', config: {} },
  { name: 'small_json', prompt: 'Return a JSON object with status equal to OK. No explanation.', config: {
    responseMimeType: 'application/json',
    responseJsonSchema: {
      type: 'object', properties: { status: { type: 'string', enum: ['OK'] } }, required: ['status']
    }
  } }
];

async function runDiagnostics({ models, generate, log = () => {}, now = () => performance.now(), timeoutMs = 65000 }) {
  const results = [];
  for (const model of [...new Set(models.filter(Boolean))].slice(0, 2)) {
    for (const probe of PROBES) {
      const started = now();
      let received = false;
      let stage = 'api';
      const row = { event: 'gemini_diagnostic', model, probe: probe.name, timeoutMs };
      try {
        const result = await generate({ model, contents: probe.prompt, config: {
          ...probe.config, temperature: model.startsWith('gemini-3.') ? 1 : 0.3,
          maxOutputTokens: 1024,
          ...(model.startsWith('gemini-3.') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
          ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
          httpOptions: { apiVersion: 'v1beta', timeout: timeoutMs, retryOptions: { attempts: 1 } },
          abortSignal: AbortSignal.timeout(timeoutMs)
        } }, { label: 'Gemini diagnostic', probe: probe.name, attempt: results.length + 1 });
        received = true;
        stage = 'probe_output';
        row.finishReason = result.candidates?.[0]?.finishReason || null;
        if (row.finishReason && row.finishReason !== 'STOP') throw new Error(`Incomplete probe: ${row.finishReason}`);
        const text = String(result.text || '').trim();
        if (probe.name === 'plain_text') {
          if (text !== 'OK') throw new Error('Expected exactly OK');
        } else {
          stage = 'json_parse';
          const parsed = JSON.parse(text);
          stage = 'probe_output';
          if (!parsed || parsed.status !== 'OK') throw new Error('Expected JSON status OK');
        }
        Object.assign(row, { outcome: 'success', httpStatus: 200, errorSource: null });
      } catch (error) {
        Object.assign(row, { outcome: 'failed', httpStatus: received ? 200 : httpStatus(error),
          errorSource: received ? stage : errorSource(error), message: safeErrorMessage(error) });
      }
      row.durationMs = Math.round(now() - started);
      results.push(row);
      log(row);
    }
  }
  return results;
}

async function main() {
  require('dotenv').config();
  if (!process.env.GEMINI_API_KEY?.trim()) {
    console.error('GEMINI_API_KEY is not configured. Run this command in your backend environment. Do not paste keys into chat.');
    process.exitCode = 2;
    return;
  }
  const { GoogleGenAI } = require('@google/genai');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1beta', httpOptions: { retryOptions: { attempts: 1 } } });
  const call = createGeminiCaller({ client, log: row => console.log(JSON.stringify(row)) });
  const models = [process.env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash', process.env.GEMINI_FALLBACK_MODEL?.trim() || 'gemini-3.6-flash'];
  console.log(JSON.stringify({ event: 'gemini_diagnostic_start', sdkVersion: installedSdkVersion(), models,
    maxCalls: new Set(models).size * 2, sdkAttempts: 1, timeoutMs: 65000 }));
  const results = await runDiagnostics({ models, generate: call, log: row => console.log(JSON.stringify(row)) });
  if (results.some(row => row.outcome !== 'success')) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});

module.exports = { runDiagnostics };
