import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { formatReplayDanmaku, formatResearchDelay, matchRatingChange } from '../server/services/replay-danmaku-summary.js';
import { createReplayEndedNotifier } from '../server/services/replay-ended-notifier.js';
import { createRealtimeDanmakuNotifier } from '../server/services/realtime-danmaku-notifier.js';

const action = (time, data) => ({Action:{world_time:time,action_data:data}});
const age = (player,name) => ({Chat:{text:JSON.stringify({messageAGP:`@#1<player_id,${player},0>升级至${name}时代。`})}});
const replay = {
  matchId:'123', summary:{duration:120000,teams:[{players:[{profile_id:197964,player_number:1,name:'主播'}]},{players:[{profile_id:42,player_number:2,name:'对手'}]}]},
  full:{chapters:[{operations:[{Sync:{time_increment:10000}},age(1,'封建'),
    action(15000,{Research:{player_id:1,technology_type:202}}),
    action(15100,{Research:{player_id:1,technology_type:202}}),
    {Sync:{time_increment:50000}},age(1,'城堡'),
    action(70000,{Research:{player_id:1,technology_type:203}}),
    action(80000,{Move:{player_id:2,x:5,y:5}})]}]}
};
test('whole-game eAPM, streamer research delays, duplicates and missing upgrades',()=>{
  assert.equal(formatReplayDanmaku(replay,'197964'),'eAPM 主播(1.0) vs 对手(0.5)，升封建后5秒点双刃斧，升城堡后10秒点弓锯');
  assert.match(formatReplayDanmaku(replay,'42'),/未研究双刃斧，未研究弓锯/);
  const noAge=structuredClone(replay);noAge.full.chapters[0].operations=noAge.full.chapters[0].operations.filter(op=>!op.Chat);
  assert.match(formatReplayDanmaku(noAge,'197964'),/缺少升封建记录/);
  assert.throws(()=>formatReplayDanmaku(replay,'999'),/玩家不匹配/);
});

test('end summary uses the shared 500 real ms sliding window',()=>{
  const recording=structuredClone(replay);
  recording.full.chapters[0].operations=[
    action(0,{Move:{player_id:1,x:1,y:1}}),
    action(850,{Move:{player_id:1,x:1,y:1}}),
    action(1701,{Move:{player_id:1,x:1,y:1}}),
    action(100,{Move:{player_id:2,x:2,y:2}}),
  ];
  assert.match(formatReplayDanmaku(recording,'197964'),/^eAPM 主播\(1\.0\) vs 对手\(0\.5\)/);
});

test('automatic pause skips queries and parsing, expires old jobs, and resumes new games at expiry',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'paused-ended-'));
  let clock=1_000_000,requests=0,parses=0,sends=0;
  const until=clock+2*86400000;
  const notifier=createReplayEndedNotifier({statePath:join(directory,'state.json'),profileIds:['197964'],now:()=>clock,isPaused:()=>clock<until,
    replayService:{get:async()=>{parses++;throw new Error('not expected');}},send:async()=>{sends++;},
    fetchImpl:async url=>{requests++;return Response.json({matchId:url.split('/').at(-1),finished:null});}});
  try {
    await notifier.observe({id:123,players:[{profileId:197964},{profileId:42}]});
    clock+=31000;await notifier.tick();assert.equal(requests,0);assert.equal(parses,0);assert.equal(sends,0);
    clock=until;await notifier.tick();assert.equal(requests,0);
    await notifier.observe({id:124,players:[{profileId:197964},{profileId:42}]});
    clock+=31000;await notifier.tick();assert.equal(requests,1);assert.equal(parses,0);assert.equal(sends,0);
  } finally {notifier.stop();await rm(directory,{recursive:true,force:true});}
});

test('end rating change uses the watched player and game mode, including missing and zero scores', () => {
  const match = { leaderboard: 'rm_1v1', teams: [{ players: [
    { profileId: 42, ratingDiff: 21 }, { profileId: 197964, ratingDiff: -21 }
  ] }] };
  assert.equal(matchRatingChange(match, '197964'), '-21分');
  assert.equal(matchRatingChange(match, '42'), '+21分');
  assert.equal(matchRatingChange({ ...match, leaderboard: 'unranked' }, '197964'), '');
  assert.equal(matchRatingChange({ leaderboard: 'rm_tg', players: [{ id: 197964, ratingDelta: 0 }] }, '197964'), '+0分');
  assert.equal(matchRatingChange({ leaderboard: 'rm_1v1', players: [{ id: 197964, ratingDiff: null }] }, '197964'), '积分未知');
  const summary = formatReplayDanmaku(replay, '197964', {}, '-21分');
  assert.ok(summary.endsWith('升城堡后10秒点弓锯, -21分'));
  assert.ok(summary.startsWith('eAPM 主播(1.0) vs 对手(0.5)，'));
});

test('team replay includes only streamer wood timings, never eAPM', () => {
  const teamReplay = structuredClone(replay);
  teamReplay.summary.teams[0].players.push({ profile_id: 43, player_number: 3, name: '队友' });
  teamReplay.summary.teams[1].players.push({ profile_id: 44, player_number: 4, name: '对手队友' });
  assert.equal(formatReplayDanmaku(teamReplay, '197964'), '升封建后5秒点双刃斧，升城堡后10秒点弓锯');
});

test('team games are tracked and terminal send failure is not retried', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'team-ended-test-'));
  let clock = 1000000, sends = 0;
  const teamReplay = structuredClone(replay);
  teamReplay.summary.teams[0].players.push({ profile_id: 43, player_number: 3, name: '队友' });
  const service = createReplayEndedNotifier({ statePath: join(directory, 'state.json'), profileIds: ['197964'], now: () => clock,
    fetchImpl: async () => ({ ok: true, json: async () => ({ matchId: 123, finished: true }) }),
    replayService: { get: async () => ({ data: gzipSync(JSON.stringify(teamReplay)) }) },
    send: async (_game, _pid, message) => { sends++; assert.ok(!message.includes('eAPM')); throw Object.assign(new Error('uncertain send'), { terminal: true }); } });
  try {
    await service.observe({ id: 123, players: [{ id: 197964 }, { id: 42 }, { id: 43 }] });
    clock += 60001; await service.tick(); clock += 120001; await service.tick();
    assert.equal(sends, 1);
  } finally { service.stop(); await rm(directory, { recursive: true, force: true }); }
});
test('poll only observed games; retry unavailable replay; persist completion across restart',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'replay-ended-test-'));
  let clock=1000000, finished=false, downloads=0, sends=0, sentMessage;
  const stages=[];
  const deps={statePath:join(directory,'state.json'),profileIds:['197964'],now:()=>clock,
    fetchImpl:async()=>({ok:true,json:async()=>({matchId:123,finished,leaderboard:'rm_1v1',teams:[{players:[{profileId:197964,ratingDiff:-21}]}]})}),
    prepare:async()=>{stages.push('prepare');},cancelPreparation:()=>{stages.push('cancel');},
    replayService:{get:async()=>{stages.push('parse');if(++downloads===1)throw new Error('not ready');return {data:gzipSync(JSON.stringify(replay))};}},
    send:async(_match,_profileId,message)=>{sends++;sentMessage=message;}};
  let service=createReplayEndedNotifier(deps);
  try {
    const match={id:123,players:[{id:197964,name:'Yo'},{id:42,name:'Blve'}]};
    await service.tick();await service.observe(match);
    match.players[0].name='_LY_Yo';match.players[1].name='ANKR.Blve';
    service.stop();service=createReplayEndedNotifier(deps);
    clock+=60001;await service.tick();assert.equal(downloads,0);
    finished=true;clock+=60001;await service.tick();assert.equal(downloads,1);assert.equal(sends,0);
    assert.deepEqual(stages,['prepare','parse','cancel']);
    service.stop();service=createReplayEndedNotifier(deps);
    clock+=9999;await service.tick();assert.equal(downloads,1);assert.equal(sends,0);
    clock+=1;await service.tick();assert.equal(sends,1);
    assert.match(sentMessage,/^eAPM Yo\(1\.0\) vs Blve\(0\.5\)/);
    assert.ok(sentMessage.endsWith(', -21分'));
    assert.deepEqual(stages,['prepare','parse','cancel','prepare','parse']);
    service.stop();service=createReplayEndedNotifier(deps);
    await service.tick();await service.observe(match);clock+=120001;await service.tick();assert.equal(sends,1);
  } finally {service.stop();await rm(directory,{recursive:true,force:true});}
});
test('second replay failure cancels the summary permanently, including across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-retry-limit-'));
  let clock = 1000000, downloads = 0, sends = 0;
  const deps = { statePath: join(directory, 'state.json'), profileIds: ['197964'], now: () => clock,
    fetchImpl: async () => ({ ok: true, json: async () => ({ matchId: 123, finished: true }) }),
    replayService: { get: async () => { downloads++; throw new Error('download timeout'); } },
    send: async () => { sends++; } };
  let service = createReplayEndedNotifier(deps);
  try {
    await service.tick();
    await service.observe({ id: 123, players: [{ id: 197964 }, { id: 42 }] });
    clock += 30000; await service.tick(); assert.equal(downloads, 1);
    service.stop(); service = createReplayEndedNotifier(deps);
    clock += 9999; await service.tick(); assert.equal(downloads, 1);
    clock++; await service.tick(); assert.equal(downloads, 2);
    service.stop(); service = createReplayEndedNotifier(deps);
    clock += 120000; await service.tick(); assert.equal(downloads, 2); assert.equal(sends, 0);
  } finally { service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('end status query failures also stop after one retry without downloading or sending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'replay-query-limit-'));
  let clock = 1000000, queries = 0;
  const service = createReplayEndedNotifier({ statePath: join(directory, 'state.json'), profileIds: ['197964'], now: () => clock,
    fetchImpl: async () => { queries++; return { ok: false, status: 429 }; },
    replayService: { get: async () => { assert.fail('must not download'); } },
    send: async () => { assert.fail('must not send'); } });
  try {
    await service.tick();
    await service.observe({ id: 123, players: [{ id: 197964 }, { id: 42 }] });
    clock += 30000; await service.tick(); clock += 10000; await service.tick();
    clock += 120000; await service.tick(); assert.equal(queries, 2);
  } finally { service.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('end notification dedup is independent from start and survives later games',async()=>{
  let text='{}', calls=0;
  const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>text,writeFile:async(_,value)=>{text=value;},execFileAsync:async()=>{calls++;return {};},watchers:[{profileId:'197964',platform:'douyu',room:'753676'}]});
  const match={id:123,players:[{id:197964,name:'Yo'},{id:42,name:'Other'}]};
  await notifier.handleMatchAdded(match);
  await notifier.handleMatchEnded(match,'197964','summary');
  await notifier.handleMatchAdded({...match,id:124});
  await notifier.handleMatchEnded(match,'197964','summary');
  assert.equal(calls,3);
});

test('research delay seconds and minutes',()=>{
  assert.equal(formatResearchDelay(60000),'60秒');
  assert.equal(formatResearchDelay(61000),'1分1秒');
  assert.equal(formatResearchDelay(120000),'2分0秒');
  assert.equal(formatResearchDelay(-160000),'2分40秒');
});

test('end summary separates eAPM and research into two messages',async()=>{
  const messages=[];
    const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>'{}',writeFile:async()=>{},execFileAsync:async(_,args)=>{messages.push(args);return {};},watchers:[{profileId:'197964',platform:'douyu',room:'753676'}]});
  await notifier.handleMatchEnded({id:999,players:[{id:197964},{id:42}]},'197964','eAPM Yo(68.9) vs Dennis哥(55.4)，升封建后22秒点双刃斧，升城堡后53秒点弓锯');
  assert.equal(messages.length,1);
  const args=messages[0];
  assert.equal(args[args.indexOf('--message')+1],'eAPM Yo(68.9) vs Dennis哥(55.4)');
  assert.equal(args[args.indexOf('--next-message')+1],'升封建后22秒点双刃斧，升城堡后53秒点弓锯');
});

test('partial batch failure retries only the unacknowledged message',async()=>{
  const calls=[];
  const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>'{}',writeFile:async()=>{},execFileAsync:async(_,args)=>{
    calls.push(args);
    if(calls.length===1)throw Object.assign(new Error('second failed'),{stdout:'DANMAKU_SENT {"index":0}\n'});
    return {};
  },watchers:[{profileId:'197964',platform:'douyu',room:'753676'}]});
  await notifier.handleMatchEnded({id:1000,players:[{id:197964},{id:42}]},'197964','first，second');
  assert.equal(calls.length,2);
  assert.equal(calls[1][calls[1].indexOf('--message')+1],'second');
  assert.equal(calls[1].includes('--next-message'),false);
});

test('356 rejection stops immediate retries',async()=>{
  let calls=0;
  const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>'{}',writeFile:async()=>{},execFileAsync:async()=>{
    calls++;throw new Error('返回码 356');
  },watchers:[{profileId:'197964',platform:'douyu',room:'1'}]});
  await assert.rejects(notifier.handleMatchEnded({id:99,players:[{id:197964},{id:42}]},'197964','message'),/356/);
  assert.equal(calls,1);
});

test('different rooms wait in order before opening their browser',async()=>{
  let release, entered;
  const blocked=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const calls=[];
  const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>'{}',writeFile:async()=>{},execFileAsync:async(_,args)=>{
    const room=args[args.indexOf('--room')+1];calls.push(room);
    if(room==='1'){entered();await blocked;}
    return {};
  },watchers:[{profileId:'197964',platform:'douyu',room:'1'},{profileId:'42',platform:'douyu',room:'2'}]});
  const first=notifier.handleMatchAdded({id:1,players:[{id:197964},{id:3}]});
  await started;
  try {
    const second=notifier.handleMatchAdded({id:2,players:[{id:42},{id:3}]});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,['1']);
    release();await second;
    assert.deepEqual(calls,['1','2']);
  }finally{release();await first;}
});

test('opening message reuses the prepared browser and waits for message data',async()=>{
  let launches=0, fallbackCalls=0, received='';
  const notifier=createRealtimeDanmakuNotifier({statePath:'unused',readFile:async()=>'{}',writeFile:async()=>{},
    execFileAsync:async()=>{fallbackCalls++;return {};},watchers:[{profileId:'197964',platform:'douyu',room:'1'}],
    spawnImpl:()=>{
      launches++;
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
      child.stdin=new Writable({write(data,_encoding,callback){received+=data;callback();},final(callback){callback();setImmediate(()=>child.emit('close',0));}});
      return child;
    }
  });
  const match={id:123,players:[{id:197964,name:'Yo',rating:2800},{id:42,name:'Blve',rating:2700}],map:'Arabia',server:'southeastasia'};
  await notifier.prepareMatch(match);
  assert.equal(launches,1);assert.equal(received,'');
  await notifier.handleMatchAdded(match);
  assert.equal(fallbackCalls,0);
  assert.deepEqual(JSON.parse(received),['Yo(2800) vs Blve(2700)，阿拉伯半岛，东南亚']);
  await notifier.prepareMatch(match);assert.equal(launches,1);
  await notifier.prepareMatchEnded(match,'197964');
  assert.equal(launches,2);
  received='';
  await notifier.handleMatchEnded(match,'197964','first，second');
  assert.equal(fallbackCalls,0);
  assert.deepEqual(JSON.parse(received),['first','second']);
});
