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

function schemaFor(value, path = '') {
  if (Array.isArray(value)) {
    const limits = ARRAY_LIMITS[path] || [1, path.startsWith('valueChain.') || path.endsWith('.examples') ? 3 : 8];
    const items = schemaFor(value[0], path);
    if (path === 'dashboard.newsTags') items.properties.category.enum = value.map(item => item.category);
    if (path === 'dashboard.financials') items.properties.area.description = '財務或營運觀察面向，五項不可重複';
    return { type: 'array', minItems: limits[0], maxItems: limits[1], items };
  }
  if (value && typeof value === 'object') {
    return {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, schemaFor(item, path ? `${path}.${key}` : key)])),
      required: Object.keys(value)
    };
  }
  return { type: 'string', description: String(value),
    ...(['valueChain.company', 'coreSummary.company'].includes(path) ? { enum: [value] } : {}) };
}

function buildContract(basePrompt) {
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
${requirements}`;
  return { schema: schemaFor(template), prompt };
}

function validateReport(value, schema, path = 'report') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: object required`);
    for (const key of schema.required) validateReport(value[key], schema.properties[key], `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) {
      throw new Error(`${path}: expected ${schema.minItems}-${schema.maxItems} items`);
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
  return SECTIONS.map(([key, marker]) => `<!-- ${marker}_START -->\n${JSON.stringify(report[key])}\n<!-- ${marker}_END -->`).join('\n\n');
}

async function generateValidatedReport({ basePrompt, models, generate, isRetryable, log = () => {}, timeoutMs = 65000 }) {
  const { schema, prompt } = buildContract(basePrompt);
  const uniqueModels = [...new Set(models.filter(Boolean))];
  const attempts = uniqueModels.length === 1 ? [uniqueModels[0], uniqueModels[0]] : uniqueModels.slice(0, 2);
  let lastError;
  for (const model of attempts) {
    let received = false;
    try {
      const result = await generate({
        model, contents: prompt,
        config: {
          responseMimeType: 'application/json', responseJsonSchema: schema,
          temperature: 0.3, maxOutputTokens: 32768,
          ...(model.startsWith('gemini-2.5') ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
          httpOptions: { apiVersion: 'v1beta', timeout: timeoutMs },
          abortSignal: AbortSignal.timeout(timeoutMs)
        }
      });
      received = true;
      const finishReason = result.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== 'STOP') throw new Error(`Incomplete generation: ${finishReason}`);
      const report = JSON.parse(result.text || '');
      validateReport(report, schema);
      return { report, modelName: model, text: serializeReport(report) };
    } catch (error) {
      lastError = error;
      log({ model, status: error.status || error.response?.status, validation: received, message: received ? error.message : 'AI request failed' });
      if (!received && !isRetryable(error) && !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
    }
  }
  const error = new Error('公司報告未能完整生成，已自動重試。請稍後再試，本次不計入報告額度。');
  error.statusCode = 503;
  error.cause = lastError;
  throw error;
}

function collectSearchResults(responses, queries, limit) {
  const buckets = responses.map((response, index) => response.status === 'fulfilled'
    ? (response.value.data.organic_results || []).filter(item => item.title && item.snippet).map(item => ({ ...item, query: queries[index] }))
    : []);
  const results = [];
  const seen = new Set();
  for (let round = 0; buckets.some(bucket => round < bucket.length) && results.length < limit; round++) {
    for (const bucket of buckets) {
      const item = bucket[round];
      if (!item || results.length >= limit) continue;
      const key = item.link || `${item.title}-${item.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(item);
    }
  }
  const successfulQueries = buckets.filter(bucket => bucket.length).length;
  if (results.length < 4) {
    const error = new Error('目前取得的公司資料不足，請稍後再試。本次不計入報告額度。');
    error.statusCode = 503;
    throw error;
  }
  return {
    results, successfulQueries,
    limited: successfulQueries < queries.length || results.length < 8
  };
}

function createReportCache({ now = Date.now, ttlMs = 6 * 3600000, maxEntries = 100 } = {}) {
  const cached = new Map();
  const pending = new Map();
  return async (key, produce) => {
    const existing = cached.get(key);
    if (existing && existing.expires > now()) return { ...existing.value, cached: true };
    cached.delete(key);
    if (pending.has(key)) return pending.get(key);
    const task = Promise.resolve().then(produce).then(value => {
      if (!value.sourceInfo.limited) {
        if (cached.size >= maxEntries) cached.delete(cached.keys().next().value);
        cached.set(key, { value, expires: now() + ttlMs });
      }
      return { ...value, cached: false };
    }).finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  };
}

module.exports = { SECTIONS, buildContract, validateReport, generateValidatedReport, collectSearchResults, createReportCache };
