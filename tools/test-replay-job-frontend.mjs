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
    replayLoadEapm: async () => {}, replayLoadUnitMap: async () => {}, replayLoadTechMap: async () => {},
    replaySummaryMarkup: summary => rendered.push(summary), replayLoadMatchInfo: async () => {} });
  await vm.runInContext(code + "\nloadServerReplay('123','456',true)", context);
  assert.equal(requests.length, 3); assert.equal(rendered.length, 1);
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(rendered[0].test, true);
  assert.ok(requests.every(req => req.options.headers['X-AOE2-Client'] === 'web'));
  assert.match(elements['#replayStatus'].textContent, /缓存/);
});

test('opening an uncached replay page only reads cache and waits for a start click', async () => {
  const elements = { '#replayStatus': {}, '#replayResult': {}, '#replayRemoteRetry': {} };
  const requests = [];
  const context = vm.createContext({ document: { querySelector: key => elements[key] }, AbortSignal,
    fetch: async (url,options) => { requests.push(options);return Response.json({ code: 'ANALYSIS_REQUIRED' },{status:404}); } });
  await vm.runInContext(code + "\nloadServerReplay('123','456')", context);
  assert.equal(requests.length,1);assert.equal(requests[0].method,'GET');
  assert.equal(elements['#replayRemoteRetry'].textContent,'开始分析');
  assert.equal(elements['#replayRemoteRetry'].hidden,false);
});

test('opening a cached replay page renders immediately without submitting a job', async () => {
  const elements = { '#replayStatus': {}, '#replayResult': {}, '#replayRemoteRetry': {} };
  let rendered=0, calls=0;
  const context = vm.createContext({ document: { querySelector: key => elements[key] }, AbortSignal,
    fetch: async (_url,options) => { calls++;assert.equal(options.method,'GET');return Response.json({summary:{},matchInfo:{server:'x',results:[]}},{headers:{'x-replay-cache':'HIT'}}); },
    replayLoadEapm:async()=>{},replayLoadUnitMap:async()=>{},replayLoadTechMap:async()=>{},replaySummaryMarkup:()=>{rendered++;} });
  await vm.runInContext(code + "\nloadServerReplay('123','456')", context);
  assert.equal(calls,1);assert.equal(rendered,1);
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
