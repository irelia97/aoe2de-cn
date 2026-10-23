import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRealtimeService } from '../server/services/realtime-service.js';

test('new match queries only its two players and notifies without global enrichments', async () => {
  const sockets=[], queries=[], notifications=[], stages=[];
  class Socket {
    constructor(){this.handlers={};sockets.push(this);}
    addEventListener(type,handler){this.handlers[type]=handler;}
    close(){}
  }
  let resolveNotification;
  const notified=new Promise(resolve=>{resolveNotification=resolve;});
  const service=createRealtimeService({
    notificationProfileIds:['197964'],WebSocket:Socket,
    readFile:async()=>{throw new Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>null,forceChinaCountry:(_id,country)=>country,
    getMediaCache:()=>new Promise(()=>{}), // Global update deliberately never finishes.
    onMatchPreparing:()=>{stages.push('prepare');},
    fetchPersonalLeaderboardStats:async id=>{stages.push('rating');queries.push(id);return [{id:3,rating:id==='197964'?2800:2700},{id:4,rating:999}];},
    onMatchAdded:async match=>{notifications.push(match);resolveNotification();}
  });
  await service.startRealtimeWebSockets(['197964','42','99']);
  const match={matchId:123,started:Math.floor(Date.now()/1000),mapName:'Arabian Desert',server:'southeastasia',players:[{profileId:197964,name:'Yo'},{profileId:42,name:'Blve'}]};
  const event={data:JSON.stringify({type:'matchAdded',data:match})};
  sockets[0].handlers.message(event);
  await Promise.race([notified,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('notification blocked')),1000);t.unref();})]);
  sockets[0].handlers.message(event);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(queries.sort(),['197964','42']);
  assert.deepEqual(stages,['prepare','rating','rating']);
  assert.equal(notifications.length,1);
  assert.equal(notifications[0].map,'Arabian Desert');
  assert.equal(notifications[0].server,'southeastasia');
  assert.deepEqual(notifications[0].players.map(p=>[p.name,p.rating]),[['Yo',2800],['Blve',2700]]);
});

test('team opening reaches the notification hook once with all players', async () => {
  const sockets = [], notified = [];
  class Socket { constructor() { this.handlers = {}; sockets.push(this); } addEventListener(type, handler) { this.handlers[type] = handler; } close() {} }
  let done;
  const completed = new Promise(resolve => { done = resolve; });
  const service = createRealtimeService({ notificationProfileIds: ['197964'], WebSocket: Socket,
    readFile: async () => { throw new Error('no cache'); }, writeFile: async () => {},
    localProfileDetails: () => null, forceChinaCountry: (_id, country) => country,
    getMediaCache: () => new Promise(() => {}), fetchPersonalLeaderboardStats: async () => [{ id: 3, rating: 2000 }],
    onMatchAdded: async match => { notified.push(match); done(); } });
  await service.startRealtimeWebSockets(['197964']);
  const match = { matchId: 123, started: Math.floor(Date.now() / 1000), mapName: 'Arabia', server: 'eastasia',
    players: [197964, 42, 43, 44].map(profileId => ({ profileId, name: String(profileId) })) };
  const event = { data: JSON.stringify({ type: 'matchAdded', data: match }) };
  sockets[0].handlers.message(event);
  await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('team hook blocked')), 1000); timer.unref(); })]);
  sockets[0].handlers.message(event); await new Promise(resolve => setImmediate(resolve));
  assert.equal(notified.length, 1); assert.equal(notified[0].players.length, 4);
});
