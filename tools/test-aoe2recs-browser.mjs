import assert from 'node:assert/strict';
import { createAoE2RecsBrowser } from '../server/services/aoe2recs-browser.js';

let url='about:blank', navigations=0, active=0, maxActive=0;
const frames=[];
const socket={url:'wss://aoe2recs.com/dashboard/api/',readyState:1};
const page={
  url:()=>url,isClosed:()=>false,title:async()=>'Spectator Dashboard',
  addInitScript:async()=>{},
  goto:async value=>{url=value;navigations++;},
  evaluate:async (_fn,arg)=>{
    if(typeof arg==='string')return socket.readyState;
    if(arg?.id){
      active++;maxActive=Math.max(maxActive,active);
      await new Promise(resolve=>setTimeout(resolve,5));
      frames.push({cls:13,data:{found:true,player:null,accounts:[]}});
      frames.push({cls:13,data:{player:{id:String(arg.id),name:`P${arg.id}`},accounts:[{id:String(arg.id)}]}});
      active--;
      return {ok:true,baseline:frames.length-1};
    }
    return {frames:frames.slice(arg.baseline),state:socket.readyState};
  }
};
const browser={isConnected:()=>true,newContext:async()=>({pages:()=>[page]})};
const client=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000,sleep:async()=>{}});

assert.equal((await client.read(197964)).player.name,'P197964');
assert.equal(url,'https://aoe2recs.com/profile/197964');
assert.equal(navigations,1);
await Promise.all([client.read(1),client.read(2)]);
assert.equal(maxActive,1);
assert.equal(navigations,1,'verified page and WebSocket should be reused');
assert.equal(client.stats().socketReuseCount,3);
await assert.rejects(client.read('bad'),/无效/);
socket.readyState=3;
await assert.rejects(client.read(3),/WebSocket/);

const challengePage={...page,title:async()=>'Just a moment...'};
const challengeBrowser={isConnected:()=>true,newContext:async()=>({pages:()=>[challengePage]})};
const challenged=createAoE2RecsBrowser({connect:async()=>challengeBrowser,timeoutMs:1000,sleep:async()=>{}});
await assert.rejects(challenged.read(4),error=>error.code==='AOE2RECS_VERIFICATION_REQUIRED');
console.log('Persistent Chrome WebSocket: response matching, serial reuse and disconnect handling passed');
