import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAvatarCache, AVATAR_TTL } from '../server/services/avatar-cache.js';

test('avatar cache merges requests and daily warmup makes only one upstream attempt per key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aoe-avatar-'));
  let time = Date.UTC(2026,10,10), calls = 0;
  const key = 'steam:12345678901234567';
  const cache = createAvatarCache({ directory, now:()=>time, sleep:async()=>{},
    resolveUrl:async()=>{calls++;return `https://avatars.steamstatic.com/${calls}.jpg`;},
    fetchImage:async()=>new Response(`image ${calls}`,{headers:{'content-type':'image/jpeg'}}) });
  try {
    const [first,duplicate]=await Promise.all([cache.get(key),cache.get(key)]);
    assert.equal(calls,1);assert.equal(first.hash,duplicate.hash);
    await cache.prewarm([key,key],0);assert.equal(calls,1);
    time+=24*60*60_000;
    const result=await cache.prewarm([key,key],0);
    assert.equal(calls,2);assert.equal(result.refreshed,1);
    assert.equal((await cache.get(key)).hash,(await cache.peek(key)).hash);
    assert.equal(calls,2);
  } finally {cache.close();await rm(directory,{recursive:true,force:true});}
});

test('failed avatar is not retried again on the same China-calendar day', async () => {
  const directory=await mkdtemp(join(tmpdir(),'aoe-avatar-fail-'));
  let time=Date.UTC(2026,10,10),calls=0;
  const cache=createAvatarCache({directory,now:()=>time,sleep:async()=>{},resolveUrl:async()=>{calls++;throw Error('offline')}});
  try {
    await assert.rejects(cache.get('profile:1'),/offline/);
    await assert.rejects(cache.get('profile:1'),/今日暂不可用/);
    await cache.prewarm(['profile:1'],0);
    assert.equal(calls,1);
    time+=24*60*60_000;
    await cache.prewarm(['profile:1'],0);
    assert.equal(calls,2);
  } finally {cache.close();await rm(directory,{recursive:true,force:true});}
});

test('stale avatar remains readable until a later daily warmup replaces it', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'aoe-avatar-stale-'));
  let time=Date.UTC(2026,10,10),calls=0;
  const cache=createAvatarCache({directory,now:()=>time,sleep:async()=>{},resolveUrl:async()=>`https://avatars.steamstatic.com/${++calls}.jpg`,fetchImage:async()=>new Response(`image ${calls}`,{headers:{'content-type':'image/jpeg'}})});
  try {
    const first=await cache.get('profile:1');
    time+=AVATAR_TTL+1;
    assert.equal((await cache.get('profile:1')).hash,first.hash);
    assert.equal(calls,1);
    await cache.prewarm(['profile:1'],0);
    assert.equal(calls,2);
    assert.notEqual((await cache.peek('profile:1')).hash,first.hash);
  } finally {cache.close();await rm(directory,{recursive:true,force:true});}
});

test('untrusted upstream URL cannot be fetched',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'aoe-avatar-url-'));let fetched=false;
  const cache=createAvatarCache({directory,resolveUrl:async()=>'https://example.com/avatar',fetchImage:async()=>{fetched=true;}});
  try {await assert.rejects(cache.get('profile:197964'),/头像地址不可用/);assert.equal(fetched,false);}
  finally {cache.close();await rm(directory,{recursive:true,force:true});}
});
