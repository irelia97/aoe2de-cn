import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProfileService } from '../server/services/profile-service.js';

const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
function service(fetchImpl,cache=new Map()) {
  return createProfileService({getProfileDb:()=>null,leaderboardCache:new Map(),ladderOrder:[3,4],types:{3:'1v1',4:'团队'},personalStatsCache:cache,personalStatsCacheTtl:600000,fetchUpstreamWithRateLimit:fetchImpl});
}
const rankedPayload = {result:{code:0},leaderboardStats:[{leaderboard_id:3,rank:20,rating:2200,wins:30,losses:20}]};

test('ranked stats render before a hanging lobby request; concurrent full lookup shares work',async()=>{
  const lobby=deferred(),cache=new Map();let rankedCalls=0,lobbyCalls=0;
  const api=service(async url=>{
    if (String(url).includes('getPersonalStat')) {rankedCalls++;return Response.json(rankedPayload);}
    lobbyCalls++;return lobby.promise;
  },cache);
  const initial=await api.fetchPersonalLeaderboardStats('42',{rankedOnly:true});
  assert.equal(initial[0].rating,2200);assert.equal(initial.at(-1).pending,true);
  const full=api.fetchPersonalLeaderboardStats('42');let finished=false;full.then(()=>finished=true);
  const repeat=await api.fetchPersonalLeaderboardStats('42',{rankedOnly:true});
  assert.equal(repeat[0].rating,2200);assert.equal(finished,false);
  lobby.resolve(Response.json({leaderboards:[{leaderboardId:'unranked',wins:8,losses:2,games:10,lastMatchTime:new Date().toISOString()}]}));
  const complete=await full;
  assert.equal(complete.at(-1).wins,8);assert.equal(complete.at(-1).pending,undefined);
  assert.equal(rankedCalls,1);assert.equal(lobbyCalls,1);
  assert.deepEqual(await api.fetchPersonalLeaderboardStats('42'),complete);
});

test('failed optional lobby refresh retains previous figures and releases pending state',async()=>{
  const cache=new Map([['42',{savedAt:0,data:[{id:0,wins:7,losses:3,hasData:true,active:true}]}]]);
  const api=service(async url=>String(url).includes('getPersonalStat')?Response.json(rankedPayload):Promise.reject(new Error('lobby down')),cache);
  const initial=await api.fetchPersonalLeaderboardStats('42',{rankedOnly:true});
  assert.equal(initial.at(-1).wins,7);
  const full=await api.fetchPersonalLeaderboardStats('42');
  assert.equal(full.at(-1).wins,7);assert.equal(full.at(-1).stale,true);assert.equal(cache.get('42').lobbyPending,false);
});

test('ranked request failures reject both views and allow a subsequent retry',async()=>{
  let fail=true;
  const api=service(async url=>{
    if (fail) throw new Error('ranked down');
    return Response.json(String(url).includes('getPersonalStat')?rankedPayload:{leaderboards:[]});
  });
  await assert.rejects(api.fetchPersonalLeaderboardStats('42',{rankedOnly:true}),/ranked down/);
  fail=false;
  const result=await api.fetchPersonalLeaderboardStats('42');assert.equal(result[0].rating,2200);
});

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('      if (progressive) {');
const end=source.indexOf('\n      const pageNumber',start);
const handler=`async function run(){${source.slice(start,end)}}`;
test('cached first match batch is returned while the latest-match refresh is still pending',async()=>{
  let calls=0,refreshes=0;const cached=Array.from({length:100},(_,i)=>({id:100-i}));
  const ctx={progressive:true,profileId:'42',worldsEdgeMatchCacheTtl:600000,
    readWorldsEdgeMatchesCache:async()=>({matches:cached,savedAt:0}),
    fetchProfileMatchesOnce:async()=>{calls++;throw new Error('must not block on upstream');},
    getWorldsEdgeMatches:()=>{refreshes++;return new Promise(()=>{});},
    res:{writeHead(){},end:value=>JSON.parse(value)},console};
  vm.createContext(ctx);vm.runInContext(handler,ctx);
  const result=await ctx.run();
  assert.equal(result.matches.length,20);assert.equal(result.matches[0].id,100);
  assert.equal(result.cached,true);assert.equal(result.stale,true);assert.equal(calls,0);assert.equal(refreshes,1);
});

test('uncached first match batch still loads genuine upstream matches',async()=>{
  const ctx={progressive:true,profileId:'42',worldsEdgeMatchCacheTtl:600000,
    readWorldsEdgeMatchesCache:async()=>null,
    fetchProfileMatchesOnce:async()=>({matches:[{id:99}]}),getWorldsEdgeMatches:async()=>({matches:[{id:99}]}),
    res:{writeHead(){},end:value=>JSON.parse(value)},console};
  vm.createContext(ctx);vm.runInContext(handler,ctx);
  const result=await ctx.run();assert.equal(result.cached,false);assert.equal(result.matches[0].id,99);
});

test('ranked cards render before lobby completion and old profile responses cannot overwrite a newer player',async()=>{
  const frontend=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const start=frontend.indexOf('let profileLeaderboardsRequestId = 0;');
  const code=frontend.slice(start,frontend.indexOf('\nfunction profileMatchCategory',start));
  const a=deferred(),b=deferred(),renders=[];
  const ctx={location:{pathname:'/profile/42'},document:{querySelector:()=>({})},profileSectionLoadingMarkup:()=>'',
    renderProfileLeaderboards:rows=>renders.push(rows),fetch:async url=>url.includes('progressive=1')?{ok:true,json:async()=>({leaderboards:[{id:3,player:url.includes('id=42')?'42':'43'},{id:0,pending:true}]})}:url.includes('id=42')?a.promise:b.promise};
  vm.createContext(ctx);vm.runInContext(code,ctx);
  ctx.loadProfileLeaderboards('42');await new Promise(r=>setImmediate(r));assert.equal(renders[0][0].player,'42');
  ctx.location.pathname='/profile/43';ctx.loadProfileLeaderboards('43');await new Promise(r=>setImmediate(r));
  a.resolve({ok:true,json:async()=>({leaderboards:[{id:3,player:'42-old'}]})});await new Promise(r=>setImmediate(r));
  assert.equal(renders.at(-1)[0].player,'43');
  b.resolve({ok:true,json:async()=>({leaderboards:[{id:3,player:'43-complete'}]})});await new Promise(r=>setImmediate(r));
  assert.equal(renders.at(-1)[0].player,'43-complete');
});
