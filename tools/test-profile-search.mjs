import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileSearchPool } from '../server/services/profile-search-pool.js';

test('short and indexed nickname searches run off-thread and cache duplicate queries',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'profile-search-'));
  const path=join(directory,'profiles.sqlite');
  const database=new DatabaseSync(path);
  database.exec("CREATE TABLE profiles(profile_id TEXT PRIMARY KEY,steam_id TEXT,name TEXT,clan TEXT,country TEXT,last_match_time TEXT);CREATE VIRTUAL TABLE profile_search USING fts5(name,content='profiles',content_rowid='rowid',tokenize='trigram');");
  const add=database.prepare('INSERT INTO profiles VALUES(?,?,?,?,?,?)');
  add.run('1','steam1','_LY_Yo','LYZD','CN','');
  add.run('2','steam2','Hera','VIT','CA','');
  add.run('3','steam3','中国玩家','','CN','');
  database.exec('BEGIN');for(let i=4;i<100000;i++)add.run(String(i),'',`Player${i}`,'','','');database.exec("COMMIT;INSERT INTO profile_search(profile_search) VALUES('rebuild');");
  database.close();
  const pool=createProfileSearchPool();
  try{
    let timerRan=false;const timer=new Promise(resolve=>setTimeout(()=>{timerRan=true;resolve();},5));
    const first=pool.query(path,'Yo'),duplicate=pool.query(path,'Yo');assert.equal(first,duplicate);
    await timer;assert.equal(timerRan,true);
    assert.equal((await first)[0].profileId,'1');
    assert.equal(pool.query(path,'Yo'),first);
    assert.equal((await pool.query(path,'Hera'))[0].profileId,'2');
    assert.equal((await pool.query(path,'中国'))[0].profileId,'3');
    assert.deepEqual(await pool.query(path,'"""'),[]);
  }finally{await pool.close();await rm(directory,{recursive:true,force:true});}
});
