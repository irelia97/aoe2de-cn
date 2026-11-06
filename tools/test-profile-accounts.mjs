import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createProfileAccountsReader} from '../server/services/profile-accounts.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const refs=new Map([['1',{canonicalProfileId:'1'}],['2',{canonicalProfileId:'1'}],['3',{canonicalProfileId:'3'}]]);

test('existing account/alias cache is returned without waiting for the upstream',async()=>{
  let calls=0;
  const read=createProfileAccountsReader({now:()=>1000,loadReferences:async()=>refs,localProfileDetails:()=>null,
    readCached:async()=>({savedAt:1000,profile:{accounts:[{id:'1',platform:'steam',name:'Player',akas:['Old Name']}],avatar:'avatar'}}),refresh:async()=>{calls++;}});
  const data=await read('1');
  assert.equal(data.partial,false);assert.deepEqual(data.accounts[0].akas,['Old Name']);assert.equal(calls,0);
});
test('alternate accounts can reuse a related profile cache including former nicknames',async()=>{
  const read=createProfileAccountsReader({now:()=>1000,loadReferences:async()=>refs,localProfileDetails:()=>null,
    readCached:async id=>id==='1'?{savedAt:1000,profile:{accounts:[{id:'2',platform:'steam',name:'Alt',akas:['Old Alt']}],avatar:''}}:null,refresh:async()=>{}});
  const data=await read('2');assert.equal(data.partial,false);assert.deepEqual(data.accounts[0].akas,['Old Alt']);
});
test('cold accounts immediately show only locally linked accounts and do not block on upstream failure',async()=>{
  let calls=0;
  const read=createProfileAccountsReader({loadReferences:async()=>refs,readCached:async()=>null,
    localProfileDetails:id=>({player:{name:'Player '+id,country_code:'cn',lastMatchTime:'2026-11-01T12:00:00Z'}}),refresh:async()=>{calls++;throw Error('403');}});
  const data=await read('2');
  assert.equal(data.partial,true);assert.deepEqual(data.accounts.map(a=>a.id),['2','1']);assert.ok(data.accounts.every(a=>a.akas.length===0));
  await flush();await read('2');assert.equal(calls,1);
});
test('stale cached aliases survive a failing background refresh',async()=>{
  const read=createProfileAccountsReader({now:()=>15*24*60*60_000+1,loadReferences:async()=>refs,localProfileDetails:()=>null,
    readCached:async()=>({savedAt:1,profile:{accounts:[{id:'1',platform:'steam',akas:['Known Alias']}],avatar:''}}),refresh:async()=>{throw Error('offline');}});
  const data=await read('1');await flush();assert.equal(data.stale,true);assert.equal(data.partial,false);assert.deepEqual(data.accounts[0].akas,['Known Alias']);
});


test('cached aliases remain fresh until exactly fifteen days',async()=>{
  let clock=1000,calls=0;
  const read=createProfileAccountsReader({now:()=>clock,loadReferences:async()=>refs,localProfileDetails:()=>null,
    readCached:async()=>({savedAt:1000,profile:{accounts:[{id:'1',platform:'steam',akas:['Old']} ]}}),refresh:async()=>{calls++;}});
  clock+=15*24*60*60_000-1;
  assert.equal((await read('1')).stale,false);await flush();assert.equal(calls,0);
  clock++;
  assert.equal((await read('1')).stale,true);await flush();assert.equal(calls,1);
});

test('not-found cache preserves local account, stops polling and lasts fifteen days',async()=>{
 let clock=1000,calls=0;
 const read=createProfileAccountsReader({now:()=>clock,loadReferences:async()=>new Map(),localProfileDetails:()=>({player:{name:'Local'}}),readCached:async()=>({savedAt:1000,profile:{notFound:true,accounts:[]}}),refresh:async()=>{calls++}});
 const data=await read('9');assert.equal(data.status,'not-found');assert.equal(data.accounts[0].name,'Local');await flush();assert.equal(calls,0);
 clock+=15*24*60*60_000;assert.equal((await read('9')).stale,true);await flush();assert.equal(calls,1);
});

test('loading, failed lookup and a confirmed single account are distinct',async()=>{
 const read=createProfileAccountsReader({loadReferences:async()=>new Map(),localProfileDetails:()=>null,readCached:async()=>null,refresh:async()=>{throw Error('offline')}});
 assert.equal((await read('9')).status,'loading');await flush();assert.equal((await read('9')).status,'unavailable');
 const single=createProfileAccountsReader({loadReferences:async()=>new Map(),localProfileDetails:()=>null,readCached:async()=>({savedAt:Date.now(),profile:{accounts:[{id:'9',akas:['Old']} ]}}),refresh:async()=>{}});
 const data=await single('9');assert.equal(data.status,'single-account');assert.deepEqual(data.accounts[0].akas,['Old']);
});
