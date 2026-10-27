import {readFile,writeFile,rename} from 'node:fs/promises';
import {tournamentFinalScore} from '../server/services/liquipedia-tournament-scores.js';

const root=new URL('../',import.meta.url),cacheUrl=new URL('.cache/liquipedia-tournament-results.json',root);
const userAgent='AOE2CN/1.0 (https://aoe2cn.cc/; contact: https://aoe2cn.cc/feedback)';
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const cache=JSON.parse(await readFile(cacheUrl,'utf8'));
const rows=[...new Map(Object.values(cache.categories).flatMap(category=>category.rows).filter(row=>row.url&&row.winner&&row.runnerUp&&!row.score&&!/TBD|待定/i.test(row.winner+row.runnerUp)).map(row=>[row.url,row])).values()];
const batches=[];for(let index=0;index<rows.length;index+=40)batches.push(rows.slice(index,index+40));
let matched=0,processed=0;
for (const [batchIndex,batch] of batches.entries()) {
  const titles=batch.map(row=>decodeURIComponent(new URL(row.url).pathname.replace('/ageofempires/',''))).join('|');
  const form=new URLSearchParams({action:'query',prop:'revisions',rvprop:'content',rvslots:'main',titles,redirects:'1',format:'json',formatversion:'2'});
  const response=await fetch('https://liquipedia.net/ageofempires/api.php',{method:'POST',headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded;charset=UTF-8','user-agent':userAgent},body:form,signal:AbortSignal.timeout(120_000)});
  if (!response.ok) throw new Error(`batch ${batchIndex+1} HTTP ${response.status}`);
  const payload=await response.json(),pages=payload?.query?.pages || [];
  const contentByTitle=new Map(pages.map(page=>[String(page.title||'').replaceAll(' ','_').toLocaleLowerCase(),page.revisions?.[0]?.slots?.main?.content||'']));
  const redirects=new Map((payload?.query?.redirects||[]).map(item=>[String(item.from||'').replaceAll(' ','_').toLocaleLowerCase(),String(item.to||'').replaceAll(' ','_').toLocaleLowerCase()]));
  for (const row of batch) {
    const title=decodeURIComponent(new URL(row.url).pathname.replace('/ageofempires/','')).replaceAll(' ','_').toLocaleLowerCase();
    const score=tournamentFinalScore(contentByTitle.get(redirects.get(title)||title)||'',row.winner,row.runnerUp);
    if (score) {row.score=score;matched++;}
    processed++;
  }
  for(const category of Object.values(cache.categories))for(const row of category.rows){const source=rows.find(item=>item.url===row.url);if(source?.score)row.score=source.score;}
  cache.scoresUpdatedAt=new Date().toISOString();
  const temporary=new URL('.cache/liquipedia-tournament-results.json.tmp',root);
  await writeFile(temporary,JSON.stringify(cache),'utf8');await rename(temporary,cacheUrl);
  console.log(JSON.stringify({batch:batchIndex+1,batches:batches.length,processed,matched}));
  if(batchIndex<batches.length-1)await wait(31_000);
}
