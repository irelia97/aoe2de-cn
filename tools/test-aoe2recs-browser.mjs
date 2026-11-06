import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAoE2RecsBrowser } from '../server/services/aoe2recs-browser.js';
let url='about:blank',challenge=false,active=0,maxActive=0,navigations=0,failNavigation=false;
const page=new EventEmitter();
Object.assign(page,{url:()=>url,title:async()=>challenge?'Just a moment...':'Spectator Dashboard',goto:async value=>{
 url=value;if(value==='about:blank')return;
 navigations++;if(failNavigation)throw Error('navigation failed');
 active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,5));active--;
 if(!challenge){const socket=new EventEmitter();socket.url=()=> 'wss://aoe2recs.com/dashboard/api/';page.emit('websocket',socket);socket.emit('framereceived',{payload:JSON.stringify({cls:8})});socket.emit('framereceived',{payload:JSON.stringify({cls:13,data:{player:'Yo'}})});}
}});
const browser={isConnected:()=>true,contexts:()=>[{pages:()=>[page]}]};
const client=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000});
assert.equal((await client.read(197964)).player,'Yo');assert.equal(url,'about:blank');assert.equal(page.listenerCount('websocket'),0);
await Promise.all([client.read(1),client.read(2)]);assert.equal(maxActive,1);
challenge=true;await assert.rejects(client.read(3),/人工验证/);assert.equal(url,'https://aoe2recs.com/profile/3');assert.equal(client.stats().verificationRequired,true);assert.equal(page.listenerCount('websocket'),0);
await assert.rejects(client.read('bad'),/无效/);
challenge=false;failNavigation=true;await assert.rejects(client.read(4),/navigation failed/);assert.equal(url,'about:blank');assert.equal(page.listenerCount('websocket'),0);
console.log('Native page connection: response capture, serial requests, verification retention, cleanup passed');
