import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf("      if (url.searchParams.get('snapshot')");
const end=source.indexOf('      if (progressive)',start);
const code=`async function run(){${source.slice(start,end)}}`;
for(const cached of [true,false])test(`${cached?'warm':'cold'} snapshot returns all 100 matches before any latest lookup`,async()=>{
 let fullCalls=0;
 const matches=Array.from({length:100},(_,i)=>({id:100-i}));
 const snapshot={matches,savedAt:1};
 const context={url:new URL('http://localhost/api/profile-matches?snapshot=1'),offset:0,profileId:'42',
  readWorldsEdgeMatchesCache:async()=>cached?snapshot:null,
  getWorldsEdgeMatches:async()=>{fullCalls++;return snapshot;},
  res:{writeHead(){},end:value=>JSON.parse(value)}};
 vm.createContext(context);vm.runInContext(code,context);
 const result=await context.run();assert.equal(result.matches.length,100);assert.equal(result.cached,cached);assert.equal(fullCalls,cached?0:1);
});
