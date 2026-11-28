import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const youtube = 'https://www.youtube.com';
const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const refreshInterval = 3 * 60 * 60_000;
const refreshAnchor = Date.parse('1970-01-01T18:30:00+08:00');
export const youtubeVideoLimit = 50;

export function nextYoutubeVideoRefreshAt(now) {
  return refreshAnchor + (Math.floor((now - refreshAnchor) / refreshInterval) + 1) * refreshInterval;
}

function findRelativeDate(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.content === 'string' && /\bago$/i.test(value.content)) return value.content;
  for (const child of Object.values(value)) {
    const match = findRelativeDate(child);
    if (match) return match;
  }
  return '';
}

function approximateDate(value, now) {
  const match = String(value).match(/\b(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|yrs?|y)\s+ago$/i);
  if (!match) return null;
  const unit = match[2].toLowerCase();
  const seconds = unit.startsWith('mo') ? 2_629_746 : ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31_556_952 })[unit[0]];
  const date = new Date(now - Number(match[1]) * seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseYoutubeVideosTab(html, now = Date.now()) {
  const script = String(html).match(/\bytInitialData\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
  if (!script) throw new Error('视频标签页缺少频道数据');
  const data = JSON.parse(script[1]);
  const metadata = data.metadata?.channelMetadataRenderer;
  const channelId = metadata?.externalId;
  if (!channelIdPattern.test(channelId || '')) throw new Error('视频标签页缺少频道 ID');
  const selected = data.contents?.twoColumnBrowseResultsRenderer?.tabs
    ?.find(tab => tab.tabRenderer?.selected)?.tabRenderer;
  const items = selected?.content?.richGridRenderer?.contents;
  if (!Array.isArray(items)) throw new Error('视频标签页没有视频网格');
  const rows = new Map();
  for (const item of items) {
    const content = item.richItemRenderer?.content;
    const card = content?.lockupViewModel;
    const legacy = content?.videoRenderer;
    if (card && card.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') continue;
    const id = card?.contentId || legacy?.videoId;
    if (!videoIdPattern.test(id || '') || rows.has(id)) continue;
    const cardMeta = card?.metadata?.lockupMetadataViewModel;
    const title = cardMeta?.title?.content || legacy?.title?.simpleText || legacy?.title?.runs?.map(run => run.text).join('');
    if (!title) continue;
    const relative = legacy?.publishedTimeText?.simpleText || findRelativeDate(cardMeta?.metadata);
    const publishedAt = approximateDate(relative, now);
    rows.set(id, {
      id, platform: 'youtube', isCN: false, channel: metadata.title || '', title,
      url: `${youtube}/watch?v=${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      publishedAt, publishedAtApproximate: Boolean(publishedAt)
    });
  }
  if (!rows.size) throw new Error('视频标签页没有可识别的视频');
  return { channelId, videos: [...rows.values()] };
}

function retainRecentVideos(channels) {
  const videosById = new Map();
  for (const [handle, videos] of channels) {
    for (const video of videos) {
      if (video?.id) videosById.set(video.id, { handle, video });
    }
  }
  const latest = [...videosById.values()]
    .sort((a, b) => (Date.parse(b.video.publishedAt) || 0) - (Date.parse(a.video.publishedAt) || 0))
    .slice(0, youtubeVideoLimit);
  const retained = new Map([...channels.keys()].map(handle => [handle, []]));
  for (const { handle, video } of latest) retained.get(handle).push(video);
  return retained;
}

export function createYoutubeVideos({ handles, cachePath, fetchPage, fetchFeed, now = Date.now }) {
  let loadPromise;
  let refreshPromise;
  let updatedAt = null;
  let byHandle = new Map();

  function load() {
    loadPromise ??= readFile(cachePath, 'utf8').then(JSON.parse).then(cache => {
      updatedAt = cache.updatedAt || null;
      for (const handle of handles) {
        const videos = cache.channels?.[handle];
        if (Array.isArray(videos)) byHandle.set(handle, videos);
      }
      byHandle = retainRecentVideos(byHandle);
    }).catch(error => {
      if (error.code !== 'ENOENT') console.warn('[media] YouTube 视频缓存读取失败:', error.message);
    });
    return loadPromise;
  }

  async function refreshChannel(handle) {
    const { channelId, videos } = parseYoutubeVideosTab(await fetchPage(`${youtube}/@${handle}/videos`), now());
    const old = new Map((byHandle.get(handle) || []).map(video => [video.id, video]));
    const feed = await fetchFeed(channelId).catch(() => []);
    const dates = new Map(feed.filter(item => Number.isFinite(Date.parse(item.publishedAt)))
      .map(item => [item.id, item.publishedAt]));
    for (const video of videos) {
      const exact = dates.get(video.id);
      const known = old.get(video.id);
      if (exact) old.set(video.id, { ...video, publishedAt: exact, publishedAtApproximate: false });
      else if (known?.publishedAt) old.set(video.id, { ...video, publishedAt: known.publishedAt, publishedAtApproximate: known.publishedAtApproximate });
      else old.set(video.id, video);
    }
    return [...old.values()];
  }

  function refresh() {
    refreshPromise ??= (async () => {
      await load();
      const checked = [];
      const failed = [];
      const nextChannels = new Map(byHandle);
      for (let index = 0; index < handles.length; index += 2) {
        await Promise.all(handles.slice(index, index + 2).map(async handle => {
          try {
            const videos = await refreshChannel(handle).catch(() => refreshChannel(handle));
            nextChannels.set(handle, videos);
            checked.push(handle);
          }
          catch (error) { failed.push({ handle, error: error.message }); }
        }));
      }
      if (checked.length) {
        const refreshedAt = new Date(now()).toISOString();
        const retained = retainRecentVideos(nextChannels);
        await mkdir(dirname(cachePath), { recursive: true });
        const next = `${cachePath}.next`;
        await writeFile(next, JSON.stringify({ updatedAt: refreshedAt, channels: Object.fromEntries(retained) }));
        await rename(next, cachePath);
        byHandle = retained;
        updatedAt = refreshedAt;
      }
      return { checked, failed };
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  return {
    refresh,
    start() {
      const scheduleNext = () => {
        const current = now();
        setTimeout(update, nextYoutubeVideoRefreshAt(current) - current).unref();
      };
      const update = async () => {
        try {
          const { checked, failed } = await refresh();
          console.log(`[media] YouTube 视频更新: ${checked.length}/${handles.length} 个频道`);
          for (const entry of failed) console.warn(`[media] YouTube @${entry.handle}: ${entry.error}`);
        } catch (error) { console.warn('[media] YouTube 视频更新失败:', error.message); }
        finally { scheduleNext(); }
      };
      void load().then(() => {
        const previousSlot = nextYoutubeVideoRefreshAt(now()) - refreshInterval;
        if (Date.parse(updatedAt || '') >= previousSlot) scheduleNext();
        else void update();
      });
    },
    async snapshot() {
      await load();
      return { updatedAt, handles: [...byHandle.keys()], videos: [...byHandle.values()].flat() };
    }
  };
}
