const { performance } = require('node:perf_hooks');
const { httpStatus, errorSource, safeErrorMessage, retryDelayMs } = require('./gemini-runtime');

const SECTIONS = [
  ['valueChain', 'VALUE_CHAIN'], ['timeline', 'TIMELINE'],
  ['coreSummary', 'CORE_SUMMARY'], ['productPortfolio', 'PRODUCT_PORTFOLIO'],
  ['dashboard', 'RESEARCH_DASHBOARD']
];

const ARRAY_LIMITS = {
  'timeline.items': [4, 6], 'coreSummary.focus': [3, 4],
  'productPortfolio.items': [3, 6],
  'dashboard.operatingModel.steps': [3, 5],
  'dashboard.operatingModel.strategies': [1, 6],
  'dashboard.advantages': [3, 5], 'dashboard.risks': [3, 5],
  'dashboard.industry.winds': [4, 6], 'dashboard.financials': [5, 5],
  'dashboard.research.questions': [3, 5], 'dashboard.research.metrics': [6, 10],
  'dashboard.newsTags': [5, 5], 'dashboard.newsTags.items': [2, 4]
};

function schemaFor(value, path = '', compact = false) {
  if (Array.isArray(value)) {
    const limits = compact ? [1, undefined] : ARRAY_LIMITS[path] || [1, path.startsWith('valueChain.') || path.endsWith('.examples') ? undefined : 8];
    const items = schemaFor(value[0], path, compact);
    if (path === 'dashboard.newsTags') items.properties.category.enum = value.map(item => item.category);
    if (path === 'dashboard.financials') items.properties.area.description = '財務或營運觀察面向，五項不可重複';
    return { type: 'array', minItems: limits[0], ...(limits[1] === undefined ? {} : { maxItems: limits[1] }), items };
  }
  if (value && typeof value === 'object') {
    return {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, schemaFor(item, path ? `${path}.${key}` : key, compact)])),
      required: Object.keys(value)
    };
  }
  return { type: 'string', description: String(value),
    ...(['valueChain.company', 'coreSummary.company', 'company.symbol'].includes(path) ? { enum: [value] } : {}) };
}

function buildContract(basePrompt) {
  const compactStart = '<!-- COMPACT_REPORT_START -->';
  const compactEnd = '<!-- COMPACT_REPORT_END -->';
  if (basePrompt.includes(compactStart)) {
    const start = basePrompt.indexOf(compactStart);
    const end = basePrompt.indexOf(compactEnd, start);
    if (end < 0) throw new Error('Missing prompt template: COMPACT_REPORT');
    const template = JSON.parse(basePrompt.slice(start + compactStart.length, end).trim());
    return {
      schema: schemaFor(template, '', true), reportFormat: template.segmentInsights ? 'compact-v5' : template.company?.process ? 'compact-v4'
        : template.history ? (template.products ? 'compact-v2' : 'compact-v3') : 'compact-v1', maxOutputTokens: 8192,
      prompt: basePrompt.slice(0, start) + '輸出單一完整 JSON 物件，不要 HTML 標記、Markdown 或程式碼圍欄。欄位格式：\n' + JSON.stringify(template)
    };
  }
  const template = {};
  for (const [key, marker] of SECTIONS) {
    const start = `<!-- ${marker}_START -->`;
    const end = `<!-- ${marker}_END -->`;
    const startIndex = basePrompt.indexOf(start);
    const endIndex = basePrompt.indexOf(end, startIndex + start.length);
    if (startIndex < 0 || endIndex < 0) throw new Error(`Missing prompt template: ${marker}`);
    template[key] = JSON.parse(basePrompt.slice(startIndex + start.length, endIndex).trim());
  }
  const requirements = basePrompt.slice(basePrompt.indexOf('【欄位要求】'), basePrompt.indexOf('<!-- RESEARCH_DASHBOARD_START -->'));
  const prompt = basePrompt.slice(0, basePrompt.indexOf('【輸出結構')) + `
【輸出要求】
輸出單一完整 JSON 物件，包含 valueChain、timeline、coreSummary、productPortfolio、dashboard。
必須符合指定 schema；不要輸出 HTML 標記、Markdown 或程式碼圍欄。
所有欄位都需完整填寫；每個分析保留具體原因、影響及追蹤方式，不得以標題或短詞代替解釋。
原始資料不足時明確寫「未披露」或「目前資料不足以判斷」，不要編造公司、事件、年份或數據。
timeline 整理 4-6 個發展節點，productPortfolio 整理 3-6 個主要領域；核心摘要說明公司定位、痛點、收入、特色、成長與壓力。
valueChain 的 upstream、offerings、customers、revenue 都必須是非空陣列，依資料列出相關項目，不必為了三項上限刪除內容；未披露時以文字明確註明。
productPortfolio.items 的 examples 也必須是非空陣列，依資料列出相關產品或服務，不設三項上限；未披露時以文字明確註明。
${requirements}`;
  const schema = schemaFor(template);
  const shape = JSON.stringify(template);
  const counts = Object.entries(ARRAY_LIMITS).map(([path, [min, max]]) => `${path}: ${min}-${max} 項`).join('\n');
  return { schema, reportFormat: 'full-v1', maxOutputTokens: 32768,
    prompt: `${prompt}\n【完整欄位格式範例，請以真實分析替換示意文字】\n${shape}\n【陣列項目數量】\n${counts}` };
}

// Keep strict count checks locally; nested array bounds can exceed Gemini's decoder complexity limit.
function providerSchema(schema) {
  if (schema.type === 'object') return {
    type: 'object', required: schema.required,
    properties: Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, providerSchema(child)]))
  };
  if (schema.type === 'array') return { type: 'array', items: providerSchema(schema.items) };
  return { type: 'string', ...(schema.enum ? { enum: schema.enum } : {}) };
}

function reportErrorResponse(error) {
  const upstream = Number(error.status || error.response?.status);
  if (error.statusCode) return { status: error.statusCode, code: error.code || 'REPORT_UNAVAILABLE', message: error.message };
  if (upstream === 400) return { status: 502, code: 'REPORT_REQUEST_REJECTED', message: 'AI 服務拒絕了報告請求，請將查詢編號提供給管理者。' };
  if ([401, 403, 404].includes(upstream)) return { status: 503, code: 'REPORT_AI_CONFIG', message: 'AI 服務的金鑰、權限或模型設定需要檢查，請聯絡管理者。' };
  if (upstream === 429) return { status: 503, code: 'REPORT_AI_LIMIT', message: 'AI 服務暫時達到使用限制，請稍後再試。' };
  return { status: 500, code: 'REPORT_INTERNAL', message: '報告服務暫時無法完成，請將查詢編號提供給管理者。' };
}

function validateReport(value, schema, path = 'report') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: object required`);
    for (const key of schema.required) validateReport(value[key], schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || (schema.maxItems !== undefined && value.length > schema.maxItems)) {
      const expected = schema.maxItems === undefined ? `at least ${schema.minItems}` : `${schema.minItems}-${schema.maxItems}`;
      throw new Error(`${path}: expected ${expected} items, received ${Array.isArray(value) ? value.length : typeof value}`);
    }
    value.forEach((item, index) => validateReport(item, schema.items, `${path}[${index}]`));
    const uniqueKey = path === 'report.dashboard.newsTags' ? 'category'
      : path === 'report.dashboard.financials' ? 'area' : null;
    if (uniqueKey && new Set(value.map(item => item[uniqueKey])).size !== value.length) {
      throw new Error(`${path}: duplicate ${uniqueKey}`);
    }
  } else if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path}: non-empty text required`);
  } else if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path}: unexpected category`);
  }
}

function serializeReport(report) {
  if (report.company) {
    return `<!-- COMPACT_REPORT_START -->\n${JSON.stringify(report)}\n<!-- COMPACT_REPORT_END -->`;
  }
  return SECTIONS.map(([key, marker]) => `<!-- ${marker}_START -->\n${JSON.stringify(report[key])}\n<!-- ${marker}_END -->`).join('\n\n');
}

function extractReportGrounding(result) {
  const candidate = result.candidates?.[0];
  const metadata = candidate?.groundingMetadata || candidate?.grounding_metadata || result.groundingMetadata || {};
  const sources = new Map();
  const add = (uri, title, retrieved) => {
    try {
      const url = new URL(uri);
      if (url.protocol !== 'https:' || url.username || url.password) return;
      const previous = sources.get(url.href);
      sources.set(url.href, { url: url.href, title: String(title || previous?.title || url.hostname),
        retrieved: retrieved || !!previous?.retrieved });
    } catch { /* Invalid source URLs must never become clickable citations. */ }
  };
  const chunks = metadata.groundingChunks || metadata.grounding_chunks;
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (chunk?.web) add(chunk.web.uri, chunk.web.title, false);
  }
  const urlMetadata = candidate?.urlContextMetadata || candidate?.url_context_metadata || result.urlContextMetadata || {};
  const urlItems = urlMetadata.urlMetadata || urlMetadata.url_metadata;
  const retrievals = Array.isArray(urlItems) ? urlItems : [];
  for (const item of retrievals) {
    if (item && (item.urlRetrievalStatus || item.url_retrieval_status) === 'URL_RETRIEVAL_STATUS_SUCCESS') {
      add(item.retrievedUrl || item.retrieved_url, null, true);
    }
  }
  const queries = metadata.webSearchQueries || metadata.web_search_queries;
  const entryPoint = metadata.searchEntryPoint?.renderedContent || metadata.search_entry_point?.rendered_content;
  return {
    sources: [...sources.values()],
    searchQueries: (Array.isArray(queries) ? queries : []).filter(query => typeof query === 'string' && query.trim()),
    searchEntryPointHtml: typeof entryPoint === 'string' ? entryPoint : '',
    telemetry: { urlAttemptCount: retrievals.length,
      urlSuccessCount: retrievals.filter(item => item && (item.urlRetrievalStatus || item.url_retrieval_status) === 'URL_RETRIEVAL_STATUS_SUCCESS').length }
  };
}

async function generateValidatedReport({
  basePrompt, models, generate, isRetryable, log = () => {}, timeoutMs = 65000,
  grounded = false, segmentData = null, peerData = null,
  totalTimeoutMs = timeoutMs * 2, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), random = Math.random
}) {
  const { schema, prompt, reportFormat, maxOutputTokens } = buildContract(basePrompt);
  const uniqueModels = [...new Set(models.filter(Boolean))].slice(0, 2);
  let lastError;
  let lastSource = 'sdk';
  let jsonOnly = false;
  const deadline = now() + totalTimeoutMs;
  let attemptCount = 0;
  for (const [modelIndex, model] of uniqueModels.entries()) {
    let apiRetries = 0;
    let validationRetries = 0;
    const reserveMs = modelIndex < uniqueModels.length - 1 ? Math.min(40000, timeoutMs) : 0;
    while (attemptCount < (reserveMs ? 3 : 4)) {
      const remainingMs = Math.floor(Math.min(timeoutMs, deadline - now() - reserveMs));
      if (remainingMs < 1) break;
      attemptCount++;
      const started = now();
      const mode = jsonOnly ? 'json' : 'schema';
      let received = false;
      let stage = 'api';
      try {
        const result = await generate({
          model, contents: prompt,
          config: {
            ...(grounded ? { tools: [{ googleSearch: {} }, { urlContext: {} }] } : {}),
            responseMimeType: 'application/json',
            ...(!jsonOnly ? { responseJsonSchema: providerSchema(schema) } : {}),
            temperature: model.startsWith('gemini-3.') ? 1 : 0.3,
            maxOutputTokens,
            ...(model.startsWith('gemini-3.') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
            ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
            httpOptions: { apiVersion: 'v1beta', timeout: remainingMs, retryOptions: { attempts: 1 } },
            abortSignal: AbortSignal.timeout(remainingMs)
          }
        });
        received = true;
        stage = 'generation_finish';
        const finishReason = result.candidates?.[0]?.finishReason;
        if (finishReason && finishReason !== 'STOP') throw new Error(`Incomplete generation: ${finishReason}`);
        stage = 'json_parse';
        const report = JSON.parse(String(result.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());
        stage = 'report_validation';
        validateReport(report, schema);
        // FMP owns Segments, even if a JSON-only retry adds AI-authored products.
        if (['compact-v3', 'compact-v4', 'compact-v5'].includes(reportFormat)) delete report.products;
        if (reportFormat === 'compact-v5') {
          for (const kind of ['product', 'geographic']) {
            if (segmentData?.[kind]?.status !== 'ok') report.segmentInsights[kind] = '未披露';
          }
        }
        if (Object.hasOwn(report.industry || {}, 'peerInsight')) {
          const insight = report.industry.peerInsight.split(/\r?\n/)
            .map(line => line.trim().replace(/^(?:[-*]\s+|[•●]\s*|\d+[.)、]\s+)/u, ''))
            .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
          const length = [...insight].length;
          if (peerData?.status !== 'ok' || !insight) {
            report.industry.peerInsight = '未披露';
            log({ event: 'peer_insight_omitted', model, length, dataStatus: peerData?.status || 'unavailable' });
          } else {
            report.industry.peerInsight = insight;
            if (length < 80 || length > 120) log({ event: 'peer_insight_length', model, length, outcome: 'kept' });
          }
        }
        let grounding, sourceValidation;
        if (grounded) {
          const { telemetry, ...links } = extractReportGrounding(result);
          grounding = links;
          sourceValidation = { status: links.sources.length ? 'sources_returned' : 'metadata_without_sources',
            sourceCount: links.sources.length, searchQueryCount: links.searchQueries.length,
            searchEvidence: links.searchQueries.length ? 'reported' : 'not_reported',
            urlEvidence: telemetry.urlAttemptCount ? 'reported' : 'not_reported',
            toolsEnabled: ['googleSearch', 'urlContext'], ...telemetry };
          let cautiousRiskCount = 0;
          if (!links.sources.length && Array.isArray(report.risks)) {
            const legalEvent = /訴訟|起訴|判決|罰款|裁罰|處罰|調查|違法|指控|和解|禁令|\b(lawsuit|litigation|penalty|penalties|fine|fined|sanction|settlement|investigation)\b/i;
            report.risks = report.risks.map(risk => {
              if (!legalEvent.test([risk.risk, risk.reason, risk.watch].join(' '))) return risk;
              cautiousRiskCount++;
              return { risk: '法律與監管風險', reason: '若發生訴訟或監管執法，可能增加合規成本或影響營運。',
                watch: '可觀察官方公告、監管文件與法院紀錄。' };
            });
          }
          sourceValidation.cautiousRiskCount = cautiousRiskCount;
          log({ event: 'company_report_sources', attempt: attemptCount, model, mode, ...sourceValidation });
        }
        log({ event: 'company_report_attempt', attempt: attemptCount, model, status: 200,
          durationMs: Math.round(now() - started), timeoutMs: remainingMs, errorSource: null,
          mode, outcome: 'success', validation: true });
        return { report, reportFormat, modelName: model, text: serializeReport(report),
          ...(grounding ? { grounding, sourceValidation } : {}) };
      } catch (error) {
        lastError = error;
        const status = received ? 200 : httpStatus(error);
        lastSource = received ? stage : errorSource(error);
        log({ event: 'company_report_attempt', attempt: attemptCount, model, status,
          durationMs: Math.round(now() - started), timeoutMs: remainingMs, errorSource: lastSource,
          mode, validation: received, outcome: 'failed', message: safeErrorMessage(error) });
        // Retry one rejected request without provider-side schema constraints.
        // Local validation remains identical in both modes.
        if (!received && status === 400 && !jsonOnly) {
          jsonOnly = true;
          continue;
        }
        if (received) {
          // Invalid model output is not an HTTP outage. Retry it at most once.
          if (uniqueModels.length === 1 && validationRetries++ === 0) continue;
          break;
        }
        if (!isRetryable(error) && lastSource !== 'client_timeout') throw error;
        if (apiRetries >= 2 || attemptCount >= (reserveMs ? 3 : 4)) break;
        const delayMs = retryDelayMs(apiRetries, { random, retryAfterMs: error.retryAfterMs || 0 });
        if (deadline - now() - reserveMs <= delayMs) break;
        log({ event: 'company_report_backoff', model, attempt: attemptCount, status,
          errorSource: lastSource, delayMs, retry: apiRetries + 1 });
        await sleep(delayMs);
        apiRetries++;
      }
    }
  }
  const invalidOutput = ['json_parse', 'report_validation', 'generation_finish'].includes(lastSource);
  const error = new Error(invalidOutput
    ? 'AI 已回覆，但報告內容未通過完整性檢查。本次不計入報告額度，請稍後再試。'
    : 'AI 服務暫時繁忙或回應逾時，已有限次重試。本次不計入報告額度，請稍後再試。');
  error.statusCode = 503;
  error.code = invalidOutput ? 'REPORT_INVALID_OUTPUT' : 'REPORT_AI_UNAVAILABLE';
  error.errorSource = lastSource;
  error.upstreamStatus = httpStatus(lastError);
  error.cause = lastError;
  throw error;
}

function createReportCache({ now = Date.now, ttlMs = 3 * 24 * 3600000, maxEntries = 100, store, log = () => {} } = {}) {
  const cached = new Map();
  const pending = new Map();
  const remember = (key, entry) => {
    if (cached.size >= maxEntries) cached.delete(cached.keys().next().value);
    cached.set(key, entry);
  };
  return async (key, produce, validate = () => {}) => {
    const existing = cached.get(key);
    if (existing && existing.expires > now()) return { ...existing.value, cached: true, cacheTier: 'memory' };
    cached.delete(key);
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(async () => {
      try {
        const saved = store ? await store.read(key) : null;
        if (saved && saved.expires > now()) {
          validate(saved.value);
          if (!saved.value.sourceInfo.limited) {
            remember(key, saved);
            log({ event: 'report_cache_hit', cacheTier: 'database', key });
            return { ...saved.value, cached: true, cacheTier: 'database' };
          }
        }
      } catch (error) {
        log({ event: 'report_cache_rejected', key, errorSource: 'report_cache', message: safeErrorMessage(error) });
      }
      const value = await produce();
      validate(value);
      if (!value.sourceInfo.limited) {
        const expires = now() + ttlMs;
        remember(key, { value, expires });
        try { await store?.write(key, value, expires); }
        catch (error) { log({ event: 'report_cache_write_failed', key, errorSource: 'report_cache', message: safeErrorMessage(error) }); }
      }
      return { ...value, cached: false, cacheTier: 'generated' };
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

module.exports = { SECTIONS, buildContract, providerSchema, safeErrorMessage, reportErrorResponse, validateReport, generateValidatedReport, extractReportGrounding, createReportCache };
