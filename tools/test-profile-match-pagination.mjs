import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function loadWorldsEdgeMatches(');
const code=source.slice(start,source.indexOf('\nfunction loadProfileAccounts',start));
const matches=Array.from({length:100},(_,id)=>({id,category:id%2?'lobby':'rm_1v1'}));
const more={},filter={value:'rm_1v1'};
let complete, count=0, requests=0;
const pending=new Promise(resolve=>{complete=resolve;});
const context={
  document:{querySelector:selector=>selector==='#profileMatchesMore'?more:selector==='#profileMatchesFilter'?filter:null},
  location:{pathname:'/profile/197964'},profileDetailsRequestId:1,
  readProfileMatchesLocalCache:()=>null,profileMatchesLocalCacheTtl:600000,
  profileRecentResultsByLeaderboard:()=>new Map(),profileRecentStatsByLeaderboard:()=>new Map(),profileRecentModeCounts:()=>new Map(),
  renderProfileModeCharts:()=>{},renderProfileLeaderboards:()=>{},renderProfileLastMatchFromMatch:()=>{},saveProfileMatchesLocalCache:()=>{},
  currentProfileLeaderboardRows:[],
  filterProfileMatches:items=>filter.value==='all'?items:items.filter(m=>m.category===filter.value),
  renderProfileMatches:(_,items,limit)=>{count=context.filterProfileMatches(items).slice(0,limit).length;},
  fetch:async()=>{requests++;return requests===1?{ok:true,json:async()=>({matches,hasMore:false})}:pending;},
};
vm.createContext(context);vm.runInContext(code,context);
const task=context.loadWorldsEdgeMatches('197964',{},1);
// The button must work before the background 100-match refresh resolves.
assert.equal(typeof more.onclick,'function');
await new Promise(resolve=>setImmediate(resolve));
assert.equal(count,20);
await more.onclick();assert.equal(count,40);
await more.onclick();assert.equal(count,50);
filter.value='lobby';filter.onchange();assert.equal(count,20);
await more.onclick();assert.equal(count,40);
complete({ok:true,json:async()=>({matches,hasMore:false})});await task;
assert.equal(count,40);
await more.onclick();assert.equal(count,50);assert.equal(more.hidden,true);
filter.value='all';filter.onchange();await more.onclick();assert.equal(count,40);
console.log('Filtered pagination and pending background refresh passed');
