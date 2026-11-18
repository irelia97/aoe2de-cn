import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfileRoutes} from '../server/routes/profile.js';
for(const cached of [true,false])test(`${cached?'warm':'cold'} snapshot returns all 100 matches before any latest lookup`,async()=>{
 let fullCalls=0;
 const matches=Array.from({length:100},(_,i)=>({id:100-i}));
 const snapshot={matches,savedAt:1};
 const url=new URL('http://localhost/api/profile-matches?id=42&snapshot=1');
 const routes=createProfileRoutes({
  readWorldsEdgeMatchesCache:async()=>cached?snapshot:null,
  getWorldsEdgeMatches:async()=>{fullCalls++;return snapshot;},
  repairOlderUnfinishedMatches:()=>new Promise(()=>{}),
 });
 const result=await routes.get(url.pathname)(url,{writeHead(){},end:value=>JSON.parse(value)});assert.equal(result.matches.length,100);assert.equal(result.cached,cached);assert.equal(fullCalls,cached?0:1);
});
