import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAvatarCache, AVATAR_TTL } from '../server/services/avatar-cache.js';

test('avatar bytes persist, refresh only after 24 hours, merge requests and retain stale data on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aoe-avatar-'));
  let time = 1000;
  let calls = 0;
  let failed = false;
  const options = {
    directory, now: () => time,
    resolveUrl: async () => { calls++; return `https://avatars.steamstatic.com/${calls}.jpg`; },
    fetchImage: async () => {
      if (failed) throw new Error('offline');
      return new Response(`image ${calls}`, { headers: { 'content-type': 'image/jpeg' } });
    }
  };
  let cache = createAvatarCache(options);
  try {
    const [first, duplicate] = await Promise.all([cache.get('steam:12345678901234567'), cache.get('steam:12345678901234567')]);
    assert.equal(calls, 1);
    assert.equal(first.hash, duplicate.hash);
    assert.equal((await cache.image(first.hash)).toString(), 'image 1');
    time += AVATAR_TTL - 1;
    await cache.refreshDue();
    assert.equal((await cache.get(first.key)).hash, first.hash);
    assert.equal(calls, 1);
    cache.close();
    cache = createAvatarCache(options);
    assert.equal((await cache.get(first.key)).hash, first.hash);
    assert.equal(calls, 1);
    time++;
    await cache.refreshDue();
    const second = await cache.get(first.key);
    assert.equal(calls, 2);
    assert.notEqual(first.hash, second.hash);
    assert.equal((await cache.image(first.hash)).toString(), 'image 1');
    time += AVATAR_TTL;
    failed = true;
    assert.equal((await cache.get(first.key)).hash, second.hash);
    await cache.refreshDue();
    assert.equal(calls, 3);
    time += 5 * 60_000;
    failed = false;
    await cache.refreshDue();
    assert.equal(calls, 4);
    assert.equal(await cache.image('../escape'), null);
  } finally { cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('untrusted upstream URL cannot be fetched', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aoe-avatar-'));
  let fetched = false;
  const cache = createAvatarCache({ directory, resolveUrl: async () => 'https://example.com/avatar', fetchImage: async () => { fetched = true; } });
  try {
    await assert.rejects(cache.get('profile:197964'), /头像地址不可用/);
    assert.equal(fetched, false);
  } finally { cache.close(); await rm(directory, { recursive: true, force: true }); }
});

test('expired avatars return immediately during a slow refresh and unreferenced old files are collected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aoe-avatar-stale-'));
  let time = Date.now(), release, calls = 0;
  const cache = createAvatarCache({ directory, now: () => time,
    resolveUrl: async () => 'https://avatars.steamstatic.com/image.jpg',
    fetchImage: async () => {
      calls++;
      if (calls === 2) await new Promise(resolve => { release = resolve; });
      return new Response(`image ${calls}`, { headers: { 'content-type': 'image/jpeg' } });
    } });
  try {
    const original = await cache.get('profile:1');
    time += AVATAR_TTL + 1;
    const stale = await cache.get('profile:1');
    assert.equal(stale.hash, original.hash);
    assert.equal(cache.stats().staleHits, 1);
    await Promise.resolve(); release(); await cache.refreshDue();
    assert.notEqual((await cache.get('profile:1')).hash, original.hash);
    assert.ok(await cache.image(original.hash)); // Retirement starts a fresh grace period.
    const orphan = 'a'.repeat(64), path = join(directory, orphan);
    await writeFile(path, 'orphan');
    await utimes(path, new Date(time - AVATAR_TTL - 1), new Date(time - AVATAR_TTL - 1));
    await cache.refreshDue();
    assert.equal(await cache.image(orphan), null);
    assert.equal(cache.stats().evictions, 1);
  } finally { cache.close(); await rm(directory, { recursive: true, force: true }); }
});
