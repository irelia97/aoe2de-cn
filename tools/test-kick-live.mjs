import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchKickLive } from '../server/services/kick-live.js';
const source={name:'Monoz',url:'https://kick.com/monoz_aoe',isCN:false};
test('Kick channel API maps live title, thumbnail and viewer count',async()=>{
  const live=await fetchKickLive(source,async url=>{
    assert.equal(url,'https://kick.com/api/v1/channels/monoz_aoe');
    return {ok:true,json:async()=>({id:1,slug:'monoz_aoe',livestream:{is_live:true,session_title:'直播测试',viewer_count:66,thumbnail:{url:'https://stream.kick.com/test.jpg'}}})};
  });
  assert.equal(live.live,true);assert.equal(live.title,'直播测试');assert.equal(live.viewers,66);assert.equal(live.isCN,false);
});
test('offline channels are valid while failed or malformed responses remain errors',async()=>{
  assert.equal((await fetchKickLive(source,async()=>({ok:true,json:async()=>({id:1,slug:'monoz_aoe',livestream:null})}))).live,false);
  await assert.rejects(fetchKickLive(source,async()=>({ok:false,status:403})));
  await assert.rejects(fetchKickLive(source,async()=>({ok:true,json:async()=>({})})));
});
