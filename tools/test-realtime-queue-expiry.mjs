import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeService} from '../server/services/realtime-service.js';
for(const outcome of ['present','absent','error'])test(`silent queue is rechecked after five minutes: ${outcome}`,async t=>{
  let now=Date.now(),queries=0; t.mock.method(Date,'now',()=>now);
  const sockets=[];
  class Socket{constructor(url){this.url=url;this.readyState=1;this.handlers={};sockets.push(this);}addEventListener(k,f){this.handlers[k]=f;}close(){}}
  const row={id:'q1',status:'queueing',players:[{profileId:42}]};
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw new Error('no cache')},writeFile:async()=>{},localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],forceChinaCountry:(_,country)=>country,fetchLatestWorldsEdgeMatchOnce:async()=>null,readQueueSnapshot:async ids=>{queries++;assert.deepEqual(ids,['42']);if(outcome==='error')throw new Error('network');return outcome==='present'?[row]:[];}});
  await service.startRealtimeWebSockets(['42']);
  const socket=sockets.find(s=>s.url.includes('handler=queueing'));
  socket.handlers.message({data:JSON.stringify([{type:'queueingAdded',data:row}])});
  const state=async()=>(await service.refreshRealtimePayload(['42'])).states[0];
  await state();now+=299999;assert.equal((await state()).status,'queueing');assert.equal(queries,0);
  now+=2;await state();await new Promise(resolve=>setImmediate(resolve));
  const result=await state();assert.equal(queries,1);
  assert.equal(result.status,outcome==='absent'?'offline':'queueing');
  if(outcome==='absent')assert.ok(result.graceUntil>now);
  assert.equal(sockets.filter(s=>s.url.includes('handler=match-updated')).length,1);
});
