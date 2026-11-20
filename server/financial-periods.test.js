const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeFinancialData, buildFinancialPrompt } = require('./financial-report');

function fixture() {
  const quarters = Array.from({ length: 11 }, (_, i) => {
    const year = 2026 - Math.floor(i / 4), q = 4 - i % 4;
    return { symbol: 'TEST', reportedCurrency: 'USD', fiscalYear: year, period: `Q${q}`,
      date: `${year}-${String(q * 3).padStart(2, '0')}-${q === 1 || q === 4 ? '31' : '30'}`,
      revenue: 100e6, grossProfit: 40e6, netIncome: 10e6, epsDiluted: 1,
      totalEquity: 80e6, totalCurrentAssets: 40e6, totalCurrentLiabilities: 20e6,
      totalDebt: 80e6, operatingCashFlow: 20e6, freeCashFlow: 15e6, capitalExpenditure: -5e6 };
  });
  const years = Array.from({ length: 5 }, (_, i) => ({ ...quarters[0], date: `${2026 - i}-12-31`,
    fiscalYear: 2026 - i, period: 'FY', revenue: 400e6, grossProfit: 160e6,
    netIncome: 40e6, epsDiluted: 4, operatingCashFlow: 80e6, freeCashFlow: 60e6, capitalExpenditure: -20e6 }));
  return { iq: quarters, bq: quarters, cq: quarters, ia: years, ba: years, ca: years,
    mt: [{ symbol: 'TEST', returnOnEquityTTM: 0.2 }],
    rt: [{ symbol: 'TEST', priceToEarningsRatioTTM: 25 }],
    mq: years.map(row => ({ ...row, returnOnEquity: 0.15 })),
    rq: years.map(row => ({ ...row, priceToEarningsRatio: 20 })) };
}

test('quarter and annual views retain distinct frequencies, units and TTM', () => {
  const result = normalizeFinancialData(fixture(), 'TEST');
  const q = result.views.quarter, a = result.views.annual;
  assert.equal(q.data.revenue.length, 8);
  assert.equal(a.data.revenue.length, 5);
  assert.equal(q.data.revenue[0].value, 100);
  assert.equal(a.data.revenue[0].value, 400);
  assert.equal(q.data.eps_diluted[0].value, 1);
  assert.equal(a.data.eps_diluted[0].value, 4);
  assert.equal(q.data.operating_cash_flow[0].value, 20e6);
  assert.equal(a.data.operating_cash_flow[0].value, 80e6);
  assert.equal(q.data.long_term_solvency[0].value, 1);
  assert.equal(a.data.long_term_solvency[0].value, 1);
  assert.deepEqual(q.data.roe, [{ date: 'TTM', value: 20 }]);
  assert.equal(a.data.roe.length, 5);
  assert.ok(a.data.roe.every(row => row.date !== 'TTM'));
  assert.equal(q.periods.cashFlow, 'quarter');
  assert.equal(a.periods.cashFlow, 'annual');
});

test('cumulative cash flow cannot masquerade as a single quarter', () => {
  const raw = fixture();
  raw.cq = raw.cq.map(row => ({ ...row, netIncome: 40e6 }));
  const result = normalizeFinancialData(raw, 'TEST');
  assert.equal(result.views.quarter.data.operating_cash_flow.length, 0);
  assert.equal(result.views.quarter.data.long_term_solvency.length, 0);
  assert.equal(result.views.annual.data.operating_cash_flow.length, 5);
});

test('cash-flow annual reconciliation rejects a mismatched fiscal year', () => {
  const raw = fixture();
  raw.cq = raw.cq.map(row => ({ ...row, operatingCashFlow: 40e6 }));
  const q = normalizeFinancialData(raw, 'TEST').views.quarter;
  assert.ok(q.data.operating_cash_flow.every(row => !row.date.startsWith('2026') && !row.date.startsWith('2025')));
});

test('missing quarters cannot produce a trailing-four-quarter debt ratio', () => {
  const raw = fixture();
  raw.cq = raw.cq.filter(row => row.period !== 'Q2');
  assert.equal(normalizeFinancialData(raw, 'TEST').views.quarter.data.long_term_solvency.length, 0);
});

test('missing annual data stays empty rather than borrowing quarterly data', () => {
  const raw = fixture();
  raw.ia = []; raw.ba = []; raw.ca = [];
  const a = normalizeFinancialData(raw, 'TEST').views.annual;
  assert.deepEqual(a.data.revenue, []);
  assert.deepEqual(a.data.total_equity, []);
  assert.deepEqual(a.data.operating_cash_flow, []);
});

test('zero denominators stay missing, and mismatched currencies are rejected', () => {
  const raw = fixture();
  raw.cq = raw.cq.map(row => ({ ...row, netIncome: 0, operatingCashFlow: 0 }));
  raw.iq = raw.iq.map(row => ({ ...row, netIncome: 0 }));
  assert.deepEqual(normalizeFinancialData(raw, 'TEST').views.quarter.data.ocf_netincome, []);
  raw.ba = raw.ba.map(row => ({ ...row, reportedCurrency: 'EUR' }));
  assert.throws(() => normalizeFinancialData(raw, 'TEST'), /CURRENCY_MISMATCH/);
});

test('prompt explicitly requires separate quarter and annual analyses', () => {
  const prompt = buildFinancialPrompt('TEST', normalizeFinancialData(fixture(), 'TEST'), null, '', '2026-11-20');
  assert.ok(prompt.includes('ai.annual'));
  assert.ok(prompt.includes('"annual":{"one_liner"'));
  assert.ok(prompt.includes('不以單季 OCF 作償債分母'));
});
