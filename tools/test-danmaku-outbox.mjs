import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queueDanmakuMatch } from '../server/services/danmaku-outbox.js';

test('automatic match events survive process handoff without sending chat in the web process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'danmaku-outbox-'));
  try {
    const match = { id: 123, started: 100, players: [{ profileId: 197964 }] };
    await queueDanmakuMatch(directory, match);
    assert.deepEqual(JSON.parse(await readFile(join(directory, '123.json'), 'utf8')), match);
    await queueDanmakuMatch(directory, { ...match, finished: 1234 });
    await queueDanmakuMatch(directory, { ...match, id: '../escape' });
    assert.deepEqual(await readdir(directory), ['123.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
