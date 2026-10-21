const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const html = readFileSync(`${__dirname}/../client/stock_integration.html`, 'utf8');

function setup() {
  let resolve;
  let signal;
  let writes = 0;
  let markup = '';
  const container = {
    isConnected: true,
    get innerHTML() { return markup; },
    set innerHTML(value) { markup = value; writes++; },
    querySelector() { return null; }
  };
  const escape = html.slice(html.indexOf('  function escapeHtml'), html.indexOf('  function normalizeContextText'));
  const card = html.slice(html.indexOf('  function startAdoptionCard'), html.indexOf('  function extractValueChain'));
  class Controller {
    constructor() { this.signal = { aborted: false }; }
    abort() { this.signal.aborted = true; }
  }
  const start = new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout',
    `const BACKEND_URL = 'https://example.com/api/analyze-stock';\n${escape}\n${card}\nreturn startAdoptionCard;`)(
    (url, options) => {
      signal = options.signal;
      return new Promise(done => { resolve = done; });
    }, Controller, () => 1, () => {}
  );
  const stop = start(container);
  return { container, stop, resolve: data => resolve({ ok: true, json: async () => data }),
    aborted: () => signal.aborted, writes: () => writes };
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('waiting card has an immediate official fallback and external links', () => {
  const view = setup();
  assert.equal(view.container.innerHTML.includes('公益認養資訊'), true);
  assert.equal(view.container.innerHTML.includes('target="_blank" rel="noopener noreferrer"'), true);
  assert.equal(view.container.innerHTML.includes('<img'), false);
  view.stop();
  assert.equal(view.aborted(), true);
});

test('animal content is escaped and unsafe image URLs are excluded', async () => {
  const view = setup();
  view.resolve({ animal: { kind: '貓', shelter: '<script>bad</script>', photo: 'javascript:bad' } });
  await flush();
  assert.equal(view.container.innerHTML.includes('<script>'), false);
  assert.equal(view.container.innerHTML.includes('&lt;script&gt;'), true);
  assert.equal(view.container.innerHTML.includes('<img'), false);
  view.stop();
});

test('a late adoption response cannot overwrite a finished report', async () => {
  const view = setup();
  view.stop();
  view.resolve({ animal: { kind: '貓', shelter: 'late response' } });
  await flush();
  assert.equal(view.writes(), 1);
});

test('detached waiting cards are never updated', async () => {
  const view = setup();
  view.container.isConnected = false;
  view.resolve({ animal: { kind: '狗', shelter: 'late response' } });
  await flush();
  assert.equal(view.writes(), 1);
  view.stop();
});

test('only guests and anonymous sessions enter the adoption waiting flow', () => {
  assert.equal(html.includes('if (!session?.user || session.user.is_anonymous)'), true);
  assert.equal(html.includes('stopAdoptionCard();'), true);
});
