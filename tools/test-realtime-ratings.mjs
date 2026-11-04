import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeRatings } from '../server/services/realtime-ratings.js';

test('rating lookups return immediately, share pending work and cap concurrency', async () => {
  const waiting = new Map();
  let changes = 0;
  const ratings = createRealtimeRatings({ concurrency:2, onChange:()=>changes++, fetchStats:(id,options)=>{
    assert.equal(options.rankedOnly,true);
    return new Promise(resolve=>waiting.set(id,resolve));
  } });
  assert.equal(ratings.get(['1','2','3']).size,0);
  ratings.get(['1','2','3']);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...waiting.keys()],['1','2']);
  waiting.get('1')([{id:3,rating:2500}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual([...waiting.keys()],['1','2','3']);
  assert.equal(ratings.get(['1']).get('1'),2500);
  assert.equal(changes,1);
  waiting.get('2')([]);waiting.get('3')([]);
});

test('warm ratings survive refresh failures and retry after a delay', async () => {
  let clock=1000,calls=0;
  const ratings=createRealtimeRatings({now:()=>clock,onChange:()=>{},fetchStats:async()=>{calls++;throw Error('offline');}});
  ratings.restore([{player:{profileId:'42',rating:2400}}]);
  assert.equal(ratings.get(['42']).get('42'),2400);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ratings.get(['42']).get('42'),2400);
  assert.equal(calls,1);
  clock+=60000;ratings.get(['42']);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2);
});
