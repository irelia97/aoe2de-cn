import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeService} from '../server/services/realtime-service.js';

for (const restore of [false,true]) test(`cancelled state expires after three minutes, restored=${restore}`,async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const cancelledAt=now;
  const sockets=[];
  class Socket {constructor(url){this.url=url;this.readyState=1;this.handlers={};sockets.push(this);}addEventListener(key,fn){this.handlers[key]=fn;}close(){}}
  const cached={key:'42',payload:{states:[{profileId:'42',status:'cancelled',cancellation:{matchId:123,cancelledAt,players:[]}}]}};
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{if(restore)return JSON.stringify(cached);throw Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),forceChinaCountry:(_,c)=>c,
    fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>null});
  await service.startRealtimeWebSockets(['42']);
  const queue=sockets.find(s=>s.url.includes('handler=queueing'));
  const send=rows=>queue.handlers.message({data:JSON.stringify(rows)});
  if(!restore)send([{type:'queueingAdded',data:{id:'m1',status:'matched',matchId:123,players:[{profileId:42}]}},{type:'queueingRemoved',data:{id:'m1',reason:'cancelled',profileIds:[42]}}]);
  const state=async()=>(await service.refreshRealtimePayload(['42'])).states[0];
  assert.equal((await state()).status,'cancelled');
  now+=179999;assert.equal((await state()).status,'cancelled');
  now++;const expired=await state();
  assert.equal(expired.status,'offline');assert.equal(expired.graceUntil,now+300000);
  now+=300000;assert.equal((await state()).graceUntil,null);
  send([{type:'queueingAdded',data:{id:'q2',status:'queueing',players:[{profileId:42}]}}]);
  assert.equal((await state()).status,'queueing');
});
