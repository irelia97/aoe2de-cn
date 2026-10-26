import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutubeWatchMetadata } from '../server/services/youtube-live-metadata.js';

test('watch page uses concurrent viewers rather than cumulative video views',()=>{
  const html=`<script>var ytInitialPlayerResponse=${JSON.stringify({
    videoDetails:{videoId:'sQzhBT3C2W0',title:'【TAG】10/26｜老朋友TG',isLive:true,channelId:'UCae02KfwuahRPH8UtJCghNA',viewCount:'365'},
  })};</script><script>var ytInitialData=${JSON.stringify({
    videoPrimaryInfoRenderer:{viewCount:{videoViewCountRenderer:{viewCount:{runs:[{text:'112'},{text:' watching now'}]},isLive:true,originalViewCount:'112'}}},
  })};</script>`;
  assert.deepEqual(parseYoutubeWatchMetadata(html),{
    videoId:'sQzhBT3C2W0',channelId:'UCae02KfwuahRPH8UtJCghNA',title:'【TAG】10/26｜老朋友TG',live:true,viewers:112,
  });
});

test('watch page does not mistake archive views for current viewers',()=>{
  const html=`"videoDetails":${JSON.stringify({videoId:'abcdefghijk',title:'直播回放',isLive:false,channelId:'channel',viewCount:'1234'})}`;
  assert.deepEqual(parseYoutubeWatchMetadata(html),{videoId:'abcdefghijk',channelId:'channel',title:'直播回放',live:false,viewers:null});
  assert.equal(parseYoutubeWatchMetadata('<html>channel only</html>'),null);
});
