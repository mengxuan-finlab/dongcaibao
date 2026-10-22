const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createSupabaseReportStore } = require('./report-store');

function fixture() {
  const rows = new Map();
  const calls = [];
  let failure = null;
  const client = { from(table) {
    assert.equal(table, 'company_report_cache');
    let key, data, operation = 'read', after;
    return {
      select() { return this; },
      eq(column, value) { assert.equal(column, 'cache_key'); key = value; return this; },
      gt(column, value) { assert.equal(column, 'expires_at'); after = Date.parse(value); return this; },
      maybeSingle() { return this; },
      upsert(value, options) { assert.equal(options.onConflict, 'cache_key'); operation = 'write'; data = value; return this; },
      async abortSignal(signal) {
        assert.equal(signal instanceof AbortSignal, true);
        calls.push(operation);
        if (failure) return { error: failure };
        if (operation === 'write') { rows.set(data.cache_key, data); return { error: null }; }
        const row = rows.get(key);
        return { data: row && Date.parse(row.expires_at) > after ? row : null, error: null };
      }
    };
  } };
  return { client, rows, calls, fail: error => { failure = error; } };
}

test('Supabase store upserts and reads records with expiration and an abort signal', async () => {
  const db = fixture();
  const store = createSupabaseReportStore({ client: db.client, now: () => 0 });
  const value = { report: { company: 'AAPL' } };
  await store.write('AAPL', value, 1000);
  assert.deepEqual(await store.read('AAPL'), { value, expires: 1000 });
  assert.equal(db.rows.get('AAPL').updated_at, new Date(0).toISOString());
  assert.equal(await createSupabaseReportStore({ client: db.client, now: () => 1001 }).read('AAPL'), null);
});

test('missing table backs off for a minute, logs once, and recovers after SQL is applied', async () => {
  const db = fixture();
  let clock = 0;
  const events = [];
  const store = createSupabaseReportStore({ client: db.client, now: () => clock, log: event => events.push(event) });
  db.fail({ code: 'PGRST205', message: 'table not found' });
  assert.equal(await store.read('AAPL'), null);
  await store.write('AAPL', {}, 1000);
  assert.equal(await store.read('AAPL'), null);
  assert.equal(db.calls.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].code, 'PGRST205');
  clock = 60001;
  db.fail(null);
  await store.write('AAPL', { report: 'ready' }, 70000);
  assert.equal((await store.read('AAPL')).value.report, 'ready');
});

test('transport exceptions fail open for generation without exposing credential values', async () => {
  const events = [];
  const store = createSupabaseReportStore({
    client: { from() { throw new Error('failed https://example.com?key=secret Bearer credential'); } },
    log: event => events.push(event)
  });
  assert.equal(await store.read('AAPL'), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.includes('=secret'), false);
  assert.equal(events[0].message.includes('Bearer credential'), false);
});

test('cache migration enables RLS and grants no browser access', () => {
  const sql = readFileSync(`${__dirname}/sql/company-report-cache.sql`, 'utf8');
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public.company_report_cache from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on public.company_report_cache to service_role/);
  assert.equal(/create policy/i.test(sql), false);
});
