const test = require('node:test');
const assert = require('node:assert/strict');
const { getUsage, reserve } = require('./guest-access');

test('reserves in-flight requests and releases failed generations', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  const settle = reserve('pending', 'company_intro', now);
  assert.throws(() => reserve('pending', 'company_intro', now), { statusCode: 403, loginRequired: true });
  settle(false);
  assert.equal(getUsage('pending', now).used.company_intro, 0);
  reserve('pending', 'company_intro', now)(true);
  assert.throws(() => reserve('pending', 'company_intro', now), { statusCode: 403 });
});

test('counts successful requests exactly once and keeps chat separate', () => {
  const now = Date.UTC(2026, 9, 21, 12);
  const settle = reserve('success', 'company_intro', now);
  settle(true);
  settle(false);
  settle(true);
  assert.equal(getUsage('success', now).used.company_intro, 1);
  for (let index = 0; index < 3; index += 1) reserve('success', 'chat_query', now)(true);
  assert.throws(() => reserve('success', 'chat_query', now), { statusCode: 403, loginRequired: true });
  assert.equal(getUsage('separate', now).used.chat_query, 0);
});

test('resets at Taipei midnight and does not expose mutable usage', () => {
  const beforeMidnight = Date.UTC(2026, 9, 21, 15, 59);
  reserve('midnight', 'company_intro', beforeMidnight)(true);
  const usage = getUsage('midnight', beforeMidnight);
  usage.used.company_intro = 0;
  assert.equal(getUsage('midnight', beforeMidnight).used.company_intro, 1);
  assert.equal(getUsage('midnight', beforeMidnight + 60000).used.company_intro, 0);
});
