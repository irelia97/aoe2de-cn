import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVisibilityGrace } from '../server/services/realtime-visibility-grace.js';

for (const status of ['game', 'queueing', 'matched', 'cancelled', 'lobby']) test(`${status} disappearing gets one fixed five-minute window`, () => {
  let time = 1_000_000;
  const grace = createVisibilityGrace({ now: () => time });
  const apply = state => grace.apply([{ profileId: '42', ...state }])[0];
  assert.equal(apply({ status }).graceUntil, null);
  const lost = apply({ status: 'offline' });
  assert.equal(lost.graceUntil, time + 300000);
  time += 200000;
  assert.equal(apply({ status: 'offline' }).graceUntil, lost.graceUntil);
  time += 100000;
  assert.equal(apply({ status: 'offline' }).graceUntil, null);
  assert.equal(apply({ status: 'offline' }).graceUntil, null);
  apply({ status: 'queueing' });
  assert.equal(apply({ status: 'offline' }).graceUntil, time + 300000);
});
test('live streams persist, ended streams get grace, new statuses reset the window', () => {
  let time = 1_000_000;
  const grace = createVisibilityGrace({ now: () => time });
  const apply = state => grace.apply([{ profileId: '42', status: 'offline', ...state }])[0];
  apply({ live: { url: 'https://live.example' } });
  time += 3600000;
  assert.equal(apply({ live: { url: 'https://live.example' } }).graceUntil, null);
  assert.equal(apply({}).graceUntil, time + 300000);
  time += 60000;
  assert.equal(apply({ status: 'matched' }).graceUntil, null);
  assert.equal(apply({}).graceUntil, time + 300000);
});
test('restore preserves expiry and removed pool members do not retain grace', () => {
  const grace = createVisibilityGrace({ now: () => 1000 });
  grace.restore([{ profileId: '42', status: 'offline', visibilityGrace: { until: 2000 } }]);
  assert.equal(grace.apply([{ profileId: '42', status: 'offline' }])[0].graceUntil, 2000);
  grace.apply([]);
  assert.equal(grace.apply([{ profileId: '42', status: 'offline' }])[0].graceUntil, null);
});
