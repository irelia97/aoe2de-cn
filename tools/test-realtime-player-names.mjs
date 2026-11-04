import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cleanRealtimePlayerName,createVerifiedRealtimeNames,realtimePlayerNameOverrides,realtimePlayerIdentityOverrides,realtimePinnedProfileIds} from '../server/services/realtime-player-names.js';
import {createRealtimeService} from '../server/services/realtime-service.js';
test('requested Chinese names and PiggyKitty alternate accounts share display identities',()=>{
  assert.equal(realtimePlayerNameOverrides.get('7576082'),'徐泽');
  assert.equal(realtimePlayerNameOverrides.get('11493710'),'徐泽');
  assert.equal(realtimePlayerNameOverrides.get('243287'),'勇敢熊熊');
  assert.equal(realtimePlayerNameOverrides.get('3231530'),'猪咪');
  assert.equal(realtimePlayerIdentityOverrides.get('3231530'),realtimePlayerIdentityOverrides.get('711407'));
  assert.equal(realtimePlayerNameOverrides.get('21227185'),'Kanon');
  assert.equal(realtimePlayerIdentityOverrides.get('21227185'),'811511');
  assert.equal(realtimePinnedProfileIds.length,14);
  for(const id of realtimePinnedProfileIds){assert.equal(realtimePlayerNameOverrides.get(id),'恶魔大师');assert.equal(realtimePlayerIdentityOverrides.get(id),'211846');}
});
test('clan decorations are removed without damaging recognizable player names',()=>{
  for(const [raw,clean]of [['VIT | Hera','Hera'],['_LY_抖音肥龙','抖音肥龙'],['TAG_Sora Kuma','Sora Kuma'],['CNZS_CC','CC'],['Oni.TheViper','TheViper'],['Mr.Bean','Mr.Bean'],['Andre_2i','Andre_2i'],['F1Re','F1Re'],['_Barles_','Barles']])assert.equal(cleanRealtimePlayerName(raw),clean);
  assert.equal(cleanRealtimePlayerName('[KYO] Player','KYO'),'Player');
});
test('verified AoE2Recs identity unifies alternate Steam accounts using newest cached record',async()=>{
  const data={ '1':{savedAt:1,profile:{player:{verified:true,id:10,name:'OldName',platform_id:3},accounts:[{id:1,platform:'steam'},{id:2,platform:'steam'}]}},'2':{savedAt:2,profile:{player:{verified:true,id:10,name:'Vivi',platform_id:3},accounts:[{id:1,platform:'steam'},{id:2,platform:'steam'},{id:3,platform:'voobly'}]}},'4':{savedAt:3,profile:{player:{verified:false,id:10,name:'Impostor',platform_id:3},accounts:[{id:1,platform:'steam'}]}}};
  let reads=0;
  const load=createVerifiedRealtimeNames({cacheDir:'/cache',readFile:async path=>{reads++;const id=path.match(/\/(\d+)\.json$/)[1];return JSON.stringify(data[id]);}});
  const names=await load(['1','2','4']);
  assert.equal(names.get('1').name,'Vivi');assert.equal(names.get('2').name,'Vivi');assert.equal(names.get('2').canonicalProfileId,'10');assert.equal(names.has('3'),false);
  await load(['1','2','4']);assert.equal(reads,3);
});

test('certified team is shared by the main profile and its alternate accounts',async()=>{
  const load=createVerifiedRealtimeNames({cacheDir:'/cache',readFile:async()=>JSON.stringify({savedAt:1,profile:{
    player:{verified:true,id:10,name:'XuanLv',team:'CN ZhongSheng',platform_id:3},
    accounts:[{id:20,platform:'steam'},{id:30,platform:'steam'}]
  }})});
  const names=await load(['10']);
  for(const id of ['10','20','30'])assert.equal(names.get(id).team,'CN ZhongSheng');
});

test('realtime team column uses certified teams rather than account clan labels',async()=>{
  class Socket{constructor(){this.readyState=1;}addEventListener(){}close(){}}
  const service=createRealtimeService({WebSocket:Socket,readFile:async()=>{throw Error('no cache');},writeFile:async()=>{},
    localProfileDetails:()=>({player:{name:'Player',team:'QingY'}}),getMediaCache:async()=>({live:[]}),
    loadRlReference:async()=>new Map([['42',{canonicalProfileId:'10'}]]),
    loadVerifiedRealtimeNames:async ids=>{assert.ok(ids.includes('10'));return new Map([['42',{name:'Verified',canonicalProfileId:'10',team:'CN ZhongSheng'}]]);},
    fetchPersonalLeaderboardStats:async()=>[],fetchLatestWorldsEdgeMatchOnce:async()=>null,forceChinaCountry:(_,c)=>c});
  await service.startRealtimeWebSockets(['42','43']);
  const payload=await service.refreshRealtimePayload(['42','43']);
  assert.equal(payload.states[0].player.team,'CN ZhongSheng');
  assert.equal(payload.states[1].player.team,'');
});
