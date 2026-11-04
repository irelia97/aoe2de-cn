import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeRecovery} from '../server/services/realtime-recovery.js';
import {createRealtimeService} from '../server/services/realtime-service.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('missing players recover one shared match without rechecking players already found',async()=>{
  const active=new Set(),calls=[];
  const recovery=createRealtimeRecovery({hasState:id=>active.has(id),fetchLatest:async id=>{calls.push(id);return{id:123};},ingest:()=>{active.add('1');active.add('2');return true;}});
  recovery.enqueue(['1','2']);await flush();
  assert.deepEqual(calls,['1']);assert.deepEqual([...active],['1','2']);
});
test('recovery ignores results from obsolete pools',async()=>{
  let resolve;
  const ingested=[];
  const recovery=createRealtimeRecovery({hasState:()=>false,fetchLatest:()=>new Promise(done=>{resolve=done;}),ingest:(id,match)=>{ingested.push(match.id);return true;}});
  recovery.enqueue(['1']);await flush();recovery.reset();resolve({id:456});await flush();assert.deepEqual(ingested,[]);
  recovery.enqueue(['2']);await flush();resolve({id:789});await flush();assert.deepEqual(ingested,[789]);
});
test('fresh socket connection recovers an ongoing game absent from the persisted payload',async()=>{
  const sockets=[];
  class Socket{constructor(url){this.url=url;this.handlers={};this.readyState=1;sockets.push(this);}addEventListener(key,fn){this.handlers[key]=fn;}close(){}}
  const match={id:123,started:Math.floor(Date.now()/1000)-100,finished:0,rms:'African Clearing',players:[{id:42,name:'Yo'},{id:43,name:'Other'}]};
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},localProfileDetails:()=>null,
    getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],forceChinaCountry:(_,c)=>c,
    fetchLatestWorldsEdgeMatchOnce:async()=>match});
  await service.startRealtimeWebSockets(['42']);
  sockets.find(s=>s.url.includes('handler=match-updated')).handlers.open();await flush();
  await new Promise(resolve=>setTimeout(resolve,400));
  const payload=await service.getCachedPayload(['42']);
  assert.equal(payload.states[0].status,'game');assert.equal(payload.states[0].match.id,123);
});

test('lobby departures and queue started events do not trigger recovery lookups',async()=>{
  const sockets=[];let lookups=0;
  class Socket{constructor(url){this.url=url;this.handlers={};this.readyState=1;sockets.push(this);}addEventListener(key,fn){this.handlers[key]=fn;}close(){}}
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},localProfileDetails:()=>null,
    getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],forceChinaCountry:(_,c)=>c,
    fetchLatestWorldsEdgeMatchOnce:async()=>{lookups++;return null;}});
  await service.startRealtimeWebSockets(['42']);
  const send=(handler,rows)=>sockets.find(socket=>socket.url.includes('handler='+handler)).handlers.message({data:JSON.stringify(rows)});
  send('lobbies',[{type:'lobbyAdded',data:{matchId:123,name:'Room'}},{type:'slotAdded',data:{matchId:123,slot:0,profileId:42}},{type:'slotRemoved',data:{matchId:123,slot:0}},{type:'lobbyRemoved',data:{matchId:123}}]);
  send('queueing',[{type:'queueingAdded',data:{id:'q1',status:'queueing',players:[{profileId:42}]}},{type:'queueingRemoved',data:{id:'q1',reason:'started',matchId:123}}]);
  await flush();assert.equal(lookups,0);
  sockets.find(socket=>socket.url.includes('handler=match-updated')).handlers.open();await flush();assert.equal(lookups,1);
});
