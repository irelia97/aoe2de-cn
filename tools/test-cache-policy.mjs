import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BoundedCache } from '../server/services/bounded-cache.js';
import { createReplayAnalysisService, createReplayCacheState } from '../server/services/replay-analysis-service.js';
import { createUpstreamGateway } from '../server/services/upstream-gateway.js';

test('player LRU retains recently accessed entries and caps memory entries', () => {
  const cache = new BoundedCache(2);
  cache.set('a', 1).set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.has('b'), false); assert.equal(cache.size, 2);
  assert.equal(cache.stats().evictions, 1);
});

test('replay results older than 30 minutes remain reusable and disk budgets evict oldest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-policy-'));
  const clock = Date.now();
  try {
    for (let i = 1; i <= 3; i++) {
      const path = join(dir, `v7-${i}-1.json.gz`);
      await writeFile(path, Buffer.alloc(10, i));
      await writeFile(`${path}.meta.json`, JSON.stringify({ complete: true }));
      await utimes(path, new Date(clock - i * 3600000), new Date(clock - i * 3600000));
    }
    const replay = createReplayAnalysisService({ cacheDir: dir, now: () => clock, maxCacheBytes: 20, maxCacheEntries: 2 });
    assert.equal((await replay.get('1', '1')).cached, true);
    await replay.cleanup();
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.gz')).sort(), ['v7-1-1.json.gz', 'v7-2-1.json.gz']);
    assert.equal(replay.stats().diskBytes, 20);
    assert.equal(replay.stats().evictions, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('public and automatic analysis share in-flight downloads including failure cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-shared-'));
  let calls = 0, release;
  const shared = createReplayCacheState();
  const fetchImpl = async url => {
    if (url.includes('/api/matches/')) return Response.json({ matchId: '1', teams: [] });
    calls++; await new Promise(resolve => { release = resolve; }); throw new Error('offline');
  };
  const first = createReplayAnalysisService({ cacheDir: dir, shared, fetchImpl });
  const second = createReplayAnalysisService({ cacheDir: dir, shared, fetchImpl });
  try {
    const tasks = Promise.allSettled([first.get('1', '1'), second.get('1', '1')]);
    for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(calls, 1); release();
    assert.equal((await tasks).filter(result => result.status === 'rejected').length, 2);
    assert.equal(shared.pending.size, 0); assert.equal(first.stats().merged, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('finished results cache longer, live data expires, and cooldown still serves fresh cache', async () => {
  let clock = 0, calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, now: () => clock, fetchImpl: async url => {
    calls++;
    if (url.endsWith('/3')) return new Response('', { status: 429 });
    return Response.json({ finished: url.endsWith('/1') ? 'date' : null, teams: [{ players: [{ won: true }] }] });
  } });
  const base = 'https://data.aoe2companion.com/api/matches/';
  await gate.fetch(base + '1'); await gate.fetch(base + '2');
  clock = 11000; await gate.fetch(base + '1'); await gate.fetch(base + '2');
  assert.equal(calls, 3);
  await gate.fetch(base + '3');
  assert.equal((await gate.fetch(base + '1')).status, 200);
  assert.equal((await gate.fetch(base + '4')).status, 429);
  assert.equal(calls, 4);
});

test('incomplete replay results and metadata keep a short lifetime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'replay-incomplete-'));
  let clock = Date.now(), calls = 0;
  const replay = createReplayAnalysisService({ cacheDir: dir, now: () => clock,
    fetchImpl: async () => { calls++; return Response.json({ matchId: '1', teams: [{ players: [{ profileId: 1, won: null }] }] }); } });
  try {
    await writeFile(join(dir, 'v7-1-1.json.gz'), 'incomplete');
    await writeFile(join(dir, 'v7-1-1.json.gz.meta.json'), '{"complete":false}');
    await replay.getMatchInfo('1'); clock += 11000; await replay.getMatchInfo('1');
    assert.equal(calls, 2);
    clock += 30 * 60000;
    assert.equal(await replay.readCached('1', '1'), null);
    await replay.cleanup(); assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
