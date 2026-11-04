import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeService } from '../server/services/realtime-service.js';

test('queue states apply only to monitored players, merge maps, and clear on removal', async () => {
  const sockets = [];
  class Socket {
    constructor(url) { this.url = url; this.handlers = {}; this.readyState = 1; sockets.push(this); }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    close() { this.readyState = 3; }
  }
  const service = createRealtimeService({ WebSocket: Socket, readFile: async () => { throw new Error('no cache'); }, writeFile: async () => {},
    localProfileDetails: () => null, getMediaCache: async () => ({ live: [] }), loadRlReference: async () => new Map(),
    fetchPersonalLeaderboardStats: async () => [], fetchLatestWorldsEdgeMatchOnce: async () => null,
    forceChinaCountry: (_, country) => country });
  await service.startRealtimeWebSockets(['42']);
  const socket = sockets.find(s => s.url.includes('handler=queueing'));
  const send = rows => socket.handlers.message({ data: JSON.stringify(rows) });
  const state = async () => (await service.refreshRealtimePayload(['42'])).states[0];
  send([{ type: 'queueingAdded', data: { id: 'q1', status: 'queueing', partyLeaderProfileId: 42, players: [{ profileId: 42 }, { profileId: 99 }] } }]);
  assert.equal((await state()).status, 'queueing');
  send([{ type: 'queueingRemoved', data: { id: 'q1', reason: 'matched' } }, { type: 'queueingAdded', data: { id: 'm1', status: 'matched', matchId: 1, players: [{ profileId: 42, team: 0 }, { profileId: 88, team: 1 }] } }]);
  const before = await state(); assert.equal(before.status, 'matched');
  assert.equal(before.queue.mapName,undefined);
  send([{ type: 'queueingUpdated', data: { id: 'm1', mapImageUrl: '/rm_arena.png' } }]);
  const after = await state(); assert.equal(after.queue.mapImageUrl, '/rm_arena.png'); assert.equal(after.queue.displaySeed, before.queue.displaySeed);
  send([{ type: 'queueingRemoved', data: { id: 'm1', reason: 'started' } }]);
  assert.equal((await state()).queue, undefined);
  send([{type:'queueingAdded',data:{id:'m2',status:'matched',matchId:2,players:[{profileId:42},{profileId:88}]}},
    {type:'queueingRemoved',data:{id:'m2',reason:'cancelled',profileIds:[42]}}]);
  assert.equal((await state()).status,'cancelled');
  assert.equal((await state()).queueGrace,undefined);
  assert.equal((await state()).cancellation.players.length,2);
  assert.equal((await state()).status,'cancelled');
  send([{type:'queueingRemoved',data:{id:'unrelated',reason:'expired'}}]);
  assert.equal((await state()).status,'cancelled');
  send([{type:'queueingAdded',data:{id:'q3',status:'queueing',players:[{profileId:42}]}}]);
  assert.equal((await state()).status,'queueing');
  send([{type:'queueingRemoved',data:{id:'q3',reason:'matched'}},
    {type:'queueingAdded',data:{id:'m3',status:'matched',matchId:3,players:[{profileId:42},{profileId:88}]}},
    {type:'queueingRemoved',data:{id:'m3',reason:'cancelled',profileIds:[88]}}]);
  assert.notEqual((await state()).status,'cancelled');
  const cancelledByOpponent = await state();
  assert.equal(cancelledByOpponent.status,'offline');
  assert.equal(cancelledByOpponent.queueGrace.queueId,'m3');
  assert.ok(cancelledByOpponent.graceUntil > Date.now()+299000);
  send([{type:'queueingAdded',data:{id:'m4',status:'matched',matchId:4,players:[{profileId:42},{profileId:88}]}},
    {type:'queueingRemoved',data:{id:'m4',reason:'cancelled'}}]);
  assert.notEqual((await state()).status,'cancelled');
  assert.equal((await state()).queueGrace.queueId,'m4');
  assert.ok((await state()).graceUntil > Date.now()+299000);
  send([{type:'queueingAdded',data:{id:'q5',status:'queueing',players:[{profileId:42}]}}]);
  send([{type:'queueingRemoved',data:{id:'q5',reason:'timeout'}}]);
  const grace = await state();
  assert.equal(grace.status,'offline');
  assert.equal(grace.queue,undefined);
  assert.ok(grace.graceUntil > Date.now()+299000);
  assert.equal(grace.queueGrace.queueId,'q5');
  send([{type:'queueingAdded',data:{id:'q6',status:'queueing',players:[{profileId:42}]}}]);
  assert.equal((await state()).status,'queueing');
  assert.equal((await state()).queueGrace,undefined);
  send([{type:'queueingRemoved',data:{id:'q6',reason:'started'}},
    {type:'queueingAdded',data:{id:'q7',status:'queueing',partyLeaderProfileId:88,players:[{profileId:42},{profileId:88},{profileId:99},{profileId:100}]}}]);
  send([{type:'queueingRemoved',data:{id:'q7',reason:'left',profileIds:[88,'99']}}]);
  const retained=await state();
  assert.equal(retained.status,'queueing');
  assert.deepEqual(retained.queue.players.map(p=>p.profileId),[42,100]);
  assert.equal(retained.queue.partyLeaderProfileId,null);
  assert.equal(retained.queueGrace,undefined);
  send([{type:'queueingUpdated',data:{id:'q7',lastSeen:'2026-11-04T12:00:00Z'}}]);
  assert.equal((await state()).status,'queueing');
  send([{type:'queueingRemoved',data:{id:'q7',reason:'left',profileIds:[42]}}]);
  const departed=await state();
  assert.equal(departed.status,'offline');
  assert.ok(departed.graceUntil>Date.now()+299000);
  send([{type:'queueingRemoved',data:{id:'q7',reason:'left',profileIds:[42]}}]);
  assert.equal((await state()).graceUntil,departed.graceUntil);
  send([{type:'queueingRemoved',data:{id:'q7',reason:'timeout'}},
    {type:'queueingAdded',data:{id:'q8',status:'queueing',players:[{profileId:42},{profileId:88}]}}]);
  send([{type:'queueingRemoved',data:{id:'q8',reason:'left'}}]);
  assert.equal((await state()).status,'offline');
  assert.equal((await state()).queue,undefined);
});
