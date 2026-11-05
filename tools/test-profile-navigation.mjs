import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

test('profile re-entry loads all 100 matches without refresh, then checks latest; stale module imports stay inactive',async()=>{
 const matches=Array.from({length:100},(_,i)=>({id:100-i,started:1700000000-i*3600,finished:1700001800-i*3600,duration:1800,map:'arabia',leaderboard:'RM 1v1',players:[],teams:[]}));
 const requests=[];let latestCalls=0;
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  try {
   if(url.pathname.startsWith('/api/')){
    let data={};
    if(url.pathname==='/api/profile-matches'){
     requests.push(url.search);
     if(url.searchParams.has('latest')){latestCalls++;await new Promise(r=>setTimeout(r,350));data={matches:[matches[0]]};}
     else data={matches};
    }else if(url.pathname==='/api/profile-details')data={player:{id:'42',name:'Test',team:'Taiwan Aoe Gamer'},accounts:[]};
    else if(url.pathname==='/api/profile-accounts')data={accounts:[]};
    else if(url.pathname==='/api/profile-leaderboards')data={leaderboards:[]};
    else if(url.pathname==='/api/media'){await new Promise(r=>setTimeout(r,150));data={videos:[],live:[]};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));return;
   }
   let path=url.pathname;
   if(path==='/tech-tree.js')await new Promise(r=>setTimeout(r,250));
   if(!/\.[a-z0-9]+$/i.test(path))path='/index.html';
   const body=await readFile(new URL('../public'+path,import.meta.url));
   res.writeHead(200,{'content-type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.html')?'text/html':'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({args:['--no-proxy-server']});
 try {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/profile/42`);
  await page.waitForFunction(()=>document.querySelectorAll('#profileMatchesBody .profile-match-card').length===100);
  assert.match(requests[0],/snapshot=1/);assert.match(requests[1],/latest=1/);
  assert.equal(await page.locator('#profileIdentityMeta .player-team-link').innerText(),'TAG');
  await page.locator('.nav-item[data-page="media"]').click();
  await page.locator('.nav-item[data-page="profile"]').click();
  assert.equal(new URL(page.url()).pathname,'/profile/42');
  await page.waitForFunction(()=>document.querySelectorAll('#profileMatchesBody .profile-match-card').length===100);
  await page.waitForTimeout(400);assert.equal(latestCalls,2);
  await page.locator('.nav-item[data-page="tech-tree"]').click();
  await page.locator('.nav-item[data-page="profile"]').click();
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).pathname,'/profile/42');
  assert.equal(await page.locator('#tech-tree-page').innerHTML(),'');
  assert.equal(await page.locator('#profileMatchesBody .profile-match-card').count(),100);
  assert.deepEqual(errors,[]);
 } finally {await browser.close();await new Promise(r=>server.close(r));}
});
