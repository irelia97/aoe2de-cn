import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadWorldsEdgeMatches(');
const code=source.slice(start,source.indexOf('\nfunction loadProfileAccounts',start));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const response=data=>({ok:true,json:async()=>data});
const baseline=Array.from({length:100},(_,i)=>({id:100-i}));
function setup(fetchImpl){
 const element=()=>({dataset:{},attributes:{},setAttribute(name,value){this.attributes[name]=value;}});
 const status=element(),body=element(),more=element(),filter={value:'all'};
 const nodes={'#profileMatchesRefreshStatus':status,'#profileMatchesBody':body,'#profileMatchesMore':more,'#profileMatchesFilter':filter};
 let displayed=[],limit=0,saved=0;
 const context={AbortSignal,document:{querySelector:selector=>nodes[selector]||null},location:{pathname:'/profile/42'},profileDetailsRequestId:1,
  readProfileMatchesLocalCache:()=>({matches:baseline,savedAt:0}),
  profileRecentResultsByLeaderboard:()=>new Map(),profileRecentStatsByLeaderboard:()=>new Map(),profileRecentModeCounts:()=>new Map(),
  renderProfileModeCharts(){},renderProfileLeaderboards(){},renderProfileLastMatchFromMatch(){},currentProfileLeaderboardRows:[],
  saveProfileMatchesLocalCache(){saved++;},renderProfileMatches:(_,items,count)=>{displayed=items;limit=count;},fetch:fetchImpl};
 vm.createContext(context);vm.runInContext(code,context);
 return {context,status,body,more,filter,displayed:()=>displayed,limit:()=>limit,saved:()=>saved};
}
test('complete 100-match snapshot renders before the latest-match request starts',async()=>{
 const snapshot=deferred(),latest=deferred(),urls=[];
 const view=setup(url=>{urls.push(url);if(url.includes('snapshot=1'))return snapshot.promise;assert.equal(view.displayed().length,100);assert.equal(view.limit(),100);return latest.promise;});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);
 assert.equal(urls.length,1);assert.match(urls[0],/snapshot=1/);assert.equal(view.displayed().length,0);
 snapshot.resolve(response({matches:baseline}));await flush();
 assert.equal(urls.length,2);assert.match(urls[1],/latest=1/);assert.equal(view.more.hidden,true);
 latest.resolve(response({matches:[{id:100,finished:99}]}));await task;
 assert.equal(view.displayed()[0].finished,99);assert.equal(view.displayed().length,100);assert.equal(view.status.hidden,true);
 view.filter.onchange();assert.equal(view.limit(),100);
});
test('new latest match displays immediately and fills missing matches afterwards',async()=>{
 const complete=deferred(),urls=[];
 const view=setup(url=>{urls.push(url);return urls.length===1?Promise.resolve(response({matches:baseline})):urls.length===2?Promise.resolve(response({matches:[{id:103}]})):complete.promise;});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);await flush();
 assert.equal(view.displayed()[0].id,103);assert.equal(view.displayed().length,100);assert.equal(view.status.dataset.state,'refreshing');
 complete.resolve(response({matches:Array.from({length:100},(_,i)=>({id:103-i}))}));await task;
 assert.equal(view.displayed()[1].id,102);assert.equal(view.status.hidden,true);assert.equal(view.saved(),1);
});
test('failed latest query retains all 100 already rendered matches',async()=>{
 const view=setup(async url=>url.includes('snapshot=1')?response({matches:baseline}):{ok:false});
 await view.context.loadWorldsEdgeMatches('42',{},1);
 assert.equal(view.displayed().length,100);assert.equal(view.status.textContent,'刷新失败，保留旧数据');assert.equal(view.saved(),0);
});
test('stale latest fallback is never saved as freshly loaded data',async()=>{
 const view=setup(async url=>response({matches:url.includes('snapshot=1')?baseline:[baseline[0]],stale:true}));
 await view.context.loadWorldsEdgeMatches('42',{},1);
 assert.equal(view.status.dataset.state,'stale');assert.equal(view.saved(),0);
});
test('leaving a profile before snapshot completes prevents rendering and latest lookup',async()=>{
 const pending=deferred();let calls=0;const view=setup(()=>{calls++;return pending.promise;});
 const task=view.context.loadWorldsEdgeMatches('42',{},1);view.context.profileDetailsRequestId=2;view.context.location.pathname='/events';
 pending.resolve(response({matches:baseline}));await task;assert.equal(view.displayed().length,0);assert.equal(calls,1);
});
