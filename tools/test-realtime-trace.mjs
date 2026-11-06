import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeTrace } from '../server/services/realtime-trace.js';

test('published transitions log the player and old/new states without logging unchanged refreshes', () => {
  const lines = [];
  const trace = createRealtimeTrace({ now: () => 1000, write: line => lines.push(JSON.parse(line.slice('[realtime-trace] '.length))) });
  const state = { profileId: '347269', identity: '347269', status: 'queueing', queue: { id: 'q1' }, player: { name: 'Not logged' } };
  trace.publish({ states: [state] }, 'socket');
  assert.equal(lines.length, 1); assert.equal(lines[0].event, 'state-baseline');
  trace.publish({ states: [{ ...state, player: { rating: 3000 } }] }, 'socket');
  assert.equal(lines.length, 1);
  trace.publish({ states: [{ ...state, status: 'matched', queue: { id: 'q1', matchId: 123 } }] }, 'socket');
  trace.publish({ states: [{ profileId: '347269', status: 'game', match: { id: 123 } }] }, 'api');
  const change = lines.at(-1);
  assert.equal(change.profileId, '347269'); assert.equal(change.before.status, 'matched');
  assert.equal(change.after.status, 'game'); assert.equal(change.after.matchId, '123');
  assert.equal(change.source, 'api');
  assert.ok(!JSON.stringify(lines).includes('Not logged'));
  trace.publish({ states: [{ profileId: '347269', status: 'offline', graceUntil: 2000 }] }, 'socket');
  assert.equal(lines.at(-1).after.grace, true);
  trace.publish({ states: [] }, 'socket');
  assert.equal(lines.at(-1).event, 'state-removed');
});

test('validation preserves exact match ids, timing and inactive decision fields', () => {
  const lines = [];
  const trace = createRealtimeTrace({ write: line => lines.push(JSON.parse(line.slice('[realtime-trace] '.length))) });
  trace.validation({ reason: 'periodic', profileId: '347269', expected: { id: 123, started: 100 },
    latest: { id: 456, started: 50, finished: 90, abandoned: false, live: false, players: ['not logged'] },
    status: 'offline', decision: 'remove-different-match' });
  const log = lines[0];
  assert.equal(log.expectedMatchId, '123'); assert.equal(log.latestMatchId, '456');
  assert.equal(log.expectedStarted, 100); assert.equal(log.latestFinished, 90);
  assert.equal(log.latestStatus, 'offline'); assert.equal(log.latestLive, false);
  assert.equal(log.decision, 'remove-different-match'); assert.equal(log.profileId, '347269');
  assert.ok(!JSON.stringify(lines).includes('not logged'));
});
