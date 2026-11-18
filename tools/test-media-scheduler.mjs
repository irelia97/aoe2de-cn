import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaScheduler } from '../server/services/media-scheduler.js';
import { createMediaVideoStateStore } from '../server/services/media-video-state.js';
import { nextScheduledVideoRound } from '../server/services/media-video-schedule.js';

test('media scheduler shares concurrent refreshes, completes a round and resumes at the next scheduled time', async t => {
  const now = Date.parse('2026-11-18T00:30:00Z');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const dir = await mkdtemp(join(tmpdir(), 'aoe2-schedule-'));
  const statePath = join(dir, 'state.json');
  const mediaVideoCachePath = join(dir, 'videos.json');
  const mediaLiveCachePath = join(dir, 'live.json');
  const store = createMediaVideoStateStore(statePath);
  const checked = [];
  const scheduler = createMediaScheduler({
    mediaCache: { data: { live: [], videos: [] } },
    mediaSources: { videos: [{ id: '1' }, { id: '2' }] }, mediaVideoState: store.state,
    mediaVideoPaused: () => false, loadPersistentMediaVideos: async () => {},
    loadPersistentMediaVideoState: store.load, savePersistentMediaVideoState: store.save,
    loadPersistentMediaLive: async () => {}, fetchMediaLive: async () => [],
    fetchMediaVideoSource: async source => { checked.push(source.id); return [{ id: source.id }]; },
    mediaVideoRequestGapMin: 100, mediaVideoRequestGapMax: 100,
    mediaLiveRoundTimeout: 90_000, mediaLiveRefreshInterval: 120_000,
    withMediaTimeout: work => work, dataDir: dir, mediaVideoCachePath, mediaLiveCachePath
  });
  try {
    await Promise.all([scheduler.refreshMediaCache(), scheduler.refreshMediaCache()]);
    assert.equal(checked.length, 1);
    t.mock.timers.setTime(now + 100);
    await scheduler.refreshMediaCache();
    assert.deepEqual([...checked].sort(), ['1', '2']);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.cycleActive, false);
    assert.deepEqual(saved.cycleSeen, []);
    assert.equal(Date.parse(saved.nextRequestAt), nextScheduledVideoRound(now + 101));
    assert.equal((await scheduler.getMediaCache()).videos.length, 2);
    assert.equal(checked.length, 2);
  } finally {
    t.mock.timers.reset();
    for (const path of [statePath, mediaVideoCachePath, mediaLiveCachePath]) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(dir);
  }
});
