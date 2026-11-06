import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerTeams} from '../server/services/player-teams.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const fortnight=15*24*60*60*1000;
function fixture(loadProfile) {
  let time=1800000000000,persisted=null,temporary,changes=0;
  const deps={cachePath:'/cache/teams.json',now:()=>time,loadProfile,onChange:()=>changes++,
    readFile:async()=>{if(!persisted)throw Object.assign(Error('missing'),{code:'ENOENT'});return JSON.stringify(persisted);},
    writeFile:async(_,text)=>{temporary=text;},rename:async()=>{persisted=JSON.parse(temporary);}};
  return {deps,cache:createPlayerTeams(deps),advance:ms=>time+=ms,now:()=>time,changes:()=>changes};
}
const known=at=>new Map([['42',{canonicalProfileId:'10',team:'CN ZhongSheng',savedAt:at}],['10',{canonicalProfileId:'10',team:'CN ZhongSheng',savedAt:at}]]);

test('team cache persists for fifteen days and shares the team with alternate accounts',async()=>{
  let requests=0;
  const f=fixture(async()=>{requests++;throw Error('should not refresh');});
  assert.equal((await f.cache.getTeams(['42','10'],known(f.now()))).get('42'),'CN ZhongSheng');
  await flush();
  f.advance(fortnight-1);
  const changed=known(f.now());changed.get('42').team='Other';
  assert.equal((await f.cache.getTeams(['42'],changed)).get('42'),'CN ZhongSheng');
  assert.equal((await createPlayerTeams(f.deps).getTeams(['10'])).get('10'),'CN ZhongSheng');
  assert.equal(requests,0);
});
test('expired cached team is returned immediately, then refreshed once in the background',async()=>{
  let resolve,requests=0;
  const f=fixture(()=>{requests++;return new Promise(done=>{resolve=done;});});
  await f.cache.getTeams(['42'],known(f.now()));f.advance(fortnight);
  assert.equal((await f.cache.getTeams(['42'])).get('42'),'CN ZhongSheng');
  await f.cache.getTeams(['10']);assert.equal(requests,1);
  resolve({player:{id:10,verified:true,platform_id:3,team:'New Team'},accounts:[{id:42,platform:'steam'}]});
  await flush();assert.equal((await f.cache.getTeams(['42','10'])).get('42'),'New Team');
  assert.equal(f.changes(),1);assert.equal(requests,1);
});
test('upstream failures keep the cached team and persist retry backoff across restarts',async()=>{
  let requests=0;
  const f=fixture(async()=>{requests++;throw Error('offline');});
  await f.cache.getTeams(['42'],known(f.now()));f.advance(fortnight);
  await f.cache.getTeams(['42']);await flush();
  const restored=createPlayerTeams(f.deps);
  assert.equal((await restored.getTeams(['42'])).get('42'),'CN ZhongSheng');
  assert.equal(requests,1);
});
test('uncertified account clan information never becomes a certified team',async()=>{
  const f=fixture(async()=>({player:{id:42,platform_id:3,verified:false,team:'Game Clan'},accounts:[]}));
  assert.equal((await f.cache.getTeams(['42'])).get('42'),'');await flush();
  assert.equal((await f.cache.getTeams(['42'])).get('42'),'');
});


test('reused full-profile cache keeps its original fetch time for team expiry',async()=>{
  let requests=0,savedAt;
  const f=fixture(async()=>{requests++;return {cacheSavedAt:savedAt,player:{id:42,platform_id:3,verified:true,team:'Cached Team'},accounts:[]};});
  savedAt=f.now()-14*24*60*60_000;
  await f.cache.getTeams(['42']);await flush();
  assert.equal(requests,1);
  f.advance(24*60*60_000-1);
  assert.equal((await f.cache.getTeams(['42'])).get('42'),'Cached Team');await flush();assert.equal(requests,1);
  f.advance(1);await f.cache.getTeams(['42']);await flush();assert.equal(requests,2);
});
