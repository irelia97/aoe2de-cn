import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpstreamGateway } from '../server/services/upstream-gateway.js';

const base = 'https://data.aoe2companion.com/api/matches/';
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('concurrent duplicate reads merge and cached JSON can be consumed independently', async () => {
  let calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, fetchImpl: async () => { calls++; return json({ id: 1 }); } });
  const [first, second] = await Promise.all([gate.fetch(base + '1'), gate.fetch(base + '1')]);
  assert.deepEqual(await first.json(), { id: 1 }); assert.deepEqual(await second.json(), { id: 1 });
  await (await gate.fetch(base + '1')).json(); assert.equal(calls, 1);
  assert.equal(gate.stats()['data.aoe2companion.com'].merged, 1);
});

test('429 cooldown blocks the entire host without issuing another network call', async () => {
  let clock = 0, calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, now: () => clock, fetchImpl: async () => {
    calls++; return new Response('', { status: 429, headers: { 'retry-after': '60' } });
  } });
  assert.equal((await gate.fetch(base + '1')).status, 429);
  assert.equal((await gate.fetch(base + '2')).status, 429); assert.equal(calls, 1);
  clock = 60000; await gate.fetch(base + '2'); assert.equal(calls, 2);
});

test('priority requests precede queued background reads and queue capacity is bounded', async () => {
  let release;
  const order = [];
  const gate = createUpstreamGateway({ gapMs: 0, maxQueue: 2, fetchImpl: async url => {
    order.push(url); if (url.endsWith('/1')) await new Promise(resolve => { release = resolve; }); return json({});
  } });
  const first = gate.fetch(base + '1'), low = gate.fetch(base + '2'), high = gate.fetch(base + '3', { priority: 10 });
  await assert.rejects(gate.fetch(base + '4'), /队列已满/);
  release(); await Promise.all([first, low, high]);
  assert.deepEqual(order, [base + '1', base + '3', base + '2']);
});

test('invalid destinations are rejected and aborted queued requests do not reach upstream', async () => {
  let calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, fetchImpl: async () => { calls++; return json({}); } });
  await assert.rejects(gate.fetch('http://127.0.0.1/'), /不允许/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(gate.fetch(base + '1', { signal: controller.signal }), /cancelled/);
  assert.equal(calls, 0);
});

test('a caller disconnect removes its queued request before any upstream fetch', async () => {
  let release, calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, fetchImpl: async () => {
    calls++; await new Promise(resolve => { release = resolve; }); return json({});
  } });
  const first = gate.fetch(base + '1');
  const controller = new AbortController();
  const second = gate.fetch(base + '2', { signal: controller.signal });
  controller.abort(new Error('caller left'));
  await assert.rejects(second, /caller left/);
  assert.equal(gate.stats()['data.aoe2companion.com'].queued, 0);
  release(); await first; assert.equal(calls, 1);
});

test('one disconnected reader does not cancel a merged automatic notification request', async () => {
  let release, calls = 0;
  const gate = createUpstreamGateway({ gapMs: 0, fetchImpl: async (_url, options) => {
    calls++; await new Promise(resolve => { release = resolve; });
    assert.equal(options.signal.aborted, false); return json({ ok: true });
  } });
  const browser = new AbortController();
  const first = gate.fetch(base + '1', { signal: browser.signal });
  const automatic = gate.fetch(base + '1', { priority: 10 });
  browser.abort(new Error('browser left'));
  await assert.rejects(first, /browser left/);
  release(); assert.deepEqual(await (await automatic).json(), { ok: true }); assert.equal(calls, 1);
});

test('a fetch ignoring abort cannot hold the host slot, and a late result cannot fill cache', async () => {
  let finish;
  const gate = createUpstreamGateway({ gapMs: 0, requestTimeoutMs: 30, fetchImpl: url =>
    url.endsWith('/stuck') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(json({ ok: true })) });
  const stuck = gate.fetch(base + 'stuck');
  const next = gate.fetch(base + 'next');
  await assert.rejects(stuck, /硬性时限/);
  assert.deepEqual(await (await next).json(), { ok: true });
  const state = gate.stats()['data.aoe2companion.com'];
  assert.equal(state.active, 0); assert.equal(state.timedOut, 1);
  assert.equal(state.lastFailure.phase, 'headers');
  finish(json({ late: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gate.stats()['data.aoe2companion.com'].cacheEntries, 1);
});

test('stalled JSON body and stalled cancellation both release on deadline', async () => {
  const gate = createUpstreamGateway({ gapMs: 0, requestTimeoutMs: 30, fetchImpl: async url =>
    url.endsWith('/stuck') ? new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })) : json({ ok: true }) });
  const stuck = gate.fetch(base + 'stuck');
  const next = gate.fetch(base + 'next');
  await assert.rejects(stuck, /硬性时限/);
  assert.equal((await next).status, 200);
  assert.equal(gate.stats()['data.aoe2companion.com'].lastFailure.phase, 'body');
  assert.equal(gate.stats()['data.aoe2companion.com'].active, 0);
});

test('429 with a stalled body cancellation still returns promptly and blocks subsequent reads', async () => {
  const gate = createUpstreamGateway({ gapMs: 0, requestTimeoutMs: 30, fetchImpl: async () =>
    new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status: 429 }) });
  assert.equal((await gate.fetch(base + '1')).status, 429);
  assert.equal((await gate.fetch(base + '2')).status, 429);
  assert.equal(gate.stats()['data.aoe2companion.com'].active, 0);
  assert.equal(gate.stats()['data.aoe2companion.com'].timedOut, 0);
});

test('an unconsumed streamed response cannot hold a host indefinitely', async () => {
  const gate = createUpstreamGateway({ requestTimeoutMs: 30, fetchImpl: async () =>
    new Response(new ReadableStream({ cancel: () => new Promise(() => {}) })) });
  const response = await gate.fetch('https://steamcommunity.com/profiles/1');
  await new Promise(resolve => setTimeout(resolve, 45));
  await assert.rejects(response.text(), /硬性时限/);
  assert.equal(gate.stats()['steamcommunity.com'].active, 0);
});
