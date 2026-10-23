import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

let database,path,short,long;
parentPort.on('message',message=>{
  try {
    if(path!==message.path){
      database?.close();
      database=new DatabaseSync(message.path,{readOnly:true});path=message.path;
      short=database.prepare("SELECT profile_id AS profileId, steam_id AS steamId, name, clan, country, last_match_time AS lastMatchTime FROM profiles WHERE instr(lower(name), lower(?)) > 0 ORDER BY CASE WHEN trim(coalesce(clan, '')) <> '' THEN 0 ELSE 1 END, CASE WHEN lower(name) = lower(?) THEN 0 WHEN lower(name) LIKE ? THEN 1 ELSE 2 END, name COLLATE NOCASE LIMIT ?");
      long=database.prepare("SELECT p.profile_id AS profileId, p.steam_id AS steamId, p.name, p.clan, p.country, p.last_match_time AS lastMatchTime FROM profile_search f JOIN profiles p ON p.rowid = f.rowid WHERE profile_search MATCH ? ORDER BY CASE WHEN trim(coalesce(p.clan, '')) <> '' THEN 0 ELSE 1 END, CASE WHEN lower(p.name) = lower(?) THEN 0 WHEN lower(p.name) LIKE ? THEN 1 ELSE 2 END, p.name COLLATE NOCASE LIMIT ?");
    }
    const query=message.query,fts=[...query].length>=3;
    const match=fts?`"${query.replaceAll('"','""')}"`:query;
    const rows=(fts?long:short).all(match,query,`${query.toLocaleLowerCase()}%`,500);
    parentPort.postMessage({id:message.id,rows});
  }catch(error){parentPort.postMessage({id:message.id,error:error.message});}
});
