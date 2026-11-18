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
const client=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000,sleep:async()=>{},maxRecoveryAttempts:0});

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

let challengeNow=0;
const challengePage={...page,title:async()=>'Just a moment...',frames:()=>[]};
const challengeBrowser={isConnected:()=>true,newContext:async()=>({pages:()=>[challengePage]})};
const challenged=createAoE2RecsBrowser({connect:async()=>challengeBrowser,timeoutMs:1000,
  verificationTimeoutMs:1000,now:()=>challengeNow,sleep:async ms=>{challengeNow+=ms;},maxRecoveryAttempts:0});
await assert.rejects(challenged.read(4),error=>error.code==='AOE2RECS_VERIFICATION_REQUIRED');

let recoveryCalls=0;
socket.readyState=3;
const recovered=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000,sleep:async()=>{},
  recoverVerification:async()=>{recoveryCalls++;if(recoveryCalls===3)socket.readyState=1;}});
assert.equal((await recovered.read(5)).player.name,'P5');
assert.equal(recoveryCalls,3,'browser verification should be retried three times before succeeding');
assert.equal(recovered.stats().recoveryAttempts,3);
assert.equal(recovered.stats().recoverySuccesses,1);

socket.readyState=3;
let failedRecoveryCalls=0;
const unrecovered=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000,sleep:async()=>{},
  recoverVerification:async()=>{failedRecoveryCalls++;}});
await assert.rejects(unrecovered.read(6),/WebSocket/);
assert.equal(failedRecoveryCalls,3,'only three recovery attempts should run before the error reaches the cooldown gate');

let thrownRecoveryCalls=0;
const thrownRecovery=createAoE2RecsBrowser({connect:async()=>browser,timeoutMs:1000,sleep:async()=>{},
  recoverVerification:async()=>{thrownRecoveryCalls++;throw Error('验证点击失败');}});
await assert.rejects(thrownRecovery.read(7),/验证点击失败/);
assert.equal(thrownRecoveryCalls,3,'a failed verification action should itself be repeated three times');
console.log('Persistent Chrome WebSocket: response matching, serial reuse and disconnect handling passed');
