const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnimal, createAdoptionFeed } = require('./adoption');

function row(id = '1') {
  return {
    animal_id: id, animal_subid: `reference-${id}`, animal_status: 'OPEN', animal_kind: '貓',
    album_file: 'https://www.pet.gov.tw/photos/example.jpg', shelter_name: '測試收容所',
    animal_update: '2026-10-21', animal_place: '測試所在地'
  };
}

test('only open cats and dogs with safe government photos are shown', () => {
  assert.equal(normalizeAnimal(row()).reference, 'reference-1');
  assert.equal(normalizeAnimal({ ...row(), animal_status: 'ADOPTED' }), null);
  assert.equal(normalizeAnimal({ ...row(), animal_kind: '其他' }), null);
  assert.equal(normalizeAnimal({ ...row(), album_file: 'javascript:alert(1)' }), null);
  assert.equal(normalizeAnimal({ ...row(), album_file: 'https://www.pet.gov.tw.evil.test/a' }), null);
  assert.equal(normalizeAnimal({ ...row(), album_file: 'https://user:secret@www.pet.gov.tw/a' }), null);
  assert.equal(normalizeAnimal({ ...row(), shelter_name: '' }), null);
});

test('feed caches, deduplicates, selects and refreshes bounded source data', async () => {
  let clock = 0;
  let calls = 0;
  const feed = createAdoptionFeed({
    fetchRows: async () => { calls++; return [row('1'), row('1'), row('2')]; },
    now: () => clock, random: () => 0.75, ttlMs: 100
  });
  assert.equal((await feed()).animal.id, '2');
  assert.equal((await feed()).animal.id, '2');
  assert.equal(calls, 1);
  clock = 101;
  await feed();
  assert.equal(calls, 2);
});

test('concurrent visitors share one upstream request', async () => {
  let release;
  let calls = 0;
  const feed = createAdoptionFeed({ fetchRows: () => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  } });
  const first = feed();
  const second = feed();
  await Promise.resolve();
  release([row()]);
  assert.equal((await first).animal.id, '1');
  assert.equal((await second).animal.id, '1');
  assert.equal(calls, 1);
});

test('failure clears stale animals and backs off instead of breaking report generation', async () => {
  let clock = 0;
  let calls = 0;
  const feed = createAdoptionFeed({
    now: () => clock, ttlMs: 10, retryMs: 100,
    fetchRows: async () => {
      if (++calls === 1) return [row()];
      throw new Error('timeout');
    }
  });
  assert.equal((await feed()).animal.id, '1');
  clock = 11;
  assert.equal((await feed()).animal, null);
  assert.equal((await feed()).fetchedAt, null);
  assert.equal(calls, 2);
  clock = 112;
  assert.equal((await feed()).animal, null);
  assert.equal(calls, 3);
});

test('malformed and empty responses use the official-platform fallback', async () => {
  for (const response of [{ error: 'unavailable' }, [], [row('1'), { ...row('2'), animal_status: 'CLOSED' }]]) {
    const feed = createAdoptionFeed({ fetchRows: async () => response, random: () => 0 });
    const result = await feed();
    assert.equal(result.url.startsWith('https://www.pet.gov.tw/'), true);
    assert.equal(result.source, 'https://data.gov.tw/dataset/85903');
    assert.equal(result.animal?.id || null, Array.isArray(response) && response.length ? '1' : null);
  }
});
