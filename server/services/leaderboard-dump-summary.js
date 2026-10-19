import {createWriteStream} from 'node:fs';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {asyncBufferFromFile,parquetMetadataAsync,parquetReadObjects} from 'hyparquet';
import {compressors} from 'hyparquet-compressors';
const modes={1:'dm_1v1',2:'dm_team',3:'rm_1v1',4:'rm_team',13:'ew_1v1',14:'ew_team'};
const week=7*86400000;
export function latestWeeklySummaryTime(now=Date.now()) {
  // Monday 06:00 Asia/Shanghai is Sunday 22:00 UTC.
  const local=new Date(now+8*3600000);
  const daysSinceMonday=(local.getUTCDay()+6)%7;
  let boundary=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate()-daysSinceMonday,6)-8*3600000;
  if(boundary>now)boundary-=week;
  return boundary;
}
export function aggregateRows(rows,boards,forceCountry=(id,c)=>c) {
  for(const r of rows){
    if(r.active!==true || Number(r.season)!==-1 || !(Number(r.rank)>0) || !Number.isFinite(Number(r.rating)) || !Object.values(modes).includes(r.leaderboard))continue;
    const board=boards[r.leaderboard] ||= new Map();
    const id=String(r.profileId),prev=board.get(id);
    if(!prev || Date.parse(r.updatedAt)>=Date.parse(prev.updatedAt))board.set(id,{rank:Number(r.rank),rating:Number(r.rating),country:String(forceCountry(id,r.country||'')||'').toLowerCase(),updatedAt:r.updatedAt});
  }
}
export function summarizeBoards(boards){
 const result={};
 for(const [mode,players] of Object.entries(boards)){
   const b={count:0,sum:0,top100:0,countries:{}};
   for(const p of players.values()){
     b.count++;b.sum+=p.rating;if(p.rank<=100)b.top100++;
     const c=b.countries[p.country] ||= {count:0,sum:0,top100:0};c.count++;c.sum+=p.rating;if(p.rank<=100)c.top100++;
   }result[mode]=b;
 }return result;
}
export function createLeaderboardDumpSummary({cacheDir,forceCountry,fetchImpl=fetch}){
 const cachePath=join(cacheDir,'leaderboard-summary-dump.json');
 let snapshot=null,job=null,loaded=false,nextAttempt=0;
 async function load(){if(loaded)return;loaded=true;try{const j=JSON.parse(await readFile(cachePath,'utf8'));if(j.version===1&&j.boards?.rm_1v1?.count>0)snapshot=j;}catch{}}
 async function refresh(){
  if(job)return job;
  job=(async()=>{
   await mkdir(cacheDir,{recursive:true});const temp=join(cacheDir,'leaderboard-summary.parquet.tmp');
   try{
    const r=await fetchImpl('https://dump.cdn.aoe2companion.com/leaderboard.parquet',{headers:{'user-agent':'https://aoe2cn.cc','accept':'application/vnd.apache.parquet'},signal:AbortSignal.timeout(15*60000)});
    if(!r.ok)throw Error('Leaderboard dump HTTP '+r.status);
    await pipeline(Readable.fromWeb(r.body),createWriteStream(temp,{mode:0o600}));
    const file=await asyncBufferFromFile(temp),metadata=await parquetMetadataAsync(file),boards={};
    const columns=['leaderboard','profileId','rank','rating','country','active','season','updatedAt'];
    for(let i=0;i<Number(metadata.num_rows);i+=50000){
      const rows=await parquetReadObjects({file,compressors,columns,rowStart:i,rowEnd:Math.min(Number(metadata.num_rows),i+50000)});
      aggregateRows(rows,boards,forceCountry);
      await new Promise(resolve=>setImmediate(resolve));
    }
    const summary=summarizeBoards(boards);
    if(!summary.rm_1v1?.count || !summary.rm_team?.count)throw Error('Leaderboard dump missing active ladders');
    const next={version:1,source:'aoe2companion-leaderboard-parquet',updatedAt:new Date().toISOString(),dataUpdatedAt:r.headers.get('last-modified')||null,boards:summary};
    await writeFile(cachePath+'.tmp',JSON.stringify(next),{mode:0o600});await rename(cachePath+'.tmp',cachePath);snapshot=next;nextAttempt=latestWeeklySummaryTime()+week;
    console.log('[leaderboard-summary] dump ready: RM 1v1 '+summary.rm_1v1.count+' players');
   }catch(e){nextAttempt=Date.now()+3600000;throw e;}finally{await rm(temp,{force:true});}
  })().finally(()=>{job=null;});return job;
 }
 async function ensure(){await load();if(!snapshot){await refresh();}else if(Date.now()>=nextAttempt&&Date.parse(snapshot.updatedAt)<latestWeeklySummaryTime())refresh().catch(e=>console.warn('[leaderboard-summary] retaining last snapshot:',e.message));}
 async function get(id,country='all'){
  await ensure();const b=snapshot.boards[modes[id]];if(!b)throw Error('榜单统计暂不可用');
  const code=String(country).toLowerCase();const codes=code==='cn'?['cn','mo']:[code];
  const c=code==='all'?b:codes.reduce((a,k)=>{const v=b.countries[k];if(v){a.count+=v.count;a.sum+=v.sum;a.top100+=v.top100;}return a;},{count:0,sum:0,top100:0});
  return {averageRating:c.count?c.sum/c.count:null,countryPlayers:c.count,totalPlayers:b.count,top100Country:c.top100,source:snapshot.source,updatedAt:snapshot.updatedAt,dataUpdatedAt:snapshot.dataUpdatedAt};
 }
 let timer=null;
 function start(){
  if(timer)return;
  async function tick(){
   try{await ensure();if(job)await job;}catch(e){console.warn('[leaderboard-summary] refresh failed:',e.message);}
   const now=Date.now();
   const overdue=!snapshot || Date.parse(snapshot.updatedAt)<latestWeeklySummaryTime(now);
   const wake=overdue?Math.max(now+1000,nextAttempt):latestWeeklySummaryTime(now)+week;
   timer=setTimeout(tick,Math.max(1000,wake-now));timer.unref?.();
  }
  timer=setTimeout(tick,0);timer.unref?.();
 }
 return {get,start,refresh};
}
