import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMatchesService } from '../server/services/matches-service.js';

test('foreground history failures make one prioritized, bounded attempt', async () => {
  let calls = 0;
  const service = createMatchesService({ attempts: 1, requestTimeoutMs: 10_000, priority: 5,
    normalizeCompanionMatches: value => value,
    fetchUpstreamWithRateLimit: async (url, options) => {
      calls++;
      assert.equal(options.priority, 5);
      assert.ok(options.signal instanceof AbortSignal);
      throw new Error('upstream unavailable');
    }
  });
  await assert.rejects(service.fetchLatestWorldsEdgeMatchOnce('42'), /upstream unavailable/);
  assert.equal(calls, 1);
});

test('an unfinished match can be refreshed by match id without fetching profile history', async () => {
  const requested = [];
  const service = createMatchesService({ attempts:1, requestTimeoutMs:10_000, priority:5,
    normalizeCompanionMatches: payload => payload.matches.map(item => ({ id:item.matchId, finished:item.finished ? 1 : 0 })),
    fetchUpstreamWithRateLimit: async url => {
      requested.push(String(url));
      return { ok:true, json:async () => ({ matchId:520148390, finished:'2026-11-10T12:00:00Z' }) };
    }
  });
  const match = await service.fetchWorldsEdgeMatchByIdOnce('520148390');
  assert.deepEqual(match,{ id:520148390,finished:1 });
  assert.deepEqual(requested,['https://data.aoe2companion.com/api/matches/520148390']);
});

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('async function getWorldsEdgeMatches(');
const code = source.slice(start, source.indexOf('\nfunction aoe2RecsProfilePath', start));
const match = id => ({ id, started: id, finished: id + 1 });

for (const additions of [3, 30, 120]) test(`history with ${additions} new games uses at most two windows and retains latest 100`, async () => {
  const baseline = Array.from({ length: 100 }, (_, i) => match(100 - i));
  const latest = 100 + additions;
  const requested = [];
  const ctx = {
    readWorldsEdgeMatchesCache: async () => ({ matches: baseline, savedAt: 0, pages: 1 }),
    worldsEdgeMatchCacheTtl: 600000, worldsEdgeMatchRefreshes: new Map(), worldsEdgeMatchCache: new Map(),
    fetchLatestProfileMatchOnce: async () => match(latest),
    fetchProfileMatchesOnce: async (id, page, count) => {
      assert.equal(page, 1); requested.push(count);
      return { matches: Array.from({ length: count }, (_, i) => match(latest - i)), hasMore: true };
    },
    isTerminalMatch: value => Boolean(value.finished), hasOlderUnfinishedMatches: () => false,
    mkdir: async () => {}, writeFile: async () => {}, worldsEdgeMatchCacheDir: '/unused',
    worldsEdgeMatchCachePath: () => '/unused/42.json'
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  const result = await ctx.getWorldsEdgeMatches('42');
  assert.deepEqual(requested, additions < 10 ? [10] : [10, 100]);
  assert.equal(result.matches.length, 100);
  assert.deepEqual(Array.from(result.matches, value => value.id), Array.from({ length: 100 }, (_, i) => latest - i));
  assert.equal(result.upstreamPages, requested.length);
});
