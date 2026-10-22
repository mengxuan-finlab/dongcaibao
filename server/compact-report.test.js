const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { getBasePrompt } = require('./company-prompt');
const { getBasePrompt: legacyPrompt } = require('./fixtures/legacy-company-prompt');
const { buildContract, generateValidatedReport, validateReport } = require('./company-report');

function fixture(symbol = 'AAPL') {
  return {
    company: { symbol, overview: '公司提供硬體與軟體服務', revenue: '產品銷售及訂閱收入', customers: '消費者與企業' },
    products: [{ name: '行動裝置', examples: ['代表產品'], significance: '貢獻主要收入' }],
    growth: [{ driver: '訂閱服務', reason: '裝置用戶可帶來持續性收入', watch: '服務營收成長' }],
    risks: [{ risk: '需求疲弱', reason: '換機週期延長可能影響產品收入', watch: '產品營收變化' }],
    financialWatch: [{ metric: '營收', importance: '觀察產品及服務需求', watch: '各領域營收增速' }]
  };
}

function frontend() {
  const html = readFileSync(`${__dirname}/../client/stock_integration.html`, 'utf8');
  const escape = html.slice(html.indexOf('  function escapeHtml'), html.indexOf('  function normalizeContextText'));
  const code = html.slice(html.indexOf('  function validateCompactReport'), html.indexOf('  document.getElementById("symbolInput").addEventListener'));
  return new Function('renderSectionAskButton', 'renderReadingChapter', escape + code + '\nreturn { readCompanySections, renderCompanyReport };')(
    title => `<button>${title}</button>`, (title, preview, content) => `<details><summary>${title}</summary>${content}</details>`
  );
}

test('production prompt requests only the compact report, with a substantially smaller contract', () => {
  const source = 'Shared search snapshot';
  const compact = buildContract(getBasePrompt('AAPL', source));
  const legacy = buildContract(legacyPrompt('AAPL', source));
  assert.equal(compact.reportFormat, 'compact-v1');
  assert.equal(compact.maxOutputTokens, 8192);
  assert.deepEqual(compact.schema.required, ['company', 'products', 'growth', 'risks', 'financialWatch']);
  assert.equal(compact.prompt.length < legacy.prompt.length / 2, true);
  assert.equal(compact.prompt.includes('COMPACT_REPORT_START'), false);
  assert.equal(compact.schema.properties.timeline, undefined);
  assert.equal(compact.schema.properties.dashboard, undefined);
});

test('compact reports require all fields but do not reject useful extra items at editorial target counts', () => {
  const { schema } = buildContract(getBasePrompt('AAPL', 'facts'));
  const report = fixture();
  validateReport(report, schema);
  report.products[0].examples = ['one', 'two', 'three'];
  validateReport(report, schema);
  report.company.symbol = 'NVDA';
  assert.throws(() => validateReport(report, schema), /company.symbol/);
  report.company.symbol = 'AAPL';
  report.risks = [];
  assert.throws(() => validateReport(report, schema), /risks/);
  report.risks = fixture().risks;
  report.financialWatch[0].watch = ' ';
  assert.throws(() => validateReport(report, schema), /financialWatch/);
});

test('generation uses the smaller token budget and frontend renders all four topics plus the chart', async () => {
  let request;
  const generated = await generateValidatedReport({
    basePrompt: getBasePrompt('AAPL', 'facts'), models: ['gemini-3.6-flash'], isRetryable: () => false,
    generate: async args => { request = args; return { text: JSON.stringify(fixture()) }; }
  });
  assert.equal(request.config.maxOutputTokens, 8192);
  assert.equal(request.config.thinkingConfig.thinkingLevel, 'low');
  assert.equal(generated.reportFormat, 'compact-v1');
  const page = frontend();
  const structured = page.readCompanySections(generated);
  assert.deepEqual(page.readCompanySections({ text: generated.text }), structured);
  const html = page.renderCompanyReport(structured, 'AAPL', '<iframe title="chart"></iframe>');
  for (const title of ['公司做什麼、如何賺錢', '主要產品與服務', '成長動能與風險', '財報與營運觀察', '股價走勢']) assert.equal(html.includes(title), true);
  assert.equal(html.includes('公司發展時間線'), false);
  assert.equal(html.includes('深入閱讀'), false);
});

test('compact frontend escapes content and rejects incomplete structured and text reports', () => {
  const page = frontend();
  const report = fixture();
  report.company.overview = '<script>alert(1)</script>';
  const html = page.renderCompanyReport(page.readCompanySections({ report }), 'AAPL', 'chart');
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('&lt;script&gt;'), true);
  delete report.financialWatch;
  assert.throws(() => page.readCompanySections({ report }), /未完整/);
  assert.throws(() => page.readCompanySections({ text: '<!-- COMPACT_REPORT_START -->{}' }), /未完整/);
  assert.throws(() => page.readCompanySections({ text: '<!-- COMPACT_REPORT_START -->{<!-- COMPACT_REPORT_END -->' }), /格式不完整/);
});

test('cached legacy full reports cannot pass the new compact schema', () => {
  const { schema } = buildContract(getBasePrompt('AAPL', 'facts'));
  assert.throws(() => validateReport({ coreSummary: { company: 'AAPL' } }, schema), /company/);
});
