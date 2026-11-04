import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLobbyListener } from '../server/services/realtime-lobbies.js';
import { createRealtimeService } from '../server/services/realtime-service.js';

function fakeSockets() {
  const sockets = [];
  class Socket {
    constructor(url) { this.url=url; this.readyState=1; this.handlers={}; sockets.push(this); }
    addEventListener(type, fn) { this.handlers[type]=fn; }
    close() { this.readyState=3; }
  }
  const send = (socket, rows) => socket.handlers.message({data:JSON.stringify(rows)});
  return { Socket, sockets, send };
}

test('lobby/slot messages merge, filter profiles, rename and remove membership', () => {
  const {Socket,sockets,send}=fakeSockets();
  let changes=0;
  const listener=createLobbyListener({WebSocket:Socket,onChange:()=>changes++});
  listener.start(['42']);
  const socket=sockets[0];
  socket.handlers.open();
  send(socket,[{type:'lobbyAdded',data:{matchId:100,name:'房间一'}},{type:'slotAdded',data:{matchId:100,slot:0,profileId:99,status:'player'}}]);
  assert.equal(listener.state('42'),null);
  assert.equal(changes,1);
  send(socket,[{type:'slotAdded',data:{matchId:100,slot:1,profileId:42,status:'player'}}]);
  assert.equal(listener.state('42').lobby.name,'房间一');
  assert.deepEqual(listener.state('42').lobby.players.map(player=>player.profileId),['99','42']);
  send(socket,[{type:'lobbyUpdated',data:{matchId:100,name:'房间二'}}]);
  assert.equal(listener.state('42').lobby.name,'房间二');
  send(socket,[{type:'slotUpdated',data:{matchId:100,slot:1,profileId:99}}]);
  assert.equal(listener.state('42'),null);
  send(socket,[{type:'slotAdded',data:{matchId:100,slot:2,profileId:42}},{type:'slotRemoved',data:{matchId:100,slot:2}}]);
  assert.equal(listener.state('42'),null);
  send(socket,[{type:'slotAdded',data:{matchId:100,slot:0,profileId:42}},{type:'lobbyRemoved',data:{matchId:100}}]);
  assert.equal(listener.state('42'),null);
  listener.stop();
});

test('lobby status is published, disappears into five-minute grace and yields to queueing', async () => {
  const {Socket,sockets,send}=fakeSockets();
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>null,getMediaCache:async()=>({live:[]}),loadRlReference:async()=>new Map(),
    fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>null,forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets(['42']);
  const lobby=sockets.find(socket=>socket.url.includes('handler=lobbies'));
  const queue=sockets.find(socket=>socket.url.includes('handler=queueing'));
  const state=async()=> (await service.refreshRealtimePayload(['42'])).states[0];
  send(lobby,[{type:'lobbyAdded',data:{matchId:100,name:'测试大厅'}},{type:'slotAdded',data:{matchId:100,slot:0,profileId:42}}]);
  assert.equal((await state()).status,'lobby');
  assert.equal((await state()).lobby.name,'测试大厅');
  send(queue,[{type:'queueingAdded',data:{id:'q1',status:'queueing',players:[{profileId:42}]}}]);
  assert.equal((await state()).status,'queueing');
  send(queue,[{type:'queueingRemoved',data:{id:'q1',reason:'left'}}]);
  assert.equal((await state()).status,'lobby');
  send(lobby,[{type:'lobbyRemoved',data:{matchId:100}}]);
  const gone=await state();
  assert.equal(gone.status,'offline');
  assert.ok(gone.graceUntil>Date.now()+299000);
  send(lobby,[{type:'lobbyAdded',data:{matchId:101,name:'新大厅'}},{type:'slotAdded',data:{matchId:101,slot:0,profileId:42}}]);
  assert.equal((await state()).graceUntil,null);
  lobby.readyState=3;
  lobby.handlers.close({code:1006,reason:'disconnect'});
  assert.ok((await state()).graceUntil>Date.now()+299000);
});
