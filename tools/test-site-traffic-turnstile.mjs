import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteTrafficTurnstile } from '../server/services/site-traffic-turnstile.js';

const keys = { siteKey: 'public-widget', secretKey: 'private-key' };

test('existing installs work without keys, partial configuration rejects even if Siteverify would accept', async () => {
  const disabled = createSiteTrafficTurnstile();
  assert.deepEqual(disabled.config, { required: false, siteKey: '' });
  assert.equal(await disabled.verify(), true);
  for (const partial of [{ siteKey: keys.siteKey }, { secretKey: keys.secretKey }]) {
    const guard = createSiteTrafficTurnstile({ ...partial, fetchImpl: () => assert.fail('unexpected Siteverify call') });
    assert.deepEqual(guard.config, { required: true, siteKey: '' });
    assert.equal(await guard.verify('token'), false);
  }
});

test('only a successful token for the sites and page-view action grants counting', async () => {
  let payload = {success: true, hostname: 'aoe2cn.cc', action: 'site_page_view'};
  let calls = 0;
  const guard = createSiteTrafficTurnstile({ ...keys, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.body.get('secret'), keys.secretKey);
    assert.equal(options.body.get('response'), 'token');
    return Response.json(payload);
  } });
  assert.deepEqual(guard.config, { required: true, siteKey: keys.siteKey });
  assert.equal(await guard.verify(), false);
  assert.equal(await guard.verify('x'.repeat(2049)), false);
  assert.equal(calls, 0);
  assert.equal(await guard.verify('token'), true);
  payload = {...payload, hostname: 'www.aoe2cn.cc'};
  assert.equal(await guard.verify('token'), true);
  payload = {...payload, action: 'another_action'};
  assert.equal(await guard.verify('token'), false);
  payload = {success: true, hostname: 'example.org', action: 'site_page_view'};
  assert.equal(await guard.verify('token'), false);
  payload = {success: false, 'error-codes': ['timeout-or-duplicate']};
  assert.equal(await guard.verify('token'), false);
});

test('verification failures close counting and the outbound concurrency limit recovers', async () => {
  const pending = [];
  const guard = createSiteTrafficTurnstile({ ...keys, fetchImpl: () => new Promise((_, reject) => pending.push(reject)) });
  const checks = Array.from({length: 8}, () => guard.verify('token'));
  assert.equal(await guard.verify('token'), false);
  assert.equal(pending.length, 8);
  pending.splice(0).forEach(reject => reject(new Error('unavailable')));
  assert.deepEqual(await Promise.all(checks), Array(8).fill(false));
  const retry = guard.verify('token');
  assert.equal(pending.length, 1);
  pending[0](new Error('unavailable'));
  assert.equal(await retry, false);
});
