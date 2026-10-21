const { readFileSync } = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = readFileSync(`${__dirname}/../client/financial_statements.html`, 'utf8');
const source = html.slice(html.indexOf('  const FINANCIAL_TRACKING_LIMIT'), html.indexOf('  document.getElementById("addBtn").addEventListener'));

function fixture({ ready = true, member = false } = {}) {
  let session = member ? { user: { id: 'member', is_anonymous: false } } : null;
  const rows = [];
  const calls = { anonymous: 0, insert: 0, upsert: 0, login: 0, alerts: [] };
  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', disabled: false, addEventListener() {} });
    return elements.get(id);
  } };
  const client = {
    rpc: async () => ({ data: ready, error: null }),
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInAnonymously: async () => {
        calls.anonymous++;
        session = { user: { id: 'guest', is_anonymous: true } };
        return { data: { ...session, session }, error: null };
      }
    },
    from() { return {
      select() { return this; }, eq() { return this; },
      order: async () => ({ data: [...rows], error: null }),
      insert: async row => { calls.insert++; rows.push({ id: 1, ...row }); return { error: null }; },
      upsert: async row => { calls.upsert++; rows.push({ id: 1, ...row }); return { error: null }; }
    }; }
  };
  const page = new Function('supabaseClient', 'document', 'window', 'alert', source + '\nreturn { init, addStock };')(
    client, document, { open() { calls.login++; } }, message => calls.alerts.push(message)
  );
  return { page, calls, document };
}

test('guest trial persists, uses insert, and asks login for a second stock', async () => {
  const { page, calls, document } = fixture();
  await page.init();
  assert.equal(calls.anonymous, 0);
  document.getElementById('symbolInput').value = 'AAPL';
  await page.addStock();
  assert.equal(calls.anonymous, 1);
  assert.equal(calls.insert, 1);
  assert.equal(calls.upsert, 0);
  await page.init();
  assert.equal(document.getElementById('planName').textContent, '訪客試用');
  document.getElementById('symbolInput').value = 'NVDA';
  await page.addStock();
  assert.equal(calls.login, 1);
  assert.equal(calls.insert, 1);
});

test('unconfigured trial fails closed before creating an anonymous identity', async () => {
  const { page, calls, document } = fixture({ ready: false });
  await page.init();
  document.getElementById('symbolInput').value = 'AAPL';
  await page.addStock();
  assert.equal(calls.anonymous, 0);
  assert.equal(calls.insert, 0);
  assert.equal(calls.alerts.length, 1);
});

test('registered members keep the five-stock workflow', async () => {
  const { page, calls, document } = fixture({ member: true });
  await page.init();
  assert.equal(document.getElementById('planLimit').textContent, 5);
  document.getElementById('symbolInput').value = 'AAPL';
  await page.addStock();
  assert.equal(calls.anonymous, 0);
  assert.equal(calls.upsert, 1);
});
