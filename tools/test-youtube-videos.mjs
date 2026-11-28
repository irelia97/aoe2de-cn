import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYoutubeVideos, nextYoutubeVideoRefreshAt, parseYoutubeVideosTab } from '../server/services/youtube-videos.js';

const now = Date.parse('2026-11-26T12:00:00Z');

test('YouTube checks stay on fixed Beijing time slots across midnight', () => {
  const cases = [
    ['2026-11-27T18:29:59+08:00', '2026-11-27T18:30:00+08:00'],
    ['2026-11-27T18:35:00+08:00', '2026-11-27T21:30:00+08:00'],
    ['2026-11-27T21:30:00+08:00', '2026-11-28T00:30:00+08:00'],
    ['2026-11-28T00:40:00+08:00', '2026-11-28T03:30:00+08:00'],
  ];
  for (const [current, next] of cases) {
    assert.equal(nextYoutubeVideoRefreshAt(Date.parse(current)), Date.parse(next));
  }
});

const ids = ['11111111111', '22222222222', '33333333333'];
function channelPage(videoIds = ids) {
  const card = (id, type = 'VIDEO') => ({ richItemRenderer:{ content:{ lockupViewModel:{
    contentType:`LOCKUP_CONTENT_TYPE_${type}`, contentId:id,
    metadata:{ lockupMetadataViewModel:{ title:{ content:`Title ${id}` }, metadata:{ rows:[{ content:'1d ago' }] } } }
  } } } });
  const data = {
    metadata:{ channelMetadataRenderer:{ externalId:'UChOSBHAdhDG8J0yGHJrPoNQ', title:'Demo' } },
    contents:{ twoColumnBrowseResultsRenderer:{ tabs:[{ tabRenderer:{ selected:true,
      content:{ richGridRenderer:{ contents:[card('44444444444','SHORT'), ...videoIds.map(id => card(id))] } }
    } }] } }
  };
  return `<script>var ytInitialData = ${JSON.stringify(data)};</script>`;
}

test('reads all regular videos from the selected tab', () => {
  const result = parseYoutubeVideosTab(channelPage(), now);
  assert.deepEqual(result.videos.map(video => video.id), ids);
  assert.equal(result.videos[0].publishedAt, '2026-11-25T12:00:00.000Z');
  assert.equal(result.videos[0].publishedAtApproximate, true);
});

test('refresh merges newly listed videos, preserves old ones and keeps the archive on failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-videos-'));
  let fail = false;
  let current = ids;
  const options = {
    handles:['Demo'], cachePath:join(directory, 'videos.json'), now:() => now,
    fetchPage:async () => { if (fail) throw new Error('unavailable'); return channelPage(current); },
    fetchFeed:async () => [{ id:ids[0], publishedAt:'2026-11-25T15:00:00Z' }, { id:'44444444444', publishedAt:'2026-11-26T12:00:00Z' }]
  };
  try {
    const initial = createYoutubeVideos(options);
    assert.deepEqual((await initial.refresh()).checked, ['Demo']);
    const first = await initial.snapshot();
    assert.deepEqual(first.videos.map(video => video.id), ids);
    assert.equal(first.videos[0].publishedAt, '2026-11-25T15:00:00Z');
    assert.equal(first.videos[0].publishedAtApproximate, false);
    const restarted = createYoutubeVideos(options);
    current = ['55555555555', ids[0]];
    assert.deepEqual((await restarted.refresh()).checked, ['Demo']);
    const archive = await restarted.snapshot();
    assert.deepEqual(archive.videos.map(video => video.id), [...ids, current[0]]);
    fail = true;
    assert.deepEqual((await restarted.refresh()).checked, []);
    assert.deepEqual(await restarted.snapshot(), archive);
  } finally { await rm(directory, { recursive:true, force:true }); }
});

test('the newest 50 are retained across channels after deduplication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'youtube-videos-limit-'));
  const videoIds = Array.from({ length: 60 }, (_, i) => String(i).padStart(11, '0'));
  const options = {
    handles: ['First', 'Second'], cachePath: join(directory, 'videos.json'), now: () => now,
    fetchPage: async url => channelPage(url.includes('@First') ? videoIds.slice(0, 35) : videoIds.slice(30)),
    fetchFeed: async () => videoIds.map((id, i) => ({ id, publishedAt: new Date(now + i * 1000).toISOString() }))
  };
  try {
    const service = createYoutubeVideos(options);
    assert.equal((await service.refresh()).checked.length, 2);
    const { videos } = await createYoutubeVideos(options).snapshot();
    assert.deepEqual(videos.map(video => video.id).sort(), videoIds.slice(10));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
