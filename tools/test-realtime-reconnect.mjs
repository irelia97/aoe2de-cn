import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeService} from '../server/services/realtime-service.js';

for (const outcome of ['finished','active','empty','error','new-game']) test(`connection reconciles restored match: ${outcome}`,async()=>{
  const sockets=[];
  class Socket {
    constructor(url){this.url=url;this.handlers={};sockets.push(this);}
    addEventListener(type,fn){this.handlers[type]=fn;}
    close(){}
  }
  const started=Math.floor(Date.now()/1000)-100;
  const raw={id:123,started,finished:0,rms:'Arabia',players:[{id:'42',number:1,name:'Player'}]};
  const persisted={key:'42',payload:{states:[{profileId:'42',status:'game',match:{id:123,started,map:'Arabia',players:[{profileId:'42',name:'Player'}]}}]}};
  let queries=0;
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>JSON.stringify(persisted),writeFile:async()=>{},
    localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),fetchPersonalLeaderboardStats:async()=>[],
    forceChinaCountry:(_,c)=>c,fetchLatestWorldsEdgeMatchOnce:async()=>{queries++;if(outcome==='error')throw new Error('offline');return outcome==='empty'?null:{...raw,id:outcome==='new-game'?124:raw.id,finished:outcome==='finished'?started+50:0};}});
  await service.startRealtimeWebSockets(['42']);
  const socket=sockets.find(s=>s.url.includes('match-updated'));
  socket.handlers.open();socket.handlers.open(); // concurrent reconnect events must share the query
  await new Promise(resolve=>setTimeout(resolve,400));
  const payload=await service.getCachedPayload(['42']);
  assert.equal(queries,1);
  assert.equal(payload.states[0].status,outcome==='finished'?'offline':'game');
  if(outcome==='new-game')assert.equal(payload.states[0].match.id,124);
  assert.equal(service.getRealtimeStatus().validation.active,0);
  socket.handlers.close({code:1006,reason:'test disconnect',wasClean:false});
  assert.equal(service.getRealtimeStatus().groups[0].connected,false);
  assert.equal((await service.getCachedPayload(['42'])).states[0].status,outcome==='finished'?'offline':'game');
});
