import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeService} from '../server/services/realtime-service.js';

for (const source of ['reference','verified','override']) test(`pool uses highest linked account even when only the lower account is monitored: ${source}`, async () => {
  const low=source==='override'?'211246':'42', high=source==='override'?'1458474':'43';
  const requests=[];
  const sockets=[];
  class Socket {constructor(url){this.url=url;this.handlers={};this.readyState=1;sockets.push(this);} addEventListener(t,h){this.handlers[t]=h;} close(){this.readyState=3;}}
  const entries=new Map([[low,{canonicalProfileId:high}],[high,{canonicalProfileId:high}]]);
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),
    loadRlReference:async()=>source==='reference'?entries:new Map(),
    loadVerifiedRealtimeNames:async()=>source==='verified'?entries:new Map(),
    fetchPersonalLeaderboardStats:async id=>{requests.push(id);return [{id:3,rating:id===high?2800:id===low?2100:2400}];},
    fetchLatestWorldsEdgeMatchOnce:async()=>null,forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets([low]);
  const socket=sockets.find(s=>s.url.includes('handler=queueing'));
  socket.handlers.message({data:JSON.stringify([{type:'queueingAdded',data:{id:'m1',status:'matched',matchId:123,players:[{profileId:low,team:1},{profileId:'99',team:2}]}}])});
  await service.refreshRealtimePayload([low]);
  await new Promise(resolve=>setImmediate(resolve));
  const state=(await service.refreshRealtimePayload([low])).states[0];
  assert.equal(state.identity,high);
  assert.equal(state.player.rating,2800);
  assert.equal(state.player.accountRating,2100);
  assert.equal(state.queue.players.find(p=>String(p.profileId)===low).rating1v1,2100);
  assert.ok(requests.includes(high),'inactive highest account must be requested');
  assert.equal(requests.filter(id=>id===high).length,1,'cached requests are shared');
});
