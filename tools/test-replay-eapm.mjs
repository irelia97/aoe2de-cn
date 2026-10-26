import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as shared from '../public/replay-eapm.js';
import { collectEffectiveActionTimes, replayEapmStats, rollingEapm, globalEapmAt } from '../public/replay-eapm.js';

const players = [{ player_number: 1 }, { player_number: 2 }];
const op = (time, type = 'Move', data = {}) => ({ Action: { world_time: time, action_data: { [type]: { player_id: 1, ...data } } } });
const full = operations => ({ chapters: [{ operations }] });

test('all commands use a sliding 500 real ms repeat window', () => {
  for (const type of ['Move','Interact','Stop','DeQueue','Queue','Multiqueue','Buy','Sell','Research','ToggleGate','SwitchAttack','Transform']) {
    const result = collectEffectiveActionTimes(full([0, 200, 400, 850, 1700, 2551].map(t => op(t, type, { unit_id: 83 }))), players, 6000);
    assert.deepEqual(result.get('1'), [0, 2551], type);
  }
});

test('real 500 ms maps to recording speed including the inclusive boundary', () => {
  assert.equal(shared.EAPM_REPEAT_REAL_MS,500);
  for (const speed of [1, 1.5, 1.7, 2]) {
    const boundary = 500 * speed;
    const result = collectEffectiveActionTimes(full([op(0), op(boundary), op(2 * boundary + 1)]), players, 10000, speed);
    assert.deepEqual(result.get('1'), [0, 2 * boundary + 1]);
  }
  assert.equal(shared.replayGameSpeed({ header: { game_settings: { speed: 2 }, game_speed: 1.7 } }), 2);
  assert.equal(shared.replayGameSpeed({ header: { game_speed: 1.5 } }), 1.5);
  assert.equal(shared.replayGameSpeed({ header: { replay: { game_speed: 1 } } }), 1);
  assert.equal(shared.replayGameSpeed({}), 1.7);
});

test('AB, ABC and longer command loops are suppressed independently for each player', () => {
  for (const length of [2, 3, 8]) {
    const operations = [];
    for (let cycle = 0; cycle < 4; cycle++) for (let i = 0; i < length; i++) {
      operations.push(op(cycle * 800 + i * 50, 'Move', { x: i, y: 1 }));
    }
    operations.push(op(900, 'Move', { player_id: 2, x: 0, y: 1 }));
    const result = collectEffectiveActionTimes(full(operations), players, 4000);
    assert.equal(result.get('1').length, length);
    assert.deepEqual(result.get('2'), [900]);
  }
});

test('changed targets, coordinates or production amount count and a quiet gap ends suppression', () => {
  const result = collectEffectiveActionTimes(full([
    op(0, 'DeQueue', { unit_id: 83, amount: 1 }),
    op(100, 'DeQueue', { unit_id: 83, amount: 5 }),
    op(200, 'Move', { x: 1 }), op(300, 'Move', { x: 2 }),
    op(400, 'Interact', { target_id: 1 }), op(500, 'Interact', { target_id: 2 }),
    op(1901, 'Move', { x: 1 }),
  ]), players, 2000);
  assert.deepEqual(result.get('1'), [0, 100, 200, 300, 400, 500, 1901]);
});

test('canonical property order cannot bypass dedup and chapter events are sorted before counting', () => {
  const result = collectEffectiveActionTimes({ chapters: [
    { operations: [op(200, 'Move', { x: 1, y: 2 })] },
    { operations: [op(0, 'Move', { y: 2, x: 1 })] },
  ] }, players, 1000);
  assert.deepEqual(result.get('1'), [0]);
});

test('executor order, packet length and redundant selection count do not inflate eAPM', () => {
  for (const field of ['unit_ids','building_ids','object_ids']) {
    const first = { [field]: [30, 2, 10], selected: 3, action_length: 30, x: 1, y: 2 };
    const second = { [field]: [10, 30, 2], action_length: 50, x: 1, y: 2 };
    assert.deepEqual(collectEffectiveActionTimes(full([op(0, 'Move', first), op(800, 'Move', second)]), players, 3000).get('1'), [0]);
    assert.deepEqual(first[field], [30, 2, 10]);
  }
});

test('different actors, flags, modes and unknown bytes remain distinct', () => {
  for (const [first, second] of [
    [{ unit_ids: [1,2] }, { unit_ids: [1,3] }],
    [{ unit_ids: [], selected: -1 }, { unit_ids: [], selected: 0 }],
    [{ mode: 1 }, { mode: 2 }],
    [{ queued: true }, { queued: false }],
    [{ data: [1,2] }, { data: [2,1] }],
    [{ unknown1: 1 }, { unknown1: 2 }],
    [{ x: 1, y: 2 }, { x: 1.001, y: 2 }],
  ]) {
    assert.deepEqual(collectEffectiveActionTimes(full([op(0, 'Move', first), op(100, 'Move', second)]), players, 1000).get('1'), [0,100]);
  }
});

test('ignore invalid time, unknown players, AI/system messages and actions past the end', () => {
  const result = collectEffectiveActionTimes(full([
    op(-1), op(null), op(NaN), op(Infinity), op(60001),
    op(1, 'AiMove'), op(2, 'Resign'), op(3, 'Unknown44'), op(4, 'Save'),
    op(5, 'Move', { player_id: 9 }), op(0), op(60000, 'Stop'),
  ]), players, 60000);
  assert.deepEqual(result.get('1'), [0, 60000]);
});

test('interface clicks, selection and camera records cannot inflate effective command counts', () => {
  const operations = [];
  for (let i = 0; i < 30; i++) {
    operations.push({ Camera: { world_time: i * 10, player_id: 1, x: i % 3, y: 1 } });
    for (const type of ['Camera','View','Selection','Click']) operations.push(op(i * 10, type));
    operations.push(op(i * 10, 'Move', { x: 1, y: 1 }));
  }
  // UI records (when supplied) are not player commands. Only the actual move
  // contributes, and all repetitions of that command collapse to one.
  assert.deepEqual(collectEffectiveActionTimes(full(operations), players, 1000).get('1'), [0]);
});

test('supported player command variants are included once each', () => {
  const variants = ['Stop','Waypoint','Guard','Follow','Queue','Multiqueue','Release','Repair',
    'DropRelic','SwitchAttack','ToggleGate','TownBell','Tribute','Autoscout'];
  assert.equal(collectEffectiveActionTimes(full(variants.map((type, i) => op(i * 500, type))), players, 10000).get('1').length, variants.length);
});

test('average and peak exclude out-of-range times and use game minutes without speed conversion', () => {
  assert.deepEqual(replayEapmStats([-1, NaN, Infinity, 0, 1000, 60000, 60001], 60000), { peak: 2, global: 3 });
  assert.deepEqual(replayEapmStats([0, 1], 0), { peak: 0, global: 0 });
  assert.equal(replayEapmStats([0, 500], 500).global, 240);
  assert.equal(globalEapmAt([0, 500, 600], 500), 240);
  assert.equal(globalEapmAt([0], Infinity), 0);
  assert.equal(rollingEapm([0, 30000, 60000], 60000), 2);
  assert.equal(rollingEapm([0, 30000, 60000], 30000), 2);
});

test('player table uses the same eAPM as the curve and notification, including stop-only players', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let replayEapmModule'), source.indexOf('const replayUnitInfoById'));
  const recording = full([op(0), op(200), op(400), op(500, 'DeQueue', { unit_id: 83 }),
    op(600, 'DeQueue', { unit_id: 83 }), op(1000, 'Stop', { player_id: 2 }), op(61000)]);
  const context = vm.createContext({ shared, recording, players });
  const table = vm.runInContext(code + '\nreplayEapmModule=shared; replayPlayerStats(recording,60000,players)', context);
  const actions = shared.collectEffectiveActionTimes(recording, players, 60000);
  for (const player of players) {
    const id = String(player.player_number);
    assert.equal(table.get(id).eapm, shared.replayEapmStats(actions.get(id), 60000).global);
  }
  assert.equal(table.get('1').eapm, 2);
  assert.equal(table.get('2').eapm, 1);
});
