import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadWorldsEdgeMatches(');
const code=source.slice(start,source.indexOf('\nfunction loadProfileAccounts',start));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup({fresh=true,cached=true,fetchImpl}={}){
 const element=()=>({dataset:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;}});
 const status=element(),pieStatus=element(),body=element(),pie=element(),more=element(),filter={value:'all'};
 const nodes={'#profileMatchesRefreshStatus':status,'#profileRecentRefreshStatus':pieStatus,'#profileMatchesBody':body,'#profileRecentModeChart':pie,'#profileMatchesMore':more,'#profileMatchesFilter':filter};
 let displayed=[],saved=0;
 const context={document:{querySelector:selector=>nodes[selector]||null},location:{pathname:'/profile/42'},profileDetailsRequestId:1,
  readProfileMatchesLocalCache:()=>cached?{matches:[{id:1}],savedAt:fresh?Date.now():0}:null,profileMatchesLocalCacheTtl:600000,
  profileRecentResultsByLeaderboard:()=>new Map(),profileRecentStatsByLeaderboard:()=>new Map(),profileRecentModeCounts:()=>new Map(),
  renderProfileModeCharts(){},renderProfileLeaderboards(){},renderProfileLastMatchFromMatch(){},currentProfileLeaderboardRows:[],
  saveProfileMatchesLocalCache(){saved++;},filterProfileMatches:x=>x,renderProfileMatches:(_,items)=>{displayed=items;},fetch:fetchImpl};
 vm.createContext(context);vm.runInContext(code,context);
 return {context,status,pieStatus,body,displayed:()=>displayed,saved:()=>saved};
}
const response=data=>({ok:true,json:async()=>data});

test('fresh browser cache remains visible with refreshing status until latest check completes',async()=>{
 const pending=deferred(),view=setup({fetchImpl:()=>pending.promise});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);
 assert.equal(view.displayed()[0].id,1);assert.equal(view.status.textContent,'正在刷新…');assert.equal(view.body.attributes['aria-busy'],'true');
 pending.resolve(response({matches:[{id:1,finished:99}]}));await task;
 assert.equal(view.status.textContent,'');assert.equal(view.status.hidden,true);assert.equal(view.pieStatus.textContent,undefined);assert.equal(view.body.attributes['aria-busy'],'false');
 assert.equal(view.displayed()[0].finished,99);
});

test('new latest match keeps refreshing status until the entire history refresh completes',async()=>{
 const complete=deferred();let requests=0;
 const view=setup({fetchImpl:()=>++requests===1?Promise.resolve(response({matches:[{id:3}]})):complete.promise});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);await flush();
 assert.equal(view.displayed()[0].id,3);assert.equal(view.status.textContent,'正在刷新…');
 complete.resolve(response({matches:[{id:3},{id:2},{id:1}]}));await task;
 assert.equal(view.displayed().length,3);assert.equal(view.status.textContent,'');assert.equal(view.status.hidden,true);
});

test('failed latest query retains old history and explicitly reports failure',async()=>{
 const view=setup({fetchImpl:async()=>({ok:false})});
 await view.context.loadWorldsEdgeMatches('42',{},1);
 assert.equal(view.displayed()[0].id,1);assert.equal(view.status.textContent,'刷新失败，保留旧数据');assert.equal(view.body.attributes['aria-busy'],'false');assert.equal(view.saved(),0);
});

test('server fallback is labelled stale, never successful or saved as freshly loaded data',async()=>{
 let requests=0;const pending=deferred();
 const view=setup({fresh:false,fetchImpl:()=>++requests===1?Promise.resolve(response({matches:[{id:1}]})):pending.promise});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);await flush();
 assert.equal(view.status.textContent,'正在刷新…');
 pending.resolve(response({matches:[{id:1}],stale:true}));await task;
 assert.equal(view.status.textContent,'暂未刷新，显示旧数据');assert.equal(view.saved(),0);
});

test('late completion for a different player does not reset the active refresh indicator',async()=>{
 const pending=deferred(),view=setup({fetchImpl:()=>pending.promise});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);
 view.context.profileDetailsRequestId=2;view.context.location.pathname='/profile/43';
 view.status.textContent='正在刷新…';pending.resolve(response({matches:[{id:1}]}));await task;
 assert.equal(view.status.textContent,'正在刷新…');
});
