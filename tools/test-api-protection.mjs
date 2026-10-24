import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApiProtection } from '../server/services/api-protection.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function request(headers = {}) {
  return { headers: { host: 'aoe2cn.cc', 'user-agent': 'Mozilla/5.0', 'sec-fetch-site': 'same-origin', 'x-aoe2-client': 'web', ...headers } };
}
function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.writeHead = (status, headers) => { res.status = status; Object.assign(res.headers, headers); };
  res.end = body => { res.body = body; res.writableEnded = true; res.emit('finish'); };
  return res;
}
const path = '/api/replay-analysis';

test('crawler, missing browser header and cross-origin calls never reach protected handlers', () => {
  const guard = createApiProtection();
  for (const headers of [
    { 'user-agent': 'Googlebot/2.1' }, { 'user-agent': 'curl/8.0' },
    { 'x-aoe2-client': undefined }, { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://another.example' }
  ]) {
    const res = response();
    assert.equal(guard.allow(request(headers), res, path, 'public-ip'), false);
    assert.equal(res.status, 403);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  const res = response();
  assert.equal(guard.allow(request({ 'user-agent': 'Googlebot' }), res, '/api/profile-matches', 'public-ip'), false);
  assert.equal(guard.allow(request({ 'user-agent': 'Googlebot' }), response(), '/api/avatar', 'public-ip'), false);
  assert.deepEqual(guard.stats(), { bot: 4, source: 3, rate: 0, concurrency: 0, activeHeavy: 0, activeAnalysis: 0, trackedClients: 0 });
});

test('normal browser and internal commands work, while API responses discourage indexing', () => {
  const guard = createApiProtection();
  const res = response();
  assert.equal(guard.allow(request(), res, path, 'public-ip'), true);
  assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow'); res.end();
  assert.equal(guard.allow(request({ 'user-agent': 'Python-urllib/3', 'x-aoe2-client': undefined }), response(), path, '127.0.0.1', true), true);
  assert.equal(guard.allow(request({ 'user-agent': 'Googlebot' }), response(), '/api/realtime', 'public-ip'), true);
  assert.equal(guard.allow(request({ 'user-agent': 'Googlebot' }), response(), '/profile/197964', 'public-ip'), true);
});

test('browser downloads require a same-site referring page', () => {
  const guard = createApiProtection();
  const denied = response();
  assert.equal(guard.allow(request(), denied, '/api/match-replay', 'public-ip'), false);
  const allowed = response();
  assert.equal(guard.allow(request({ referer: 'https://aoe2cn.cc/profile/197964', 'x-aoe2-client': undefined }), allowed, '/api/match-replay', 'public-ip'), true);
  allowed.end();
});

test('per-IP rate budget has independent minute and hour limits', () => {
  let clock = 0;
  const guard = createApiProtection({ now: () => clock });
  for (let minute = 0; minute < 5; minute++) {
    clock = minute * 60000;
    for (let index = 0; index < 2; index++) {
      const res = response(); assert.equal(guard.allow(request(), res, path, 'client'), true); res.end();
    }
    const denied = response(); assert.equal(guard.allow(request(), denied, path, 'client'), false);
    assert.equal(denied.status, 429); assert.equal(denied.headers['retry-after'], '60');
    assert.match(JSON.parse(denied.body).error, /每分钟最多2次、每小时最多10次/);
  }
  clock = 300000;
  const denied = response(); assert.equal(guard.allow(request(), denied, path, 'client'), false);
  assert.equal(denied.headers['retry-after'], '3300');
  clock = 3600000;
  const res = response(); assert.equal(guard.allow(request(), res, path, 'client'), true); res.end();
});

test('analysis slot is reserved for internal work and disconnect cannot bypass concurrency', () => {
  const guard = createApiProtection();
  const first = response();
  assert.equal(guard.allow(request(), first, path, 'first'), true);
  first.emit('close');
  const second = response();
  assert.equal(guard.allow(request(), second, path, 'second'), false);
  assert.equal(second.status, 429);
  assert.equal(guard.allow(request(), response(), path, '127.0.0.1', true), true);
  first.end();
  const third = response(); assert.equal(guard.allow(request(), third, path, 'second'), true); third.end();
  assert.equal(guard.stats().activeHeavy, 0); assert.equal(guard.stats().activeAnalysis, 0);
});

test('rate-limit storage is bounded and inactive entries expire', () => {
  let clock = 0;
  const guard = createApiProtection({ maxEntries: 1, now: () => clock });
  assert.equal(guard.allow(request(), response(), '/api/profile-details', 'first'), true);
  assert.equal(guard.allow(request(), response(), '/api/profile-details', 'second'), false);
  clock = 3600000;
  assert.equal(guard.allow(request(), response(), '/api/profile-details', 'second'), true);
  assert.equal(guard.stats().trackedClients, 1);
});

test('per-IP quotas survive restart and status polling does not consume replay quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-quota-'));
  const options = { statePath: join(directory, 'quota.json'), now: () => 1000 };
  let guard = createApiProtection(options);
  try {
    for (let index = 0; index < 2; index++) {
      const res = response(); assert.equal(guard.allow(request(), res, path, 'client'), true); res.end();
    }
    await guard.flush(); guard = createApiProtection(options);
    const blocked = response(); assert.equal(guard.allow(request(), blocked, path, 'client'), false);
    assert.equal(blocked.status, 429);
    assert.equal(guard.allow(request(), response(), '/api/replay-analysis/status', 'client'), true);
    await guard.flush();
    // Let the debounced write settle before removing its directory.
    await new Promise(resolve => setTimeout(resolve, 250)); await guard.flush();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
