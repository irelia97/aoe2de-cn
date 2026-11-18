import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaVideoStateStore } from '../server/services/media-video-state.js';

test('video scheduler resumes the saved round and migrates the old schedule', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aoe2-video-state-'));
  const file = join(dir, 'state.json');
  const now = () => Date.parse('2026-11-18T00:00:00Z');
  const first = createMediaVideoStateStore(file, { now });
  try {
    const load = first.load();
    assert.equal(first.load(), load);
    await load;
    assert.equal(first.state.nextRequestAt, Date.parse('2026-11-18T00:30:00Z'));
    Object.assign(first.state, { cycleActive: true, cycleOrder: ['bilibili:42'], blockedUntil: now() + 60_000 });
    first.state.cycleSeen.add('bilibili:42');
    first.state.sources.set('bilibili:42', { nextCheckAt: now(), lastAttemptAt: now(), lastSuccessAt: 0, failureCount: 2, idleSuccesses: 0 });
    await first.save();

    const restarted = createMediaVideoStateStore(file, { now });
    await restarted.load();
    assert.deepEqual(restarted.state, first.state);

    const old = JSON.parse(await readFile(file, 'utf8'));
    delete old.scheduleVersion;
    await writeFile(file, JSON.stringify(old));
    const migrated = createMediaVideoStateStore(file, { now });
    await migrated.load();
    assert.equal(migrated.state.cycleActive, false);
    assert.deepEqual(migrated.state.cycleOrder, []);
    assert.equal(migrated.state.cycleSeen.size, 0);
    assert.equal(migrated.state.sources.get('bilibili:42').nextCheckAt, 0);
    assert.equal(migrated.state.blockedUntil, first.state.blockedUntil);
  } finally {
    await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(dir);
  }
});
