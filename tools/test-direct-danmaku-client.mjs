import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createDirectDanmakuClient } from '../server/services/direct-danmaku-client.js';
import { createRealtimeDanmakuNotifier } from '../server/services/realtime-danmaku-notifier.js';

function fakeSpawn(handler) {
  return (_python, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    let input = '';
    child.stdin = new Writable({ write(data, _encoding, done) { input += data; done(); }, final(done) {
      done(); setImmediate(() => handler(child, args, JSON.parse(input)));
    } });
    return child;
  };
}

test('direct client formats openings and sends a single acknowledged batch without a browser', async () => {
  const modes = [];
  const client = createDirectDanmakuClient({ room: '753676', statePath: 'private', spawnImpl: fakeSpawn((child, args, payload) => {
    const mode = args[args.indexOf('--mode') + 1]; modes.push(mode);
    if (mode === 'format-start') child.stdout.write(JSON.stringify(['start', 'map']) + '\n');
    else payload.messages.forEach((_message, index) => child.stdout.write(JSON.stringify({ part: index + 1, res: '0' }) + '\n'));
    child.emit('close', 0);
  }) });
  await client.start(); assert.deepEqual(modes, []);
  assert.deepEqual(await client.formatStart({ id: 1 }, '197964'), ['start', 'map']);
  const result = await client.send(['start', 'map']);
  assert.equal(result.stdout, 'DANMAKU_SENT {"index":0}\nDANMAKU_SENT {"index":1}');
  assert.deepEqual(modes, ['format-start', 'send']);
});

test('direct rejection preserves partial receipts and is terminal', async () => {
  const client = createDirectDanmakuClient({ room: '753676', statePath: 'private', spawnImpl: fakeSpawn(child => {
    child.stdout.write('{"part":1,"res":"0"}\n{"part":2,"res":"356"}\n'); child.emit('close', 1);
  }) });
  await assert.rejects(client.send(['one', 'two']), error => error.terminal && /356/.test(error.message) && /index":0/.test(error.stdout));
});

test('automatic openings use command format, merge duplicate events, and persist per-match dedup', async () => {
  let state = '{}', sends = 0, formats = 0;
  const sender = { noRetry: true, messageLimit: 60, formatStart: async () => { formats++; return ['teams', 'map, 组排, 东南亚']; }, send: async parts => {
    sends++; assert.deepEqual(parts, ['teams', 'map, 组排, 东南亚']); return {};
  } };
  const deps = { statePath: 'unused', readFile: async () => state, writeFile: async (_path, value) => { state = value; },
    residentSender: sender, watchers: [{ profileId: '197964', platform: 'douyu', room: '753676' }] };
  const game = { id: 1, players: [{ id: '197964' }, { id: '2' }, { id: '3' }, { id: '4' }] };
  let notifier = createRealtimeDanmakuNotifier(deps);
  await Promise.all([notifier.handleMatchAdded(game), notifier.handleMatchAdded(game)]);
  await notifier.handleMatchAdded({ ...game, id: 2 });
  notifier = createRealtimeDanmakuNotifier(deps);
  await notifier.handleMatchAdded(game);
  assert.equal(sends, 2); assert.equal(formats, 2);
});

test('an attempted direct send is never retried, including after service restart', async () => {
  let state = '{}', sends = 0;
  const deps = { statePath: 'unused', readFile: async () => state, writeFile: async (_path, value) => { state = value; },
    residentSender: { noRetry: true, messageLimit: 60, send: async () => { sends++; throw new Error('uncertain'); } },
    watchers: [{ profileId: '197964', platform: 'douyu', room: '753676' }] };
  const game = { id: 1, players: [{ id: '197964' }, { id: '2' }] };
  let notifier = createRealtimeDanmakuNotifier(deps);
  await assert.rejects(notifier.handleMatchEnded(game, '197964', 'summary'), error => error.terminal);
  notifier = createRealtimeDanmakuNotifier(deps);
  await notifier.handleMatchEnded(game, '197964', 'summary');
  assert.equal(sends, 1);
});

test('attempt marker is atomically committed before automatic sending', async () => {
  let state = '{}', temporary = '';
  const notifier = createRealtimeDanmakuNotifier({ statePath: 'state.json', readFile: async () => state,
    writeFile: async (path, value) => { assert.equal(path, 'state.json.tmp'); temporary = value; },
    renameFile: async (from, to) => { assert.equal(from, 'state.json.tmp'); assert.equal(to, 'state.json'); state = temporary; },
    residentSender: { noRetry: true, send: async () => {
      assert.equal(JSON.parse(state)['douyu:753676:197964:ended:123'].attemptedMatchId, '123'); return {};
    } }, watchers: [{ profileId: '197964', platform: 'douyu', room: '753676' }] });
  await notifier.handleMatchEnded({ id: 123, players: [{ id: 197964 }, { id: 42 }] }, '197964', 'summary');
});
