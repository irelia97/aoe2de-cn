import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCivilizationStats, parseCivilizationFilters } from '../server/services/civilization-stats.js';
import { civilizationTrend } from '../public/civilizations.js';

test('validate filter dimensions before any SQL execution', () => {
  assert.deepEqual(parseCivilizationFilters(new URLSearchParams()), { mode:'rm_1v1',map:null,elo:null,duration:null,civ:'' });
  assert.equal(parseCivilizationFilters(new URLSearchParams('elo=6')).elo,6);
  for (const query of ['mode=unranked','map=1%20OR%201=1','elo=-1','elo=7','mode=rm_team&elo=5','duration=0','duration=5','civ=%27DROP']) {
    assert.throws(()=>parseCivilizationFilters(new URLSearchParams(query)), { statusCode:400 });
  }
});

test('civilization rates, slot usage, mirrors, team samples and combined filters remain consistent', async () => {
  const directory=await mkdtemp(join(tmpdir(),'civ-stats-')),path=join(directory,'stats.sqlite');
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE games(mode TEXT,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER);
    CREATE TABLE civilization(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER);
    CREATE TABLE matchup(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,opponent INTEGER,n INTEGER,w INTEGER,games INTEGER);
    CREATE TABLE trend_snapshots(date TEXT PRIMARY KEY,generated_at TEXT,rules TEXT);
    CREATE TABLE trend_civilization(snapshot TEXT,mode TEXT,civ TEXT,map TEXT,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER);
    CREATE TABLE trend_matchup(snapshot TEXT,mode TEXT,civ TEXT,map TEXT,elo INTEGER,duration INTEGER,opponent TEXT,n INTEGER,w INTEGER,games INTEGER);
    INSERT INTO trend_civilization VALUES('2026-10-17','rm_1v1','mongols','arabia',3,2,2,1),('2026-10-24','rm_1v1','mongols','arabia',3,2,3,2),('2026-10-24','rm_team','mongols','arabia',3,2,2,2);
    INSERT INTO trend_matchup VALUES('2026-10-17','rm_1v1','mongols','arabia',3,2,'mongols',2,1,1),('2026-10-24','rm_1v1','mongols','arabia',3,2,'franks',1,1,1),('2026-10-24','rm_team','mongols','arabia',3,2,'franks',1,1,1);
    INSERT INTO games VALUES('rm_1v1',1,3,2,2),('rm_team',1,3,2,1);
    INSERT INTO civilization VALUES('rm_1v1',1,1,3,2,3,2),('rm_1v1',2,1,3,2,1,0),
      ('rm_team',1,1,3,2,2,2),('rm_team',2,1,3,2,1,0),('rm_team',3,1,3,2,1,0);
    INSERT INTO matchup VALUES('rm_1v1',1,1,3,2,1,2,1,1),('rm_1v1',1,1,3,2,2,1,1,1),
      ('rm_team',1,1,3,2,2,1,1,1),('rm_team',1,1,3,2,3,1,1,1);`);
  const metadata={trendGranularity:'weekly_cumulative',ratings:[],durations:[],dateFrom:'2026-09-23',dateTo:'2026-10-24',generatedAt:'fixture',maps:[{id:1,slug:'arabia'},{id:2,slug:'arena'}],civs:[{id:1,slug:'mongols'},{id:2,slug:'franks'},{id:3,slug:'chinese'}]};
  for (const date of ['2026-10-10','2026-10-17','2026-10-24']) db.prepare('INSERT INTO trend_snapshots VALUES (?,?,?)').run(date,date,JSON.stringify({dateFrom:metadata.dateFrom,ratingsByMode:{rm_1v1:[],rm_team:[]},durations:[]}));
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('metadata',JSON.stringify(metadata));db.close();
  const service=createCivilizationStats({path});
  const query=text=>service.query('stats',parseCivilizationFilters(new URLSearchParams(text)));
  try {
    const winrates=await service.query('winrates');
    assert.equal(winrates.civilizations.mongols.rm_1v1.low.winRate,2/3);
    assert.equal(winrates.civilizations.mongols.rm_1v1.high,undefined);
    assert.equal(winrates.civilizations.mongols.rm_team.high.winRate,1);
    const result=await query('map=1&elo=3&duration=2&civ=mongols');
    assert.equal(result.games,2);assert.equal(result.players,4);assert.equal(result.totalGames,2);assert.equal(result.gameShare,1);
    const mongols=result.civilizations.find(row=>row.civ==='mongols');
    assert.equal(mongols.winRate,2/3);assert.equal(mongols.usage,.75);
    assert.equal(mongols.winRateDelta,0);assert.equal(mongols.usageDelta,0);assert.equal(result.comparison,null);
    const mirror=result.matchups.find(row=>row.civ==='mongols');
    assert.equal(mirror.winRate,.5);assert.equal(mirror.games,1);assert.equal(mirror.observations,2);
    assert.deepEqual(result.trend.overall.map(row=>row.winRate),[.5,2/3]);
    const days=civilizationTrend(result,'franks');
    assert.equal(days.length,3);assert.equal(days[1].overall.winRate,.5);assert.equal(days[0].overall,null);
    assert.equal(days[1].matchup,null);assert.equal(days[2].matchup.winRate,1);
    assert.equal(civilizationTrend(result,'mongols')[1].matchup.winRate,.5);
    assert.equal(days[2].overall.winRate,mongols.winRate);
    const incompatible=structuredClone(result);incompatible.trend.snapshots[1].comparable=false;
    assert.equal(civilizationTrend(incompatible)[1].overall,null);
    const team=await query('mode=rm_team&civ=mongols');
    assert.equal(team.civilizations.find(row=>row.civ==='mongols').games,2);
    assert.equal(team.matchups[0].games,1);assert.equal(team.matchups[0].observations,1);
    assert.equal(team.trend.overall[0].winRate,1);assert.equal(team.trend.matchups[0].games,1);
    const filtered=await query('elo=2&civ=mongols');assert.deepEqual(filtered.trend.overall,[]);assert.deepEqual(filtered.trend.matchups,[]);
    const empty=await query('map=2');assert.equal(empty.games,0);assert.deepEqual(empty.civilizations,[]);assert.equal(empty.totalGames,2);assert.equal(empty.gameShare,0);
    await assert.rejects(query('map=999'),{statusCode:400});
  } finally { await service.close(); await rm(directory,{recursive:true,force:true}); }
});

test('weekly deltas use identical filters and map/civilization slugs across snapshots', async () => {
  const dir=await mkdtemp(join(tmpdir(),'civ-deltas-')),path=join(dir,'stats.sqlite');
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE previous_metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE games(mode TEXT,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER);
    CREATE TABLE civilization(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER);
    CREATE TABLE previous_civilization(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,n INTEGER,w INTEGER);
    CREATE TABLE matchup(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,opponent INTEGER,n INTEGER,w INTEGER,games INTEGER);
    CREATE TABLE previous_matchup(mode TEXT,civ INTEGER,map INTEGER,elo INTEGER,duration INTEGER,opponent INTEGER,n INTEGER,w INTEGER,games INTEGER);
    INSERT INTO games VALUES('rm_1v1',1,3,2,5);
    INSERT INTO civilization VALUES('rm_1v1',1,1,3,2,4,3),('rm_1v1',2,1,3,2,6,2);
    INSERT INTO previous_civilization VALUES('rm_1v1',42,9,3,2,2,1),('rm_1v1',43,9,3,2,8,4);
    INSERT INTO matchup VALUES('rm_1v1',1,1,3,2,2,4,3,4);
    INSERT INTO previous_matchup VALUES('rm_1v1',42,9,3,2,43,2,1,2);`);
  const meta={dateFrom:'2026-09-23',dateTo:'2026-11-01',generatedAt:'new',maps:[{id:1,slug:'rm_arabia'}],civs:[{id:1,slug:'mongols'},{id:2,slug:'franks'}]};
  const prev={...meta,dateTo:'2026-10-24',generatedAt:'old',maps:[{id:9,slug:'rm_arabia'}],civs:[{id:42,slug:'mongols'},{id:43,slug:'franks'}]};
  db.prepare('INSERT INTO metadata VALUES(?,?)').run('metadata',JSON.stringify(meta));
  db.prepare('INSERT INTO previous_metadata VALUES(?,?)').run('metadata',JSON.stringify(prev));db.close();
  const service=createCivilizationStats({path});
  try {
    const result=await service.query('stats',parseCivilizationFilters(new URLSearchParams('map=1&elo=3&duration=2&civ=mongols')));
    const mongols=result.civilizations.find(row=>row.civ==='mongols'),franks=result.civilizations.find(row=>row.civ==='franks');
    assert.equal(mongols.winRateDelta,.25);assert.equal(mongols.usageDelta,.2);
    assert(Math.abs(franks.winRateDelta+1/6)<1e-10);assert(Math.abs(franks.usageDelta+.2)<1e-10);
    assert.equal(result.matchups[0].winRateDelta,.25);assert.equal(result.comparison.dateTo,'2026-10-24');
    const different=await service.query('stats',parseCivilizationFilters(new URLSearchParams('elo=2')));
    assert.equal(different.games,0);assert.deepEqual(different.civilizations,[]);
  } finally { await service.close();await rm(dir,{recursive:true,force:true}); }
});

test('missing dataset returns a controlled unavailable response', async () => {
  const service=createCivilizationStats({path:join(tmpdir(),'nonexistent-civilizations-dataset.sqlite')});
  await assert.rejects(service.query('meta'),{statusCode:503});await service.close();
});
