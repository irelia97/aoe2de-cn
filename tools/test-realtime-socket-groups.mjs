import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitRealtimeProfiles } from '../server/services/realtime-profile-groups.js';
import { createRealtimeService } from '../server/services/realtime-service.js';
import { createLobbyListener } from '../server/services/realtime-lobbies.js';

function fixture() {
  const sockets=[];
  class Socket {
    constructor(url){this.url=url;this.readyState=1;this.handlers={};sockets.push(this);}
    addEventListener(type,fn){this.handlers[type]=fn;}
    close(){this.readyState=3;}
  }
  return {Socket,sockets,send:(socket,messages)=>socket.handlers.message({data:JSON.stringify(messages)})};
}
const ids=Array.from({length:8},(_,i)=>String(i+1));
test('151 profiles split into four balanced non-overlapping subscriptions',()=>{
  const original=Array.from({length:151},(_,i)=>String(i+1));
  const groups=splitRealtimeProfiles(original);
  assert.deepEqual(groups.map(group=>group.length),[38,38,38,37]);
  assert.deepEqual(groups.flat(),original);
  assert.equal(splitRealtimeProfiles(['1','2','3','4','5']).length,4);
  assert.deepEqual(splitRealtimeProfiles([]),[]);
});

test('queue shards keep cross-group parties and reconnect without clearing other shards',async()=>{
  const {Socket,sockets,send}=fixture();
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),
    fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>null,forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets(ids);
  assert.equal(sockets.length,12);
  const queue=sockets.filter(socket=>socket.url.includes('handler=queueing'));
  assert.deepEqual(queue.map(socket=>new URL(socket.url).searchParams.get('profile_ids')),['1,2','3,4','5,6','7,8']);
  const row={id:'m_100',status:'matched',matchId:100,players:[{profileId:1,team:1},{profileId:3,team:1},{profileId:99,team:2}]};
  for(const socket of queue.slice(0,2))send(socket,[{type:'queueingAdded',data:row}]);
  const states=async()=>new Map((await service.refreshRealtimePayload(ids)).states.map(state=>[state.profileId,state]));
  let result=await states();assert.equal(result.get('1').status,'matched');assert.equal(result.get('3').status,'matched');
  assert.equal(result.get('1').queue.players.length,3);
  queue[0].readyState=3;queue[0].handlers.close();
  result=await states();assert.equal(result.get('1').status,'offline');assert.equal(result.get('3').status,'matched');
  queue[0].readyState=1;queue[0].handlers.open();
  result=await states();assert.equal(result.get('3').status,'matched');
  send(queue[0],[{type:'queueingAdded',data:row}]);
  for(const socket of queue.slice(0,2))send(socket,[{type:'queueingRemoved',data:{id:'m_100',reason:'cancelled',profileIds:[1]}}]);
  result=await states();assert.equal(result.get('1').status,'cancelled');assert.equal(result.get('3').status,'offline');
  assert.ok(result.get('3').graceUntil>Date.now());
  assert.equal(service.getRealtimeStatus().queueing.socketCount,4);
  assert.equal(service.getRealtimeStatus().lobbies.socketCount,4);
  assert.equal(service.getRealtimeStatus().totalSocketCount,12);

  await service.startRealtimeWebSockets(['101','102','103','104']);
  const fresh=sockets.filter(socket=>socket.url.includes('handler=queueing')).at(-4);
  send(fresh,[{type:'queueingAdded',data:{id:'fresh',status:'queueing',players:[{profileId:101}]}}]);
  queue[0].handlers.open();send(queue[0],[{type:'queueingRemoved',data:{id:'fresh',reason:'started'}}]);queue[0].handlers.close();
  assert.equal((await service.refreshRealtimePayload(['101','102','103','104'])).states[0].status,'queueing');
});

test('lobby shards retain complete rooms and isolate disconnects, restarts and old callbacks',()=>{
  const {Socket,sockets,send}=fixture();
  const listener=createLobbyListener({WebSocket:Socket,onChange:()=>{}});
  listener.start(ids);assert.equal(sockets.length,4);
  for(const socket of sockets)assert.equal(new URL(socket.url).searchParams.has('profile_ids'),false); // Full room metadata and all slots are required.
  const messages=[{type:'lobbyAdded',data:{matchId:200,name:'Shared room'}},
    ...[1,3,99].map((id,slot)=>({type:'slotAdded',data:{matchId:200,slot,profileId:id,status:'player'}}))];
  for(const socket of sockets.slice(0,2))send(socket,messages);
  assert.equal(listener.state('1').lobby.players.length,3);assert.equal(listener.state('3').lobby.players.length,3);
  assert.equal(listener.state('99'),null);assert.equal(listener.status().roomCount,1);
  sockets[0].readyState=3;sockets[0].handlers.close();
  assert.equal(listener.state('1'),null);assert.equal(listener.state('3').lobby.name,'Shared room');
  sockets[0].readyState=1;sockets[0].handlers.open();
  assert.equal(listener.state('3').lobby.players.length,3);
  listener.start(['101','102','103','104']);
  send(sockets[4],[{type:'lobbyAdded',data:{matchId:201,name:'New room'}},{type:'slotAdded',data:{matchId:201,slot:0,profileId:101}}]);
  sockets[0].handlers.open();send(sockets[0],[{type:'lobbyRemoved',data:{matchId:201}}]);sockets[0].handlers.close();
  assert.equal(listener.state('101').lobby.name,'New room');listener.stop();
});
