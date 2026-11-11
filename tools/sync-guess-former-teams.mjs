import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';

const API='https://liquipedia.net/ageofempires/api.php', GAP=31_000;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const key=v=>String(v||'').normalize('NFKC').replace(/&amp;/gi,'&').replace(/[_\s]+/g,' ').replace(/[^\p{L}\p{N}]+/gu,'').toLowerCase();
const plain=v=>String(v||'').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
const titleOf=href=>decodeURIComponent(String(href||'').replace(/^.*\/ageofempires\//,'').split(/[?#]/)[0]).replaceAll('_',' ');
async function readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function save(path,value){await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}
function notify(path,content,marker='guess-former-teams-portal-sync-20261110'){if(!path)return;const db=new DatabaseSync(path);if(!db.prepare("SELECT 1 FROM messages WHERE kind='system' AND ip_hash=?").get(marker))db.prepare("INSERT INTO messages(kind,author,content,url,ip_hash,created_at) VALUES('system','系统',?,'',?,?)").run(content,marker,Date.now());db.close();}
function loadGuess(source){const context={window:{}};vm.runInNewContext(source,context);return context.window.guessData;}
function kind(source){
  if(/^\|\s*national_team\s*=\s*(?:true|yes|1)\b/im.test(source||''))return'national';
  const games=source?.match(/^\|\s*games?\s*=\s*([^\r\n]*)/im)?.[1]||'';
  if(games.split(',').some(x=>/^(?:aoe2(?:de)?|age of empires ii(?:\s*:\s*definitive edition)?)$/i.test(x.trim()))||/\{\{DISPLAYTITLE:[^}]*\(Age of Empires II team\)/i.test(source||''))return'aoe2';
  return games.trim()?'other':'unknown';
}
function directory(html){
  const out=new Map();
  for(const m of html.matchAll(/<span class="team-template-text">\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/gi)){const title=titleOf(m[1]);if(title)out.set(key(title),{title,name:plain(m[2])});}
  if(out.size<100)throw Error(`Portal:Teams only yielded ${out.size} teams`);return[...out.values()];
}
function roster(html){
  const start=html.search(/<h2\s+id="Player_Roster"/i);if(start<0)return[];
  const rest=html.slice(start), next=/<h2\s+id="(?!Player_Roster)[^"]+"/i.exec(rest.slice(20));
  const section=rest.slice(0,next?next.index+20:100000), out=new Map();
  for(const m of section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
    const cell=/<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(m[1])?.[1]||'';if(!/inline-player/i.test(cell))continue;
    const link=/<a\b[^>]*href="(\/ageofempires\/(?!index\.php)[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cell);if(!link)continue;
    const title=titleOf(link[1]);out.set(key(title),{title,name:plain(link[2])});
  }return[...out.values()];
}
let last=0;
async function api(params){const wait=Math.max(0,last+GAP-Date.now());if(wait)await sleep(wait);last=Date.now();const response=await fetch(API,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','user-agent':'AOE2DE-CN/1.0 (Portal Teams sync; admin@aoe2cn.cc)'},body:new URLSearchParams({format:'json',formatversion:'2',...params}),signal:AbortSignal.timeout(90000)});if(!response.ok)throw Error(`HTTP ${response.status}`);const data=await response.json();if(data.error)throw Error(data.error.info||data.error.code);return data;}
async function parse(page){const data=await api({action:'parse',page,prop:'text'});if(!data.parse?.text)throw Error(`No HTML: ${page}`);return data.parse;}
async function classify(titles){const out=new Map();for(let i=0;i<titles.length;i+=40){const batch=titles.slice(i,i+40),data=await api({action:'query',prop:'revisions',rvprop:'content',rvslots:'main',titles:batch.join('|')});for(const page of data.query?.pages||[])out.set(key(page.title),page.revisions?.[0]?.slots?.main?.content||'');console.log(`[classify ${Math.min(i+40,titles.length)}/${titles.length}]`);}return out;}

const args=Object.fromEntries(process.argv.slice(2).map(v=>{const[n,...r]=v.split('=');return[n.replace(/^--/,''),r.join('=')||true];}));
const root=resolve(args.root||'.'), dataPath=resolve(root,args.data||'public/guess/data.js'), refsPath=resolve(root,args.refs||'map/aoc-player-links.json'), progressPath=resolve(root,args.progress||'.cache/guess-former-teams-progress.json');
const source=await readFile(dataPath,'utf8'), guess=loadGuess(source), refs=JSON.parse(await readFile(refsPath,'utf8')).players||[];
const progress=await readJson(progressPath,{version:2,startedAt:new Date().toISOString(),teams:{},errors:[]});
if(!progress.directory){progress.directory=directory((await parse('Portal:Teams')).text);progress.portalFetchedAt=new Date().toISOString();await save(progressPath,progress);console.log(`Portal:Teams: ${progress.directory.length}`);}
if(!progress.classified){const raw=await classify(progress.directory.map(x=>x.title));progress.directory=progress.directory.map(x=>({...x,kind:kind(raw.get(key(x.title))||'')}));progress.classified=true;progress.aoe2Teams=progress.directory.filter(x=>x.kind==='aoe2').length;progress.unknownTeams=progress.directory.filter(x=>x.kind==='unknown').map(x=>x.title);await save(progressPath,progress);console.log(`AoE2: ${progress.aoe2Teams}; unknown: ${progress.unknownTeams.length}`);}
const targets=progress.directory.filter(x=>x.kind==='aoe2'), pending=targets.filter(x=>!Object.hasOwn(progress.teams,x.title)), limit=args.limit?Math.max(1,Number(args.limit)):pending.length;
for(const team of pending.slice(0,limit)){try{const page=await parse(team.title),players=roster(page.text);progress.teams[team.title]={status:'verified',name:team.name,resolvedTitle:page.title,players,checkedAt:new Date().toISOString()};console.log(`[${Object.keys(progress.teams).length}/${targets.length}] ${team.name}: ${players.length}`);}catch(e){progress.teams[team.title]={status:'review',name:team.name,error:e.message,checkedAt:new Date().toISOString()};progress.errors.push({team:team.title,error:e.message});notify(args['chat-db'],`猜选手历史战队抓取失败：${team.name}（${e.message}）。任务会继续处理其他战队。`,`guess-former-team-failure-${key(team.title)}-20261110`);}progress.updatedAt=new Date().toISOString();await save(progressPath,progress);}
if(args.apply&&Object.keys(progress.teams).length===targets.length){
  const aliases=new Map(),add=(alias,id)=>{const k=key(alias);if(!k)return;if(!aliases.has(k))aliases.set(k,new Set());aliases.get(k).add(String(id));};
  for(const p of guess.players)add(p.name,p.id);for(const ref of refs)for(const id of ref.rl||[]){add(ref.name,id);for(const t of ref.social_links?.liquipedia||[])add(t,id);}
  const found=new Map(),ambiguous=[];for(const team of Object.values(progress.teams))for(const p of team.players||[]){const ids=aliases.get(key(p.title))||aliases.get(key(p.name));if(!ids||ids.size!==1){if(ids?.size>1)ambiguous.push({player:p,team:team.name,ids:[...ids]});continue;}const[id]=ids;if(!found.has(id))found.set(id,new Map());found.get(id).set(key(team.name),team.name);}
  let changed=0,populated=0;for(const p of guess.players){const verified=[...(found.get(String(p.id))?.values()||[])].filter(t=>key(t)!==key(p.team));const merged=[...new Map([...(p.formerTeams||[]),...verified].map(t=>[key(t),t])).values()];if(merged.length)populated++;if(JSON.stringify(p.formerTeams||[])!==JSON.stringify(merged))changed++;if(merged.length)p.formerTeams=merged;else delete p.formerTeams;}
  await writeFile(dataPath+'.tmp',`// AOE2CN player snapshot and bundled AoE2 technology tree.\nwindow.guessData = ${JSON.stringify(guess,null,2)};\n`);await rename(dataPath+'.tmp',dataPath);
  const indexPath=resolve(root,'public/guess/index.html'),index=(await readFile(indexPath,'utf8')).replace(/data\.js\?v=(\d+)/,(_,v)=>`data.js?v=${Number(v)+1}`);await writeFile(indexPath+'.tmp',index);await rename(indexPath+'.tmp',indexPath);
  Object.assign(progress,{completedAt:new Date().toISOString(),changedPlayers:changed,populatedPlayers:populated,ambiguous});await save(progressPath,progress);notify(args['chat-db'],`猜选手历史战队核查完成：扫描 ${targets.length} 个帝国时代 II 战队，补充 ${changed} 名选手；${ambiguous.length} 条重名记录未自动采用。`);console.log(`Applied ${changed}; populated ${populated}; ambiguous ${ambiguous.length}`);
}
