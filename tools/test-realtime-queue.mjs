import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeService } from '../server/services/realtime-service.js';

for (const removeFirst of [true, false]) test(`opponent cancellation retains unmonitored premade teammates, removal first=${removeFirst}`, async () => {
  const sockets=[];
  class Socket { constructor(url){this.url=url;this.readyState=1;this.handlers={};sockets.push(this);} addEventListener(t,h){this.handlers[t]=h;} close(){this.readyState=3;} }
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>null,forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets(['209118']);
  const socket=sockets.find(s=>s.url.includes('handler=queueing'));
  const send=rows=>socket.handlers.message({data:JSON.stringify(rows)});
  const party=[{profileId:209118,name:'Sora Kuma'},{profileId:99,name:'Teammate'}];
  send([{type:'queueingAdded',data:{id:'party',status:'queueing',players:party}}]);
  if(removeFirst) send([{type:'queueingRemoved',data:{id:'party',reason:'matched'}}]);
  send([{type:'queueingAdded',data:{id:'match',status:'matched',matchId:522416000,players:[...party.map(p=>({...p,team:1})),{profileId:100,name:'Random teammate',team:1},{profileId:15355778,name:'Opponent',team:2}]}}]);
  // Partial updates must retain the original party until cancellation.
  send([{type:'queueingUpdated',data:{id:'match',mapName:'Arabia'}}]);
  send([{type:'queueingRemoved',data:{id:'match',reason:'cancelled',profileIds:[15355778]}}]);
  const state=(await service.refreshRealtimePayload(['209118'])).states[0];
  assert.equal(state.status,'queueing');
  assert.equal(state.queue.syntheticRequeue,true);
  assert.deepEqual(state.queue.players.map(p=>p.profileId),[209118,99]);
  assert.equal(state.queue.players[1].name,'Teammate');
});

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
  assert.equal(cancelledByOpponent.status,'queueing');
  assert.equal(cancelledByOpponent.queue.id,'m3');
  assert.equal(cancelledByOpponent.queue.syntheticRequeue,true);
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
  send([{type:'queueingRemoved',data:{id:'q6',reason:'started'}}]);
  const syntheticMatched=await state();
  assert.equal(syntheticMatched.status,'matched');
  assert.equal(syntheticMatched.queue.id,'q6');
  assert.equal(syntheticMatched.queue.syntheticMatched,true);
  send([{type:'queueingAdded',data:{id:'q7',status:'queueing',partyLeaderProfileId:88,players:[{profileId:42},{profileId:88},{profileId:99},{profileId:100}]}}]);
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
  send([{type:'queueingAdded',data:{id:'m_unattributed',status:'matched',matchId:100,matchedAt:new Date().toISOString()}}]);
  const diagnostics=service.getRealtimeStatus().queueing;
  assert.equal(diagnostics.connected,true);
  assert.equal(diagnostics.unattributedMatchedEvents,1);
  assert.ok(diagnostics.lastMessageAt);
  assert.equal((await state()).queue,undefined);
  send([{type:'queueingUpdated',data:{id:'m_unattributed',status:'matched',matchId:100,players:[{profileId:42},{profileId:88}]}}]);
  assert.equal((await state()).status,'matched');

  const timestamp = seconds => new Date(Date.now() + seconds * 1000).toISOString();
  const matchedAt = timestamp(-20);
  send([{type:'queueingRemoved',data:{id:'m_unattributed',reason:'started'}},
    {type:'queueingAdded',data:{id:'old-party',status:'queueing',queueingSince:timestamp(-60),players:[{profileId:42}]}},
    {type:'queueingAdded',data:{id:'match-without-removal',status:'matched',matchId:101,matchedAt,players:[{profileId:42}]}}]);
  assert.equal((await state()).queue.id,'match-without-removal');
  assert.equal(service.getRealtimeStatus().queueing.entries,1);
  send([{type:'queueingAdded',data:{id:'new-party',status:'queueing',queueingSince:timestamp(-5),players:[{profileId:42}]}},
    {type:'queueingUpdated',data:{id:'match-without-removal',mapImageUrl:'/rm_arena.png'}}]);
  assert.equal((await state()).queue.id,'new-party');
});

test('confirmed game removes older queue without waiting for expiry, but a newer queue still wins', async () => {
  const sockets=[];
  class Socket { constructor(url){this.url=url;this.readyState=1;this.handlers={};sockets.push(this)} addEventListener(t,h){this.handlers[t]=h}close(){this.readyState=3} }
  const started=Math.floor(Date.now()/1000)-60;
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache')},writeFile:async()=>{},localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>({id:900,started,finished:0,live:true,players:[{id:42},{id:43}]}),forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets(['42','43']);
  const queues=sockets.filter(s=>s.url.includes('handler=queueing'));
  const send=(id,at,status='queueing',matchId=null)=>{
    for(const socket of queues)socket.handlers.message({data:JSON.stringify([{type:'queueingAdded',data:{id,status,matchId,queueingSince:new Date(at*1000).toISOString(),players:[{profileId:42},{profileId:43}]}}])});
  };
  const states=async()=> (await service.refreshRealtimePayload(['42','43'])).states;
  send('old-queue',started-100);
  assert.ok((await states()).every(s=>s.status==='game'));
  assert.equal(service.getRealtimeStatus().queueing.entries,0);
  // Deleting one member must not recreate or retain the other group's queue.
  assert.ok((await states()).every(s=>s.status==='game'));
  send('new-queue',started+30);
  assert.ok((await states()).every(s=>s.status==='queueing'));
  for(const socket of queues)socket.handlers.message({data:JSON.stringify([{type:'queueingRemoved',data:{id:'new-queue',reason:'started'}}])});
  send('same-match',started+30,'matched',900);
  assert.ok((await states()).every(s=>s.status==='game'));
  assert.equal(service.getRealtimeStatus().queueing.entries,0);
});
