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
  const read=createProfileAccountsReader({now:()=>200000000,loadReferences:async()=>refs,localProfileDetails:()=>null,
    readCached:async()=>({savedAt:1,profile:{accounts:[{id:'1',platform:'steam',akas:['Known Alias']}],avatar:''}}),refresh:async()=>{throw Error('offline');}});
  const data=await read('1');await flush();assert.equal(data.stale,true);assert.equal(data.partial,false);assert.deepEqual(data.accounts[0].akas,['Known Alias']);
});
