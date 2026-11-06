import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAoE2RecsRequestGate } from '../server/services/aoe2recs-request-gate.js';

test('different consumers run serially, space requests and merge the same profile', async () => {
  let clock = 1000, active = 0, maxActive = 0;
  const starts = [], persisted = [];
  const get = createAoE2RecsRequestGate({ now: () => clock, sleep: async ms => { clock += ms; },
    saveState: async state => persisted.push(state), request: async id => {
      starts.push([id, clock]); maxActive = Math.max(maxActive, ++active);
      await new Promise(resolve => setImmediate(resolve)); clock += 50; active--; return { id };
    } });
  const result = await Promise.all([get('1'), get('2'), get('1'), get('3')]);
  assert.deepEqual(starts.map(row => row[0]), ['1', '2', '3']);
  assert.equal(maxActive, 1);
  assert.equal(starts[1][1] - starts[0][1], 3050);
  assert.equal(starts[2][1] - starts[1][1], 3050);
  assert.equal(result[0], result[2]);
  assert.equal(persisted.at(-1).failures, 0);
});

test('one failure drops the entire batch and persisted cooldown survives a restart', async () => {
  let clock = 1000, calls = 0, disk;
  const options = { now: () => clock, sleep: async ms => { clock += ms; },
    readState: async () => disk, saveState: async state => { disk = { ...state }; },
    request: async () => { calls++; throw Error('WebSocket 403'); } };
  const get = createAoE2RecsRequestGate(options);
  const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => get(String(i))));
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(disk.blockedUntil, 901000);
  const restarted = createAoE2RecsRequestGate(options);
  await assert.rejects(restarted('new'), /暂停请求/);
  assert.equal(calls, 1);
  for (const duration of [30, 60, 120, 240, 360, 360]) {
    clock = disk.blockedUntil;
    const before = clock;
    await assert.rejects(restarted('new'), /WebSocket 403/);
    assert.equal(disk.blockedUntil - before, duration * 60_000);
  }
  clock = disk.blockedUntil;
  const recovered = createAoE2RecsRequestGate({ ...options, request: async () => 'ok' });
  assert.equal(await recovered('new'), 'ok');
  assert.equal(disk.failures, 0);
  assert.equal(disk.blockedUntil, 0);
});

test('pending queue is bounded without opening more connections', async () => {
  let release, calls = 0;
  const get = createAoE2RecsRequestGate({ maxPending: 2, intervalMs: 0, sleep: async () => {},
    request: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = get('1'), second = get('2');
  await assert.rejects(get('3'), /队列已满/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); release('one');
  assert.equal(await first, 'one');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); release('two');
  assert.equal(await second, 'two');
});


test('manual three-day pause survives restart without being capped by failure backoff', async () => {
  let clock=1000,calls=0,disk={pausedUntil:1000+72*60*60_000};
  const options={now:()=>clock,sleep:async ms=>{clock+=ms;},readState:async()=>disk,saveState:async s=>{disk=s;},request:async()=>{calls++;return 'ok';}};
  const get=createAoE2RecsRequestGate(options);
  await assert.rejects(get('1'),error=>error.retryAt===disk.pausedUntil);
  clock+=48*60*60_000;
  await assert.rejects(createAoE2RecsRequestGate(options)('2'),/暂停请求/);
  assert.equal(calls,0);
  clock=disk.pausedUntil;
  assert.equal(await createAoE2RecsRequestGate(options)('3'),'ok');
  assert.equal(calls,1);
});

test('missing profile keeps three-second spacing without cooling down or dropping other accounts', async () => {
  let clock=1000,disk;
  const starts=[];
  const get=createAoE2RecsRequestGate({now:()=>clock,sleep:async ms=>{clock+=ms},saveState:async s=>{disk={...s}},request:async id=>{
    starts.push([id,clock]);
    if(id==='missing')throw Object.assign(new Error('no profile'),{code:'AOE2RECS_PROFILE_UNAVAILABLE'});
    return id;
  }});
  const results=await Promise.allSettled([get('missing'),get('valid')]);
  assert.equal(results[0].status,'rejected');
  assert.equal(results[1].value,'valid');
  assert.equal(starts[1][1]-starts[0][1],3000);
  assert.equal(disk.failures,0);
  assert.equal(disk.blockedUntil,0);
});
