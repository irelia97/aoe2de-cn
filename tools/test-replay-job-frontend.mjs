import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('let replayAnalysisRequest = 0;');
const code = source.slice(start, source.indexOf('\nasync function parseReplayFile', start));

test('web replay analysis polls a background job then renders the completed result', async () => {
  const elements = { '#replayStatus': {}, '#replayResult': {}, '#replayRemoteRetry': {} };
  const requests = [], rendered = [];
  const responses = [
    new Response(JSON.stringify({ pollUrl: '/api/replay-analysis/status?jobId=example' }), { status: 202 }),
    new Response(JSON.stringify({ state: 'running' }), { status: 202 }),
    new Response(JSON.stringify({ summary: { test: true }, matchInfo: { server: 'eastasia', results: [] } }), { headers: { 'x-replay-cache': 'HIT' } })
  ];
  const context = vm.createContext({ document: { querySelector: key => elements[key] }, AbortSignal,
    setTimeout: fn => { fn(); },
    fetch: async (url, options) => { requests.push({ url, options }); return responses.shift(); },
    replayLoadUnitMap: async () => {}, replayLoadTechMap: async () => {},
    replaySummaryMarkup: summary => rendered.push(summary), replayLoadMatchInfo: async () => {} });
  await vm.runInContext(code + "\nloadServerReplay('123','456')", context);
  assert.equal(requests.length, 3); assert.equal(rendered.length, 1);
  assert.equal(rendered[0].test, true);
  assert.ok(requests.every(req => req.options.headers['X-AOE2-Client'] === 'web'));
  assert.match(elements['#replayStatus'].textContent, /缓存/);
});

test('rate-limit message is shown directly without polling or parsing a replay', async () => {
  const elements = { '#replayStatus': {}, '#replayResult': {}, '#replayRemoteRetry': {} };
  let calls = 0;
  const context = vm.createContext({ document: { querySelector: key => elements[key] }, AbortSignal,
    fetch: async () => { calls++; return new Response(JSON.stringify({ error: '每分钟最多2次，请60秒后重试' }), { status: 429 }); } });
  await vm.runInContext(code + "\nloadServerReplay('123','456')", context);
  assert.equal(calls, 1); assert.match(elements['#replayStatus'].textContent, /每分钟最多2次/);
  assert.equal(elements['#replayRemoteRetry'].hidden, false);
});
