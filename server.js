import { BoundedCache } from './server/services/bounded-cache.js';
import { createCivilizationStats, parseCivilizationFilters } from './server/services/civilization-stats.js';
import { createBackgroundClient } from './server/services/background-client.js';
import { queueDanmakuMatch } from './server/services/danmaku-outbox.js';
import { streamResponse } from './server/services/response-stream.js';
import { safeHttpHandler, staticFilePath } from './server/services/http-safety.js';
import { createApiProtection } from './server/services/api-protection.js';
import { createAvatarCache } from './server/services/avatar-cache.js';
import { createProfileSearchPool } from './server/services/profile-search-pool.js';
import http from 'node:http';
import { nextScheduledVideoRound } from './server/services/media-video-schedule.js';
import { appendFile, readFile, open, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ProxyAgent, WebSocket, setGlobalDispatcher } from 'undici';
import { createBilibiliRequestGate } from './server/services/bilibili-request-gate.js';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { mediaSources, mediaVideoWhitelist } from './config/media.js';
import { createLeaderboardDumpSummary } from './server/services/leaderboard-dump-summary.js';
import { createRealtimeService } from './server/services/realtime-service.js';
import { createRealtimeChat } from './server/services/realtime-chat.js';
import { recentFeedback } from './server/services/feedback-feed.js';
import { createFeedbackLikes } from './server/services/feedback-likes.js';
import { createMatchesService } from './server/services/matches-service.js';
import { leaderboardRowsFromPayloads, mergeLeaderboardData } from './server/services/leaderboard-format.js';
import { createProfileService } from './server/services/profile-service.js';
import { createGameAssetService } from './server/services/game-assets.js';
import { parseYoutubeWatchMetadata } from './server/services/youtube-live-metadata.js';
import { parseTournamentResultsHtml, tournamentResultCategories } from './server/services/liquipedia-tournament-results.js';
import { forceChinaCountry, isForcedChinaProfile } from './server/services/country-overrides.js';
const execFileAsync = promisify(execFile);

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));
const nativeFetch = globalThis.fetch;
const background = createBackgroundClient({ fetchImpl: nativeFetch });
globalThis.fetch = (input, options) => background.fetch(input, options);

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, '.cache');
const civilizationStats = createCivilizationStats({ path: process.env.AOE2_CIV_STATS_DB || '/var/lib/aoe2-match-data/stats/civilization-stats.sqlite' });
const apiProtection = createApiProtection({ statePath: join(dataDir, 'api-limits.json') });
const leaderboardDumpSummary = createLeaderboardDumpSummary({ cacheDir: dataDir, forceCountry: forceChinaCountry });
const replayAnalysisService = background;
const feedbackLogPath = join(dataDir, 'feedback-submissions.jsonl');
const feedbackLikes = createFeedbackLikes(join(dataDir, 'feedback-likes.sqlite'));
const realtimeChat = createRealtimeChat({ path: join(dataDir, 'realtime-chat.sqlite') });
const siteTrafficPath = join(dataDir, 'site-traffic.json');
const siteDailyArchivePath = join(dataDir, 'site-daily-archive.jsonl');
const liquipediaMatchesCachePath = join(dataDir, 'liquipedia-matches.json');
const liquipediaTournamentsCachePath = join(dataDir, 'liquipedia-tournaments.json');
const liquipediaResultsCachePath = join(dataDir, 'liquipedia-tournament-results.json');
const liquipediaMatchesRefreshInterval = 60_000;
const liquipediaTournamentsRefreshInterval = 6 * 60 * 60_000;
const liquipediaResultsRefreshInterval = 12 * 60 * 60_000;
const liquipediaApiUrl = 'https://liquipedia.net/ageofempires/api.php';
const liquipediaUserAgent = 'AOE2CN/1.0 (https://aoe2cn.cc/; contact: https://aoe2cn.cc/feedback)';
const feedbackDailyLimit = 5;
const feedbackMaxLength = 1000;
const siteTrafficExcludedIps = new Set([
  '127.0.0.1',
  '::1',
  '103.42.182.205',
  ...String(process.env.SITE_STATS_EXCLUDED_IPS || '').split(',').map(value => value.trim()).filter(Boolean)
]);
const aoe2RecsProfileCacheDir = join(dataDir, 'aoe2recs-profiles');
const gameAssetCacheDir = join(dataDir, 'game-assets');
const profilePointerPath = join(dataDir, 'profile-index-current.json');
const profileDownloadPausePath = join(dataDir, 'profile-download-paused');
const profileLocalDumpPath = join(dataDir, 'profile.parquet');
const legacyProfileCsvPath = join(dataDir, 'profile.csv');
const profileDumpUrl = 'https://dump.cdn.aoe2companion.com/profile.parquet';
const profileRefreshRetryInterval = 60 * 60_000;
const forceProfileRefresh = process.env.PROFILE_REFRESH_NOW === '1';
const port = Number(process.env.PORT || 3000);
const api = 'https://aoe-api.worldsedgelink.com/community/leaderboard/getLeaderBoard2';
const types = { 1: '1v1 死亡竞赛', 2: '团队死亡竞赛', 3: '1v1 随机地图', 4: '团队随机地图', 13: '1v1 帝国战争', 14: '团队帝国战争', 15: '赛事积分' };
const mime = { '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const avatarCache = createAvatarCache({
  directory: join(dataDir, 'avatars'),
  resolveUrl: async key => {
    const [kind, id] = key.split(':');
    if (kind === 'profile') {
      const fallback = await getAoE2RecsProfile(id);
      return fallback?.profile?.avatar || '';
    }
    try {
      const response = await fetch(`https://steamcommunity.com/profiles/${id}?xml=1`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`Steam 返回 HTTP ${response.status}`);
      const xml = await response.text();
      const avatar = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/)?.[1] || xml.match(/<avatarFull>(.*?)<\/avatarFull>/)?.[1] || '';
      if (avatar) return avatar;
      throw new Error('Steam 头像暂不可用');
    } catch (error) {
      const profileId = profileDb?.prepare('SELECT profile_id AS profileId FROM profiles WHERE steam_id = ? LIMIT 1').get(id)?.profileId;
      if (profileId) {
        const fallback = await getAoE2RecsProfile(String(profileId));
        if (fallback?.profile?.avatar) return fallback.profile.avatar;
      }
      throw error;
    }
  }
});
const leaderboardCache = new Map();
const leaderboardRefreshes = new Map();
let tournamentEloPlayersCache = null;
let tournamentEloPlayersFetchedAt = 0;
const personalStatsCache = new BoundedCache(512);
const personalStatsCacheTtl = 10 * 60_000;
const livePlayerStatsCache = new BoundedCache(512);
const livePlayerStatsRefreshes = new Map();
const livePlayerStatsCacheTtl = 60 * 60_000;
const upstreamRateLimitUntil = new Map();

function rateLimitError(host, retryAfterMs = 60_000) {
  const error = new Error(`${host} 返回 HTTP 429，已进入退避冷却`);
  error.rateLimited = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function retryAfterMilliseconds(response) {
  const header = response.headers.get('retry-after');
  if (!header) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(60_000, seconds * 1000);
  const timestamp = Date.parse(header);
  return Number.isFinite(timestamp) ? Math.max(60_000, timestamp - Date.now()) : 60_000;
}

async function fetchUpstreamWithRateLimit(url, options = {}) {
  const host = new URL(url).hostname;
  const now = Date.now();
  const blockedUntil = upstreamRateLimitUntil.get(host) || 0;
  if (blockedUntil > now) throw rateLimitError(host, blockedUntil - now);
  const response = await fetch(url, options);
  if (response.status === 429) {
    const retryAfterMs = retryAfterMilliseconds(response);
    upstreamRateLimitUntil.set(host, Date.now() + retryAfterMs);
    throw rateLimitError(host, retryAfterMs);
  }
  return response;
}
// Refresh cadence is defined per leaderboard. The two most frequently viewed
// ladders update every three minutes at fixed wall-clock marks; the other ladders are
// refreshed once every six hours and staggered by one hour to spread upstream
// requests across the six-hour cycle.
const maxLeaderboardRows = 2000;
const leaderboardSchedules = {
  3: { period: 180_000, offset: 0 },
  4: { period: 180_000, offset: 30_000 },
  1: { period: 6 * 60 * 60_000, offset: 1 * 60 * 60_000 },
  2: { period: 6 * 60 * 60_000, offset: 2 * 60 * 60_000 },
  13: { period: 6 * 60 * 60_000, offset: 3 * 60 * 60_000 },
  14: { period: 6 * 60 * 60_000, offset: 4 * 60 * 60_000 },
  15: { period: 60 * 60_000, offset: 5 * 60 * 60_000 }
};
const ladderOrder = Object.keys(leaderboardSchedules).map(Number);
const cacheWaiters = new Map();
const aoe2RecsProfileCache = new BoundedCache(512);
const aoe2RecsProfileRefreshes = new Map();
const gameAssetRefreshes = new Map();
const aoe2RecsProfileCacheTtl = 48 * 60 * 60_000;
const worldsEdgeMatchCacheDir = join(dataDir, 'worldsedge-matches');
const worldsEdgeMatchCacheTtl = 10 * 60_000;
const worldsEdgeMatchCache = new BoundedCache(512);
const worldsEdgeMatchRefreshes = new Map();
let profileDb = null;
let profileCache = null;
let profileRefreshPromise = null;
const profileRefreshState = { refreshing: false, stage: '等待启动', downloadedBytes: 0, totalBytes: 0, processedRows: 0, startedAt: null, error: null };
const mediaVideoRequestGapMin = 90_000;
const mediaVideoRequestGapMax = 120_000;
const mediaVideoCircuitBaseDelay = 12 * 60 * 60_000;
const mediaVideoCircuitMaxDelay = 24 * 60 * 60_000;
const mediaLiveRefreshInterval = 2 * 60_000;
const mediaLiveSourceTimeout = 30_000;
const mediaLiveStatsTimeout = 20_000;
const mediaLiveRoundTimeout = 90_000;
const mediaLiveFailedSourceGrace = 10 * 60_000;
const bilibiliCookiePath = join(dataDir, 'bilibili-cookie.txt');
const bilibiliCookie = process.env.BILIBILI_COOKIE || process.env.BILI_COOKIE || (() => {
  try { return readFileSync(bilibiliCookiePath, 'utf8').trim(); } catch { return ''; }
})();
console.log(`[media] bilibili browser cookie loaded: ${bilibiliCookie.length > 0 ? 'yes' : 'no'} (${bilibiliCookie.length} chars)`);
const bilibiliUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const mediaVideoCachePath = join(dataDir, 'media-videos.json');
const mediaLiveCachePath = join(dataDir, 'media-live.json');
const mediaVideoStatePath = join(dataDir, 'media-video-state.json');
const mediaVideoPausePath = join(dataDir, 'media-video-paused');
const mediaThumbnailCacheDir = join(dataDir, 'media-thumbnails');
const bilibiliUpdatesCachePath = join(dataDir, 'bilibili-updates.json');
const bilibiliUpdatesReadlistUrl = 'https://www.bilibili.com/read/readlist/rl153587';
const bilibiliUpdatesListApi = 'https://api.bilibili.com/x/article/list/web/articles?id=153587&web_location=333.1400';
const bilibiliUpdatesRefreshInterval = 12 * 60 * 60_000;
let bilibiliUpdatesCache = null;
let bilibiliUpdatesRefreshPromise = null;
let bilibiliUpdatesRefreshTimer = null;
const buildOrdersCachePath = join(dataDir, 'build-orders.json');
let buildOrdersCache = null;
const selectedStreamersPath = join(root, 'map', 'aoc-selected-streamers.json');
const rlReferencePath = join(root, 'map', 'aoc-player-links.json');

function mediaVideoPaused() {
  if (!existsSync(mediaVideoPausePath)) return false;
  try {
    const until = Date.parse(readFileSync(mediaVideoPausePath, 'utf8').trim());
    if (Number.isFinite(until) && Date.now() >= until) {
      unlinkSync(mediaVideoPausePath);
      return false;
    }
  } catch {}
  return true;
}

function mediaVideoPauseUntil() {
  if (!existsSync(mediaVideoPausePath)) return 0;
  try {
    const until = Date.parse(readFileSync(mediaVideoPausePath, 'utf8').trim());
    return Number.isFinite(until) ? until : 0;
  } catch {
    return 0;
  }
}
const mediaCache = {
  data: { videos: [], live: [], updatedAt: null, nextRefreshAt: null, videosUpdatedAt: null, liveUpdatedAt: null, nextVideosRefreshAt: null, nextLiveRefreshAt: null },
  videosSavedAt: 0,
  liveSavedAt: 0
};
let mediaVideosRefreshPromise = null;
let mediaVideoSchedulerTimer = null;
let mediaVideoStateLoaded = false;
let mediaVideoNextRequestAt = 0;
let mediaVideoBlockedUntil = 0;
let bilibiliApiBlockedUntil = 0;
let mediaVideoRateLimitStrikes = 0;
const mediaVideoSourceStates = new Map();
const mediaVideoCycleSeen = new Set();
let mediaVideoCycleOrder = [];
let mediaVideoCycleActive = false;
let mediaLiveRefreshPromise = null;
let mediaPersistentVideosLoaded = false;
let mediaPersistentLiveLoaded = false;
let selectedStreamers = null;
let rlReferenceById = null;

async function loadSelectedStreamers() {
  if (selectedStreamers) return selectedStreamers;
  try {
    const data = JSON.parse(await readFile(selectedStreamersPath, 'utf8'));
    selectedStreamers = (Array.isArray(data.players) ? data.players : []).flatMap((player, sourceOrder) => {
      const links = player.live_links || {};
      return Object.entries(links).flatMap(([platform, urls]) => (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(url => ({
        platform,
        url: String(url),
        name: player.name || '',
        rl: Array.isArray(player.rl) ? player.rl.map(String) : [],
        isCN: Boolean(player.isCN),
        sourceOrder
      })));
    });
  } catch (error) {
    console.warn('[media] selected streamer data unavailable:', error.message);
    selectedStreamers = [];
  }
  return selectedStreamers;
}

async function loadRlReference() {
  if (rlReferenceById) return rlReferenceById;
  rlReferenceById = new Map();
  try {
    const data = JSON.parse(await readFile(rlReferencePath, 'utf8'));
    for (const player of Array.isArray(data.players) ? data.players : []) {
      const ids = (Array.isArray(player.rl) ? player.rl : []).map(id => String(id).trim()).filter(Boolean);
      const canonicalProfileId = ids.find(id => /^\d+$/.test(id)) || ids[0] || '';
      for (const key of ids) {
        rlReferenceById.set(key, { name: player.name || '', canonicalProfileId, liveLinks: player.live_links || {}, socialLinks: player.social_links || {} });
      }
    }
  } catch (error) {
    console.warn('[profile] RL reference data unavailable:', error.message);
  }
  return rlReferenceById;
}

function mediaText(value) {
  return String(value ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function withMediaTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mediaXmlTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? mediaText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
}

const bilibiliRequestGate = createBilibiliRequestGate({
  getBlockedUntil: host => host === 'api.bilibili.com' ? bilibiliApiBlockedUntil : 0,
  onRisk: async ({host, blockedUntil}) => {
    if (host !== 'api.bilibili.com') return;
    await loadPersistentMediaVideoState();
    bilibiliApiBlockedUntil = Math.max(bilibiliApiBlockedUntil, blockedUntil);
    await savePersistentMediaVideoState();
  }
});
async function fetchBilibiliRequest(url, options = {}) {
  await loadPersistentMediaVideoState();
  return bilibiliRequestGate.request(url, options);
}

function bilibiliHeaders(extra = {}) {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: 'https://www.bilibili.com',
    referer: 'https://www.bilibili.com/',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': bilibiliUserAgent,
    ...(bilibiliCookie ? { cookie: bilibiliCookie } : {}),
    ...extra
  };
}

async function fetchMediaJson(url, options = {}) {
  const host = new URL(url).hostname;
  const requester = /(?:^|\.)bilibili\.com$/i.test(host) ? fetchBilibiliRequest : fetch;
  const response = await requester(url, { ...options, headers: bilibiliHeaders(options.headers || {}), signal: options.signal || AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const error = new Error(`媒体接口返回 HTTP ${response.status}`);
    error.status = response.status;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const date = Date.parse(retryAfter);
      error.retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : (Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0);
    }
    throw error;
  }
  const payload = await response.json();
  const hostname = new URL(url).hostname;
  if (/(?:^|\.)bilibili\.com$/i.test(hostname) && bilibiliRequestGate.softRisk(payload)) {
    const error = new Error('B站返回软风控占位数据，暂不更新缓存');
    error.bilibiliCode = -352;
    error.softRisk = true;
    throw error;
  }
  if (/(?:^|\.)bilibili\.com$/i.test(hostname) && Number.isFinite(Number(payload?.code)) && Number(payload.code) !== 0) {
    const error = new Error(`B站接口返回业务码 ${payload.code}${payload.message ? `：${payload.message}` : ''}`);
    error.bilibiliCode = Number(payload.code);
    throw error;
  }
  return payload;
}

async function fetchMediaText(url) {
  const hostname = new URL(url).hostname;
  const headers = /(?:^|\.)bilibili\.com$/i.test(hostname)
    ? bilibiliHeaders({ accept: 'text/html, application/atom+xml, application/xml' })
    : { accept: 'text/html, application/atom+xml, application/xml', 'user-agent': bilibiliUserAgent };
  const requester = /(?:^|\.)bilibili\.com$/i.test(hostname) ? fetchBilibiliRequest : fetch;
  const response = await requester(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`媒体页面返回 HTTP ${response.status}`);
  return response.text();
}

function bilibiliUpdateTitleMatches(title) {
  const value = String(title || '');
  if (value.includes('帝国时代2') || value.includes('帝国时代二')) return true;
  // The second rule excludes every common Arabic, full-width and Chinese
  // numeral immediately following “帝国时代”.
  return value.includes('帝国时代') && !/帝国时代[\p{N}〇零一二三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟萬億]/u.test(value);
}


function sanitizeBilibiliArticleHtml(html) {
  let value = String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|data-src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, '$1="#"');
  value = value.replace(/<img\b([^>]*?)\sdata-src=(['"])(https?:\/\/[^'"]+)\2([^>]*)>/gi, '<img$1 src="$3"$4>');
  value = value.replace(/\sloading=(['"])lazy\1/gi, '');
  value = value.replace(/<img\b(?![^>]*\breferrerpolicy=)/gi, '<img referrerpolicy="no-referrer" loading="eager"');
  // Article tags are metadata, not part of the imported article body.
  value = value.replace(/<div\b[^>]*(?:tag-list|article-tags|opus-module-topic)[^>]*>[\s\S]*?<\/div>/gi, '');
  value = value.replace(/^\s*(?:<p[^>]*>\s*)?(?:TAG|标签|话题)[:：][\s\S]*?(?:<\/p>|\n)/i, '');
  return value.trim();
}

function updatesEscapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function updatesLinkifyText(value) {
  const source = String(value ?? '');
  const pattern = /https?:\/\/[^\s<>"'，。；！？、）】]+/gi;
  let output = '';
  let lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    output += updatesEscapeHtml(source.slice(lastIndex, match.index));
    const url = match[0];
    output += `<a href="${updatesEscapeHtml(url)}" target="_blank" rel="noopener noreferrer">${updatesEscapeHtml(url)}</a>`;
    lastIndex = Number(match.index) + url.length;
  }
  return output + updatesEscapeHtml(source.slice(lastIndex));
}

function renderBilibiliOpusNode(node) {
  if (Number(node?.node_type) === 1 && node.word) {
    const word = node.word;
    let value = updatesLinkifyText(word.words || '');
    if (word.style?.bold) value = `<strong>${value}</strong>`;
    if (word.style?.italic) value = `<em>${value}</em>`;
    if (word.style?.strikethrough) value = `<s>${value}</s>`;
    if (word.style?.underline) value = `<u>${value}</u>`;
    return value;
  }
  if (Number(node?.node_type) === 4 && node.link) {
    const href = /^https?:\/\//i.test(String(node.link.link || '')) ? node.link.link : '#';
    return `<a href="${updatesEscapeHtml(href)}" target="_blank" rel="noopener noreferrer">${updatesEscapeHtml(node.link.show_text || href)}</a>`;
  }
  return '';
}

function renderBilibiliOpusContent(opus) {
  const paragraphs = Array.isArray(opus?.content?.paragraphs) ? opus.content.paragraphs : [];
  const output = [];
  let listHash = '';
  let listLevel = 0;
  const closeList = () => {
    if (!listHash) return;
    output.push('</ul>');
    listHash = '';
    listLevel = 0;
  };
  for (const paragraph of paragraphs) {
    const type = Number(paragraph?.para_type);
    const nodes = Array.isArray(paragraph?.text?.nodes) ? paragraph.text.nodes : [];
    const text = nodes.map(renderBilibiliOpusNode).join('');
    const plain = nodes.map(node => node?.word?.words || node?.link?.show_text || '').join('').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').trim();
    // Bilibili stores the opening topic tags as a dedicated paragraph.
    if (!output.length && (!plain || /^(?:#[^#]+#\s*)+$/u.test(plain))) continue;
    if (type === 6) {
      const format = paragraph.format?.list_format || {};
      const hash = String(paragraph.format?.combine_hash || `list-${output.length}`);
      const level = Math.max(1, Number(format.level) || 1);
      if (hash !== listHash || level !== listLevel) {
        closeList();
        output.push(`<ul class="updates-opus-list level-${level}">`);
        listHash = hash;
        listLevel = level;
      }
      output.push(`<li>${text}</li>`);
      continue;
    }
    closeList();
    if (type === 2) {
      const pictures = Array.isArray(paragraph.pic?.pics) ? paragraph.pic.pics : [];
      if (pictures.length) output.push(`<figure class="updates-opus-pictures">${pictures.map(picture => {
        const source = String(picture?.url || '').replace(/^http:\/\//i, 'https://');
        return source ? `<img src="${updatesEscapeHtml(source)}" alt="" referrerpolicy="no-referrer" loading="eager"${picture.width ? ` width="${Number(picture.width)}"` : ''}${picture.height ? ` height="${Number(picture.height)}"` : ''}>` : '';
      }).join('')}</figure>`);
    } else if (type === 3) {
      output.push('<hr>');
    } else if (type === 9) {
      const heading = Math.min(4, Math.max(2, Number(paragraph.format?.heading_type) + 1 || 2));
      if (text) output.push(`<h${heading}>${text}</h${heading}>`);
    } else if (text) {
      const align = Number(paragraph.format?.align);
      output.push(`<p${align === 2 ? ' class="align-center"' : align === 3 ? ' class="align-right"' : ''}>${text}</p>`);
    }
  }
  closeList();
  return output.join('');
}



async function fetchBilibiliArticleApi(id, fallback = {}) {
  const response = await fetchBilibiliRequest(`https://api.bilibili.com/x/article/view?id=${encodeURIComponent(id)}`, { headers: bilibiliHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`文章接口 HTTP ${response.status}`);
  const payload = await response.json();
  if (Number(payload?.code) !== 0 || !payload?.data) throw new Error(`文章接口业务码 ${payload?.code}`);
  const data = payload.data;
  const author = data.author?.name || data.author?.uname || fallback.author || '';
  const body = data.opus?.content?.paragraphs ? renderBilibiliOpusContent(data.opus) : (data.content || '');
  const coverSource = data.opus?.article?.cover?.[0]?.url || data.banner_url || '';
  const coverUrl = String(coverSource).replace(/^http:\/\//i, 'https://');
  const cover = coverUrl ? `<figure class="updates-opus-cover"><img src="${updatesEscapeHtml(coverUrl)}" alt="" referrerpolicy="no-referrer" loading="eager"></figure>` : '';
  return {
    id: String(data.id || id),
    title: String(data.title || fallback.title || ''),
    author,
    authorUid: String(data.author?.mid || data.author?.uid || fallback.author_uid || ''),
    publishedAt: data.publish_time ? new Date(Number(data.publish_time) * 1000).toISOString() : '',
    sourceUrl: `https://www.bilibili.com/read/cv${String(data.id || id)}`,
    contentHtml: sanitizeBilibiliArticleHtml(`${cover}${body}`)
  };
}

async function readBilibiliUpdatesCache() {
  if (bilibiliUpdatesCache) return bilibiliUpdatesCache;
  try {
    bilibiliUpdatesCache = JSON.parse(await readFile(bilibiliUpdatesCachePath, 'utf8'));
  } catch {
    bilibiliUpdatesCache = { updatedAt: null, articles: [] };
  }
  if (!Array.isArray(bilibiliUpdatesCache.articles)) bilibiliUpdatesCache.articles = [];
  return bilibiliUpdatesCache;
}

async function refreshBilibiliUpdates() {
  if (bilibiliUpdatesRefreshPromise) return bilibiliUpdatesRefreshPromise;
  bilibiliUpdatesRefreshPromise = (async () => {
    const response = await fetchBilibiliRequest(bilibiliUpdatesListApi, { headers: bilibiliHeaders(), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Bilibili 文集接口 HTTP ${response.status}`);
    const payload = await response.json();
    const list = Array.isArray(payload?.data?.articles) ? payload.data.articles : [];
    const selected = list.filter(article => bilibiliUpdateTitleMatches(article.title)).sort((a, b) => Number(b.publish_time || 0) - Number(a.publish_time || 0));
    const previousCache = await readBilibiliUpdatesCache();
    const existingArticles = previousCache.formatVersion === 5 ? previousCache.articles : [];
    const cachedIds = new Set(existingArticles.map(article => String(article.id)));
    const newItems = selected.filter(article => !cachedIds.has(String(article.id || '')));
    const newArticles = new Array(newItems.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < newItems.length) {
        const index = cursor++;
        const item = newItems[index];
        const id = String(item.id || '');
        try {
          const parsed = await fetchBilibiliArticleApi(id, item);
          newArticles[index] = { ...parsed, summary: item.summary || '', words: item.words || 0, publishTime: item.publish_time || 0 };
        } catch (error) {
          if (isBilibiliRateLimit(error)) throw error;
          console.warn(`[updates] article ${id} failed:`, error.message);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, () => worker()));
    const articles = [...existingArticles, ...newArticles.filter(Boolean)].sort((a, b) => Number(b.publishTime || 0) - Number(a.publishTime || 0));
    const result = { formatVersion: 5, updatedAt: new Date().toISOString(), sourceUrl: bilibiliUpdatesReadlistUrl, author: payload?.data?.author?.name || payload?.data?.author?.uname || '灵梦の蝴蝶结', articles };
    await mkdir(dataDir, { recursive: true });
    await writeFile(bilibiliUpdatesCachePath, JSON.stringify(result), 'utf8');
    bilibiliUpdatesCache = result;
    return result;
  })().finally(() => { bilibiliUpdatesRefreshPromise = null; });
  return bilibiliUpdatesRefreshPromise;
}

async function getBilibiliUpdates(articleId = '') {
  const cached = await readBilibiliUpdatesCache();
  if (cached.formatVersion !== 5 || !cached.articles.length || Date.now() - Date.parse(cached.updatedAt || 0) > bilibiliUpdatesRefreshInterval) {
    try { await refreshBilibiliUpdates(); } catch (error) { console.warn('[updates] refresh failed:', error.message); }
  }
  const current = bilibiliUpdatesCache || cached;
  const articles = Array.isArray(current.articles) ? current.articles : [];
  const selected = articles.find(article => String(article.id) === String(articleId)) || articles[0] || null;
  const withAuthor = article => article ? { ...article, author: article.author || current.author || '灵梦の蝴蝶结' } : article;
  return { updatedAt: current.updatedAt || null, sourceUrl: current.sourceUrl || bilibiliUpdatesReadlistUrl, articles: articles.map(({ contentHtml, ...article }) => withAuthor(article)), article: withAuthor(selected) };
}

function scheduleBilibiliUpdatesRefresh(delay = bilibiliUpdatesRefreshInterval) {
  clearTimeout(bilibiliUpdatesRefreshTimer);
  bilibiliUpdatesRefreshTimer = setTimeout(async () => {
    try {
      const before = (await readBilibiliUpdatesCache()).articles.length;
      const refreshed = await refreshBilibiliUpdates();
      const added = Math.max(0, refreshed.articles.length - before);
      console.log(`[updates] scheduled refresh complete: ${refreshed.articles.length} articles${added ? `, ${added} new` : ''}`);
    } catch (error) {
      console.warn('[updates] scheduled refresh failed:', error.message);
    } finally {
      scheduleBilibiliUpdatesRefresh();
    }
  }, Math.max(1_000, delay));
  bilibiliUpdatesRefreshTimer.unref?.();
}

async function startBilibiliUpdatesLifecycle() {
  const cached = await readBilibiliUpdatesCache();
  const updatedAt = Date.parse(cached.updatedAt || '');
  const elapsed = Number.isFinite(updatedAt) ? Date.now() - updatedAt : bilibiliUpdatesRefreshInterval;
  const delay = Math.max(1_000, bilibiliUpdatesRefreshInterval - Math.max(0, elapsed));
  scheduleBilibiliUpdatesRefresh(delay);
  console.log(`[updates] next collection check: ${new Date(Date.now() + delay).toISOString()}`);
}

async function readBuildOrdersCache() {
  if (buildOrdersCache) return buildOrdersCache;
  try {
    buildOrdersCache = JSON.parse(await readFile(buildOrdersCachePath, 'utf8'));
  } catch {
    buildOrdersCache = { formatVersion: 1, updatedAt: null, items: [] };
  }
  if (!Array.isArray(buildOrdersCache.items)) buildOrdersCache.items = [];
  return buildOrdersCache;
}

async function getBuildOrders(slug = '') {
  const current = await readBuildOrdersCache();
  const items = Array.isArray(current.items) ? current.items : [];
  return {
    updatedAt: current.updatedAt || null,
    items,
    item: items.find(entry => entry.slug === slug) || null
  };
}

async function getMediaThumbnail(url, id, maxAgeMs = 0) {
  const safeId = String(id || 'thumbnail').replace(/[^a-zA-Z0-9_-]/g, '_');
  const target = join(mediaThumbnailCacheDir, `${safeId}.img`);
  let staleData = null;
  try {
    const [data, details] = await Promise.all([readFile(target), stat(target)]);
    if (!maxAgeMs || Date.now() - details.mtimeMs < maxAgeMs) return { data, contentType: 'image/jpeg' };
    staleData = data;
  } catch {}
  try {
    const sourceUrl = new URL(url);
    if (!/(?:^|\.)(?:hdslb\.com|bilivideo\.com|ytimg\.com|jtvnw\.net|douyucdn\.cn|douyincdn\.com|douyinvod\.com|douyinpic\.com|kick\.com)$/i.test(sourceUrl.hostname)) throw new Error('不支持的封面地址');
    const response = await fetch(sourceUrl, { headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0 AOE2DE-CN media monitor/1.0' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`封面返回 HTTP ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    await mkdir(mediaThumbnailCacheDir, { recursive: true });
    await writeFile(target, data);
    return { data, contentType: response.headers.get('content-type') || 'image/jpeg' };
  } catch (error) {
    if (staleData) return { data: staleData, contentType: 'image/jpeg' };
    throw error;
  }
}

function mediaVideoItem(source, item) {
  const id = String(item.id || item.videoId || '');
  const thumbnail = String(item.thumbnail || '').replace(/^http:\/\//i, 'https://');
  return {
    id: id || `${source.platform}:${item.link || item.url || item.title}`,
    platform: source.platform || 'other',
    channel: item.channel || source.name || '',
    title: String(item.title || '未命名视频'),
    url: item.url || item.link || source.url || '#',
    thumbnail,
    publishedAt: item.publishedAt || item.published || null,
    pinned: Boolean(source.pinned || item.pinned)
  };
}

async function fetchBilibiliVideos(source) {
  const python = process.platform === 'win32' ? join(root, '.venv-danmaku', 'Scripts', 'python.exe') : join(root, '.venv-danmaku', 'bin', 'python');
  const args = [join(root, 'tools', 'check-bilibili-updates-browser.py'), '--mid', String(source.id), '--limit', '12'];
  if (source.baselineBvid) args.push('--baseline-bvid', source.baselineBvid);
  if (source.baselinePublishedAt) args.push('--baseline-published-at', String(Math.floor(Date.parse(source.baselinePublishedAt) / 1000)));
  if (!mediaVideoWhitelist.some(name => String(source.name || '').trim() === name)) args.push('--check-tags');
  const command = process.platform === 'win32' ? python : 'xvfb-run';
  const commandArgs = process.platform === 'win32' ? args : ['-a', '-s', '-screen 0 1440x1000x24', python, ...args, '--headed'];
  const {stdout} = await execFileAsync(command, commandArgs, { timeout: 240000, maxBuffer: 2 * 1024 * 1024, env: {...process.env, PLAYWRIGHT_BROWSERS_PATH: join(dataDir, 'ms-playwright')} });
  const result = JSON.parse(stdout);
  if (result.status !== 'ok') {
    const error = new Error('B站动态页检查：' + result.status + '，UP=' + source.id + '，响应=' + JSON.stringify(result.diagnostic || {}));
    if (['verification_required', 'inconsistent_empty'].includes(result.status)) error.riskResponse = true;
    throw error;
  }
  console.log('[media] browser dynamics checked: ' + (source.name || source.id) + '; BV count=' + result.videos.length);
  return result.videos.map(video => {
    const cached = mediaCache.data.videos.find(item => String(item.id) === video.bvid);
    return { ...mediaVideoItem(source, { id: video.bvid, title: video.title, url: video.url, thumbnail: video.thumbnail || cached?.thumbnail || '', publishedAt: video.publishedAt || cached?.publishedAt || null }), browserTagMatches: video.tagMatches === true || Boolean(cached) };
  });
}



async function fetchRssVideos(source) {
  const xml = await fetchMediaText(source.feedUrl);
  const entries = [...xml.matchAll(/<(?:entry|item)\b[\s\S]*?<\/(?:entry|item)>/gi)].map(match => match[0]);
  return entries.slice(0, 12).map(block => {
    const linkHref = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || mediaXmlTag(block, 'link');
    const videoId = mediaXmlTag(block, 'yt:videoId') || linkHref.match(/[?&]v=([^&]+)/)?.[1] || '';
    return mediaVideoItem(source, { id: videoId, title: mediaXmlTag(block, 'title'), url: linkHref, thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '', publishedAt: mediaXmlTag(block, 'published') || mediaXmlTag(block, 'pubDate') });
  }).filter(item => item.url && item.url !== '#');
}

async function fetchMediaVideoSource(source) {
  let results = [];
  if (source.platform === 'bilibili') results = await fetchBilibiliVideos(source);
  else if (source.platform === 'youtube') results = await fetchRssVideos({ ...source, feedUrl: source.feedUrl || `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.channelId || '')}` });
  else if (source.platform === 'rss' && source.feedUrl) results = await fetchRssVideos(source);
  const filtered = [];
  for (const item of results) {
      if (mediaVideoWhitelist.some(name => String(item.channel || '').trim() === name)) {
        filtered.push(item);
        continue;
      }
      if (item.pinned) {
        filtered.push(item);
        continue;
      }
      const title = String(item.title || '').replace(/\s+/g, '');
      let matches = Boolean(title) && !/帝国(?:时代)?[34]/.test(title) && (title.includes('帝国') || title.includes('帝国时代'));
      if (!matches && item.browserTagMatches === true) matches = true;
      if (matches) filtered.push(item);
  }
  return filtered
    .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
}

async function loadPersistentMediaVideos() {
  if (mediaPersistentVideosLoaded) return mediaCache.data.videos;
  mediaPersistentVideosLoaded = true;
  try {
    const saved = JSON.parse(await readFile(mediaVideoCachePath, 'utf8'));
    if (Array.isArray(saved.videos)) mediaCache.data.videos = saved.videos.slice(0, 50).map(item => ({ ...item, thumbnail: String(item.thumbnail || '').replace(/^http:\/\//i, 'https://') }));
    const savedAt = Date.parse(saved.savedAt);
    if (Number.isFinite(savedAt)) {
      mediaCache.videosSavedAt = savedAt;
      mediaCache.data.videosUpdatedAt = new Date(savedAt).toISOString();
      mediaCache.data.updatedAt = mediaCache.data.videosUpdatedAt;
    }
  } catch {
    // The disk cache is optional and will be created after the first refresh.
  }
  return mediaCache.data.videos;
}

async function loadPersistentMediaLive() {
  if (mediaPersistentLiveLoaded) return mediaCache.data.live;
  mediaPersistentLiveLoaded = true;
  try {
    const saved = JSON.parse(await readFile(mediaLiveCachePath, 'utf8'));
    if (Array.isArray(saved.live)) mediaCache.data.live = saved.live;
    const savedAt = Date.parse(saved.savedAt);
    if (Number.isFinite(savedAt)) {
      mediaCache.liveSavedAt = savedAt;
      mediaCache.data.liveUpdatedAt = new Date(savedAt).toISOString();
      mediaCache.data.updatedAt = mediaCache.data.liveUpdatedAt;
    }
  } catch {
    // The disk cache is created after the first successful live refresh.
  }
  return mediaCache.data.live;
}

function randomMediaDelay(min, max) {
  return Math.round(min + Math.random() * Math.max(0, max - min));
}

function mediaVideoSourceKey(source) {
  return `${source.platform || 'other'}:${source.bvid || source.id || source.channelId || source.feedUrl || source.url || source.name || 'unknown'}`;
}

function mediaTimestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadPersistentMediaVideoState() {
  if (mediaVideoStateLoaded) return;
  mediaVideoStateLoaded = true;
  try {
    const saved = JSON.parse(await readFile(mediaVideoStatePath, 'utf8'));
    mediaVideoNextRequestAt = mediaTimestamp(saved.nextRequestAt);
    mediaVideoBlockedUntil = mediaTimestamp(saved.blockedUntil);
    bilibiliApiBlockedUntil = mediaTimestamp(saved.apiBlockedUntil);
    mediaVideoRateLimitStrikes = Math.max(0, Number(saved.rateLimitStrikes) || 0);
    mediaVideoCycleOrder = [...new Set(Array.isArray(saved.cycleOrder) ? saved.cycleOrder.map(String) : [])];
    for (const key of Array.isArray(saved.cycleSeen) ? saved.cycleSeen : []) mediaVideoCycleSeen.add(String(key));
    for (const [key, value] of Object.entries(saved.sources || {})) {
      mediaVideoSourceStates.set(key, {
        nextCheckAt: mediaTimestamp(value.nextCheckAt),
        lastAttemptAt: mediaTimestamp(value.lastAttemptAt),
        lastSuccessAt: mediaTimestamp(value.lastSuccessAt),
        failureCount: Math.max(0, Number(value.failureCount) || 0),
        idleSuccesses: Math.max(0, Number(value.idleSuccesses) || 0)
      });
    }
    if (saved.scheduleVersion === 'fixed-beijing-v1') {
      mediaVideoCycleActive = saved.cycleActive === true;
    } else {
      mediaVideoCycleSeen.clear();
      mediaVideoCycleOrder = [];
      mediaVideoNextRequestAt = nextScheduledVideoRound(Date.now());
      for (const state of mediaVideoSourceStates.values()) state.nextCheckAt = 0;
    }
  } catch {
    // The scheduler state is optional and will be created after the first check.
    mediaVideoNextRequestAt = nextScheduledVideoRound(Date.now());
  }
}

function shuffledMediaVideoKeys(keys, random = Math.random) {
  const order = [...new Set(keys)];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}
function ensureMediaVideoSourceStates() {
  const keys = (mediaSources.videos || []).map(mediaVideoSourceKey);
  mediaVideoCycleOrder = mediaVideoCycleOrder.filter(key => keys.includes(key));
  const missing = keys.filter(key => !mediaVideoCycleOrder.includes(key));
  mediaVideoCycleOrder.push(...shuffledMediaVideoKeys(missing));
  const now = Date.now();
  for (const source of Array.isArray(mediaSources.videos) ? mediaSources.videos : []) {
    const key = mediaVideoSourceKey(source);
    if (!mediaVideoSourceStates.has(key)) {
      mediaVideoSourceStates.set(key, { nextCheckAt: now, lastAttemptAt: 0, lastSuccessAt: 0, failureCount: 0, idleSuccesses: 0 });
    }
  }
}

async function savePersistentMediaVideoState() {
  const sources = {};
  for (const [key, value] of mediaVideoSourceStates) {
    sources[key] = {
      nextCheckAt: value.nextCheckAt ? new Date(value.nextCheckAt).toISOString() : null,
      lastAttemptAt: value.lastAttemptAt ? new Date(value.lastAttemptAt).toISOString() : null,
      lastSuccessAt: value.lastSuccessAt ? new Date(value.lastSuccessAt).toISOString() : null,
      failureCount: value.failureCount,
      idleSuccesses: value.idleSuccesses
    };
  }
  await mkdir(dataDir, { recursive: true });
  await writeFile(mediaVideoStatePath, JSON.stringify({
    savedAt: new Date().toISOString(),
    nextRequestAt: mediaVideoNextRequestAt ? new Date(mediaVideoNextRequestAt).toISOString() : null,
    blockedUntil: mediaVideoBlockedUntil ? new Date(mediaVideoBlockedUntil).toISOString() : null,
    apiBlockedUntil: bilibiliApiBlockedUntil ? new Date(bilibiliApiBlockedUntil).toISOString() : null,
    videoFetchMode: 'browser-dynamic-v1',
    scheduleVersion: 'fixed-beijing-v1',
    cycleActive: mediaVideoCycleActive,
    rateLimitStrikes: mediaVideoRateLimitStrikes,
    cycleOrder: mediaVideoCycleOrder,
    cycleSeen: [...mediaVideoCycleSeen],
    sources
  }, null, 2), 'utf8');
}


function isBilibiliRateLimit(error) {
  return error?.riskResponse === true || error?.cooldown === true || [403, 412, 429].includes(Number(error?.status)) || [-412, -352, -403].includes(Number(error?.bilibiliCode));
}

function mediaVideoNextDueAt() {
  const sources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
  if (!sources.length) return 0;
  if (!mediaVideoCycleActive) return mediaVideoNextRequestAt || nextScheduledVideoRound(Date.now());
  const due = sources.filter(source => !mediaVideoCycleSeen.has(mediaVideoSourceKey(source))).map(source => {
    const state = mediaVideoSourceStates.get(mediaVideoSourceKey(source));
    const sourceDue = state?.nextCheckAt || Date.now();
    return source.platform === 'bilibili' ? Math.max(sourceDue, mediaVideoBlockedUntil) : sourceDue;
  });
  return Math.max(mediaVideoNextRequestAt, Math.min(...due));
}

function updateMediaVideoNextRefreshAt() {
  if (mediaVideoPaused()) {
    mediaCache.data.nextVideosRefreshAt = null;
    mediaCache.data.nextRefreshAt = mediaCache.data.nextLiveRefreshAt || null;
    return;
  }
  const nextAt = mediaVideoNextDueAt();
  mediaCache.data.nextVideosRefreshAt = nextAt ? new Date(nextAt).toISOString() : null;
  const liveNext = mediaTimestamp(mediaCache.data.nextLiveRefreshAt);
  const nextRefresh = [nextAt, liveNext].filter(Boolean);
  mediaCache.data.nextRefreshAt = nextRefresh.length ? new Date(Math.min(...nextRefresh)).toISOString() : null;
}

function scheduleMediaVideoRefresh() {
  if (mediaVideoSchedulerTimer) clearTimeout(mediaVideoSchedulerTimer);
  if (mediaVideoPaused()) {
    const resumeAt = mediaVideoPauseUntil();
    if (resumeAt > Date.now()) {
      mediaVideoSchedulerTimer = setTimeout(() => {
        mediaVideoSchedulerTimer = null;
        refreshMediaVideos()
          .catch(error => console.warn('[media] 视频刷新失败:', error.message))
          .finally(scheduleMediaVideoRefresh);
      }, Math.max(0, resumeAt - Date.now()));
    } else {
      mediaVideoSchedulerTimer = null;
    }
    updateMediaVideoNextRefreshAt();
    return;
  }
  const nextAt = mediaVideoNextDueAt();
  updateMediaVideoNextRefreshAt();
  if (!nextAt) return;
  mediaVideoSchedulerTimer = setTimeout(() => {
    mediaVideoSchedulerTimer = null;
    refreshMediaVideos()
      .catch(error => console.warn('[media] video refresh failed:', error.message))
      .finally(scheduleMediaVideoRefresh);
  }, Math.max(0, nextAt - Date.now()));
}

async function fetchBilibiliLive(source) {
  const payload = await fetchMediaJson(`https://api.live.bilibili.com/room/v1/Room/get_info?id=${encodeURIComponent(source.roomId)}`);
  const room = payload?.data || {};
  const online = Number(room.live_status) === 1;
  return { id: `bilibili:${source.roomId}`, platform: 'bilibili', name: source.name || '', url: source.url || `https://live.bilibili.com/${source.roomId}`, live: online, title: room.title || '', thumbnail: room.user_cover || room.keyframe || room.cover || '', startedAt: room.live_time || null, viewers: Number(room.online) || 0, checkedAt: new Date().toISOString() };
}

function decodeYoutubePageState(html) {
  return String(html || '')
    .replace(/\\x22/gi, '"')
    .replace(/\\x27/gi, "'")
    .replace(/\\x3d/gi, '=')
    .replace(/\\x26/gi, '&')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

async function fetchYoutubeLive(source) {
  const sourceUrl = source.liveUrl || source.url || '';
  let parsedSourceUrl = null;
  try { parsedSourceUrl = new URL(sourceUrl); } catch {}
  const isSingleVideoUrl = Boolean(parsedSourceUrl && (
    /(^|\.)youtube\.com$/i.test(parsedSourceUrl.hostname) && parsedSourceUrl.pathname.replace(/\/$/, '') === '/watch' && parsedSourceUrl.searchParams.has('v')
    || /(^|\.)youtu\.be$/i.test(parsedSourceUrl?.hostname || '')
  ));
  if (isSingleVideoUrl) {
    return { id: `youtube:${source.channelId || sourceUrl}`, platform: 'youtube', name: source.name || '', url: sourceUrl, live: false, title: '', thumbnail: '', viewers: 0, checkedAt: new Date().toISOString() };
  }
  const html = decodeYoutubePageState(await fetchMediaText(sourceUrl));
  // The channel /live page contains several recommended videos. Prefer the
  // videoDetails block explicitly marked isLive, otherwise a recommended
  // video can be mistaken for the current broadcast (wrong title/cover).
  const liveDetails = html.match(/"videoDetails":\{([\s\S]{0,12000}?)"isLive":true/i)?.[1] || '';
  const liveDetailsId = liveDetails.match(/"videoId":"([A-Za-z0-9_-]{11})"/i)?.[1] || '';
  const liveDetailsTitle = mediaText(liveDetails.match(/"title":"((?:\\.|[^"\\])*)"/i)?.[1] || '');
  const liveVideoId = liveDetailsId
    || html.match(/"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,7000}?"style":"LIVE"/i)?.[1]
    || html.match(/liveStreamabilityRenderer"[^}]*"videoId":"([A-Za-z0-9_-]{11})"/i)?.[1]
    || '';
  const videoId = liveVideoId
    || html.match(/[?&]v=([A-Za-z0-9_-]{11})/i)?.[1]
    || html.match(/"videoId":"([A-Za-z0-9_-]{11})"/i)?.[1]
    || html.match(/ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//i)?.[1]
    || '';
  const videoPos = videoId ? html.indexOf(videoId) : -1;
  const videoWindow = videoPos >= 0 ? html.slice(Math.max(0, videoPos - 1200), videoPos + 6000) : '';
  const channelLiveBadge = /"text":"LIVE"|"imageName":"LIVE"|"style":"LIVE"|"iconType":"LIVE"/i.test(videoWindow);
  let online = !/"status"\s*:\s*"LIVE_STREAM_OFFLINE"/i.test(html)
    && ( /"isLiveNow"\s*:\s*true|<meta itemprop=["']isLiveBroadcast["'] content=["']True|liveStreamabilityRenderer"\s*:\s*\{[^}]*"videoId"/i.test(html) || Boolean(liveVideoId) || channelLiveBadge );
  let title = liveDetailsTitle
    || mediaText(html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1] || '')
    || mediaText(html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i)?.[1] || '')
    || source.name;
  let viewers = Number(html.match(/(?:concurrentViewers|viewCount|viewerCount)[^\d]{0,20}(\d+)/i)?.[1] || 0);
  if (online && videoId && (!liveDetailsTitle || !viewers)) {
    try {
      const watch = parseYoutubeWatchMetadata(await fetchMediaText(`https://www.youtube.com/watch?v=${videoId}`));
      const expectedChannel = sourceUrl.match(/youtube\.com\/channel\/([^/?#]+)/i)?.[1] || source.channelId || '';
      if (watch?.videoId === videoId && (!expectedChannel || watch.channelId === expectedChannel)) {
        online = watch.live;
        if (online) {
          title = mediaText(watch.title) || title;
          viewers = watch.viewers ?? viewers;
        }
      } else if (watch?.videoId === videoId && expectedChannel && watch.channelId !== expectedChannel) {
        online = false;
      }
    } catch (error) {
      console.warn(`[media] YouTube watch metadata failed: ${source.name || sourceUrl}`, error.message);
    }
  }
  return { id: `youtube:${source.channelId || sourceUrl}`, platform: 'youtube', name: source.name || '', url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : sourceUrl, live: online, title, thumbnail: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : '', viewers, checkedAt: new Date().toISOString() };
}

async function fetchDouyinLive(source) {
  const html = await fetchMediaText(source.url);
  const stateHtml = html.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\\"/g, '"').replace(/\\u0026/g, '&');
  const room = stateHtml.match(/"room":\{"id_str":"[^"}]+","status":(\d+),"status_str":"\d+","title":"((?:\\.|[^"])*)"[\s\S]{0,700}?"cover":\{"url_list":\["([^"\\]+)/i);
  const roomStatus = Number(room?.[1] || 0);
  const title = mediaText(room?.[2] || '') || mediaPageMeta(html, 'og:title') || source.name;
  const thumbnail = room?.[3] || mediaPageMeta(html, 'og:image') || '/assets/douyin-default-cover.jpg';
  const online = roomStatus === 2;
  const viewers = Number(stateHtml.match(/(?:user_count|online_user_count|viewerCount|online_num)[^\d]{0,20}(\d+)/i)?.[1] || 0);
  return { id: `douyin:${source.url}`, platform: 'douyin', name: source.name || '', isCN: source.isCN, url: source.url, live: online, title, thumbnail, viewers, checkedAt: new Date().toISOString() };
}

async function fetchTwitchLive(source) {
  const channel = source.url.match(/twitch\.tv\/([^/?#]+)/i)?.[1] || '';
  if (!channel) return { id: `twitch:${source.url}`, platform: 'twitch', name: source.name || '', isCN: source.isCN, url: source.url, live: false, viewers: 0, checkedAt: new Date().toISOString() };
  const query = 'query StreamMetadata($channelLogin: String!) { user(login: $channelLogin) { stream { id viewersCount title game { name } previewImageURL(width: 640, height: 360) } } }';
  const payload = await fetchMediaJson('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko' },
    body: JSON.stringify([{ operationName: 'StreamMetadata', variables: { channelLogin: channel }, query }])
  });
  const stream = payload?.[0]?.data?.user?.stream || null;
  return { id: `twitch:${channel.toLowerCase()}`, platform: 'twitch', name: source.name || '', isCN: source.isCN, url: source.url, live: Boolean(stream), title: stream?.title || '', thumbnail: stream?.previewImageURL || `https://static-cdn.jtvnw.net/previews-ttv/live_user/${encodeURIComponent(channel)}-640x360.jpg`, viewers: Number(stream?.viewersCount) || 0, checkedAt: new Date().toISOString() };
}

async function fetchDouyuLive(source) {
  const roomId = source.url.match(/douyu\.com\/(\d+)/i)?.[1] || '';
  if (!roomId) return { id: `douyu:${source.url}`, platform: 'douyu', name: source.name || '', isCN: source.isCN, url: source.url, live: false, viewers: 0, checkedAt: new Date().toISOString() };
  const response = await fetch(`https://www.douyu.com/betard/${roomId}`, { headers: { accept: 'application/json, text/plain, */*', 'user-agent': 'Mozilla/5.0 AOE2DE-CN media monitor/1.0', referer: 'https://www.douyu.com/' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`斗鱼房间接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  const room = payload?.room || {};
  const live = String(room.status) === '1' && Number(room.show_status) === 1 && Number(room.videoLoop || 0) === 0;
  const thumbnail = room.room_src ? (String(room.room_src).startsWith('http') ? room.room_src : `https://rpic.douyucdn.cn/${String(room.room_src).replace(/^\/+/, '')}`) : '';
  const popularity = Number(room.room_biz_all?.hot || 0);
  return { id: `douyu:${roomId}`, platform: 'douyu', name: source.name || room.nickname || '', isCN: source.isCN, url: source.url, live, title: room.room_name || '', thumbnail, startedAt: room.show_time ? new Date(Number(room.show_time) * 1000).toISOString() : null, viewers: popularity, popularity, checkedAt: new Date().toISOString() };
}

function mediaPageMeta(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)`, 'i');
  return mediaText(html.match(pattern)?.[1] || '');
}

async function fetchGenericLive(source) {
  const html = await fetchMediaText(source.url);
  const title = mediaPageMeta(html, 'og:title') || source.name;
  let thumbnail = mediaPageMeta(html, 'og:image');
  if (!thumbnail && source.platform === 'twitch') {
    const channel = source.url.match(/twitch\.tv\/([^/?#]+)/i)?.[1] || '';
    if (channel) thumbnail = `https://static-cdn.jtvnw.net/previews-ttv/live_user/${encodeURIComponent(channel)}-640x360.jpg`;
  }
  const online = /(?:isLive|isLiveNow|live_status|room_status|show_status)[^a-z0-9]{0,12}(?:true|1)\b/i.test(html)
    || /isLiveBroadcast["']?\s*(?::|content=)["']?\s*(?:true|True|1)/i.test(html);
  const viewers = Number(html.match(/(?:concurrentViewers|viewerCount|online_num|online)[^\d]{0,20}(\d+)/i)?.[1] || 0);
  return { id: `${source.platform}:${source.url}`, platform: source.platform, name: source.name, isCN: source.isCN, url: source.url, live: online, title, thumbnail, viewers, checkedAt: new Date().toISOString() };
}

async function fetchLivePlayerLeaderboardStats(rlIds) {
  const profileIds = [...new Set((Array.isArray(rlIds) ? rlIds : [])
    .map(value => String(value).trim())
    .filter(value => /^\d+$/.test(value) && Number(value) > 0))]
    .sort((a, b) => Number(a) - Number(b));
  if (!profileIds.length) return null;
  const key = profileIds.join(',');
  const cached = livePlayerStatsCache.get(key);
  if (cached && Date.now() - cached.savedAt < livePlayerStatsCacheTtl) return cached.data;
  if (livePlayerStatsRefreshes.has(key)) return livePlayerStatsRefreshes.get(key);

  const refreshWork = (async () => {
    const endpoint = new URL('https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat');
    endpoint.search = new URLSearchParams({ title: 'age2', profile_ids: JSON.stringify(profileIds.map(Number)) });
    const response = await fetchUpstreamWithRateLimit(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`直播玩家天梯接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '直播玩家天梯接口返回失败');

    const profileByStatGroup = new Map();
    for (const group of Array.isArray(payload.statGroups) ? payload.statGroups : []) {
      const profileId = group?.members?.[0]?.profile_id;
      if (profileId != null) profileByStatGroup.set(Number(group.id), String(profileId));
    }
    const select = leaderboardId => (Array.isArray(payload.leaderboardStats) ? payload.leaderboardStats : [])
      .filter(stat => Number(stat.leaderboard_id) === leaderboardId && Number(stat.rank) > 0 && Number.isFinite(Number(stat.rating)))
      .map(stat => ({ profileId: profileByStatGroup.get(Number(stat.statgroup_id)) || null, rating: Number(stat.rating), rank: Number(stat.rank) }))
      .sort((a, b) => b.rating - a.rating || a.rank - b.rank)[0] || null;
    const data = { randomMap1v1: select(3), randomMapTeam: select(4) };
    livePlayerStatsCache.set(key, { savedAt: Date.now(), data });
    return data;
  })();
  const refresh = withMediaTimeout(refreshWork, mediaLiveStatsTimeout, `直播玩家天梯请求 ${key}`).catch(error => {
    if (cached) return cached.data;
    throw error;
  }).finally(() => livePlayerStatsRefreshes.delete(key));
  livePlayerStatsRefreshes.set(key, refresh);
  return refresh;
}

async function fetchMediaLiveSource(source) {
  if (source.platform === 'bilibili') {
    const roomId = source.url.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i)?.[1];
    return fetchBilibiliLive({ ...source, roomId, url: source.url });
  }
  if (source.platform === 'youtube_live' || source.platform === 'youtube') {
    return fetchYoutubeLive({ ...source, liveUrl: source.url, url: source.url, platform: 'youtube', isCN: source.isCN });
  }
  if (source.platform === 'twitch') return fetchTwitchLive(source);
  if (source.platform === 'douyu') return fetchDouyuLive(source);
  if (source.platform === 'douyin') return fetchDouyinLive(source);
  return fetchGenericLive(source);
}

async function fetchMediaLive() {
  const configured = await loadSelectedStreamers();
  const sources = configured.length ? configured : (Array.isArray(mediaSources.live) ? mediaSources.live : []);
  const results = [];
  const batchSize = 10;
  for (let index = 0; index < sources.length; index += batchSize) {
    const batch = sources.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(async source => {
      try {
        const item = await withMediaTimeout(
          fetchMediaLiveSource(source),
          mediaLiveSourceTimeout,
          `直播源 ${source.name || source.platform || source.url}`
        );
        return { ...item, name: source.name, rl: source.rl || [], isCN: source.isCN, sourceOrder: source.sourceOrder };
      } catch (error) {
        console.warn(`[media] live source failed: ${source.name || source.platform}`, error.message);
        return { __failed: true, platform: source.platform || '', url: source.url || '', name: source.name || '', sourceOrder: source.sourceOrder };
      }
    }));
    results.push(...batchResults.filter(Boolean));
  }
  const failedSourceKeys = new Set(results.filter(item => item?.__failed).map(item => `${item.platform}|${item.url}`));
  const priority = { twitch: 6, youtube: 5, douyin: 4, douyu: 3, bilibili: 2 };
  const selected = new Map();
  for (const item of results.filter(entry => entry.live)) {
    const key = String(item.name || item.url || item.id).trim().toLowerCase();
    const current = selected.get(key);
    if (!current || (priority[item.platform] || 1) > (priority[current.platform] || 1)) selected.set(key, item);
  }
  const enriched = [];
  for (const item of selected.values()) {
    const { rl, ...publicItem } = item;
    const profileIds = (Array.isArray(rl) ? rl : []).map(String).filter(id => /^\d+$/.test(id));
    try {
      const leaderboards = await fetchLivePlayerLeaderboardStats(rl);
      enriched.push(leaderboards ? { ...publicItem, profileIds, leaderboards } : { ...publicItem, profileIds });
    } catch (error) {
      console.warn(`[media] live player stats failed: ${item.name || item.id}`, error.message);
      enriched.push({ ...publicItem, profileIds });
    }
  }
  const sorted = enriched.sort((a, b) => {
    if (a.isCN && b.isCN) return Number(a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sourceOrder ?? Number.MAX_SAFE_INTEGER);
    if (!a.isCN && !b.isCN) return Number(b.viewers || 0) - Number(a.viewers || 0);
    return a.isCN ? -1 : 1;
  });
  Object.defineProperty(sorted, 'failedSourceKeys', { value: failedSourceKeys, enumerable: false });
  return sorted;
}

function refreshMediaVideos() {
  if (mediaVideoPaused()) {
    updateMediaVideoNextRefreshAt();
    return Promise.resolve(mediaCache.data);
  }
  if (mediaVideosRefreshPromise) return mediaVideosRefreshPromise;
  mediaVideosRefreshPromise = (async () => {
    await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState()]);
    ensureMediaVideoSourceStates();
    const now = Date.now();
    if (now < mediaVideoNextRequestAt) {
      updateMediaVideoNextRefreshAt();
      return mediaCache.data;
    }

    const videoSources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
    if (!mediaVideoCycleActive) {
      mediaVideoCycleActive = true;
      mediaVideoCycleSeen.clear();
      mediaVideoCycleOrder = shuffledMediaVideoKeys(videoSources.map(mediaVideoSourceKey));
      for (const state of mediaVideoSourceStates.values()) state.nextCheckAt = now;
      await savePersistentMediaVideoState();
    }
    const candidates = videoSources
      .map(source => ({ source, state: mediaVideoSourceStates.get(mediaVideoSourceKey(source)) }))
      .filter(({ source, state }) => state && !mediaVideoCycleSeen.has(mediaVideoSourceKey(source)) && state.nextCheckAt <= now && (source.platform !== 'bilibili' || now >= mediaVideoBlockedUntil))
      .sort((a, b) => {
        return mediaVideoCycleOrder.indexOf(mediaVideoSourceKey(a.source)) - mediaVideoCycleOrder.indexOf(mediaVideoSourceKey(b.source));
      });
    const candidate = candidates[0];
    if (!candidate) {
      updateMediaVideoNextRefreshAt();
      return mediaCache.data;
    }

    const { source, state } = candidate;
    const key = mediaVideoSourceKey(source);
    state.lastAttemptAt = now;
    mediaVideoNextRequestAt = now + randomMediaDelay(mediaVideoRequestGapMin, mediaVideoRequestGapMax);
    try {
      const videos = await fetchMediaVideoSource(source);
      const cachedIds = new Set(mediaCache.data.videos.map(item => String(item?.id || '')).filter(Boolean));
      const hasNewVideo = videos.some(item => item?.id && !cachedIds.has(String(item.id)));
      mediaVideoCycleSeen.add(key);
      state.lastSuccessAt = Date.now();
      state.failureCount = 0;
      state.idleSuccesses = hasNewVideo ? 0 : Math.min(4, state.idleSuccesses + 1);
      state.nextCheckAt = Date.now();
      if (source.platform === 'bilibili' && mediaVideoRateLimitStrikes > 0) mediaVideoRateLimitStrikes -= 1;

      if (videos.length) {
        const mergedById = new Map();
        for (const item of mediaCache.data.videos) if (item?.id) mergedById.set(String(item.id), item);
        for (const item of videos) if (item?.id) mergedById.set(String(item.id), item);
        mediaCache.data.videos = [...mergedById.values()]
          .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
          .slice(0, 50);
        await mkdir(dataDir, { recursive: true });
        await writeFile(mediaVideoCachePath, JSON.stringify({ savedAt: new Date(state.lastSuccessAt).toISOString(), videos: mediaCache.data.videos }, null, 2), 'utf8');
      }
      mediaCache.videosSavedAt = state.lastSuccessAt;
      mediaCache.data.videosUpdatedAt = new Date(state.lastSuccessAt).toISOString();
      mediaCache.data.updatedAt = mediaCache.data.videosUpdatedAt;
      console.log(`[media] video source checked: ${source.name || key}; next check ${new Date(state.nextCheckAt).toISOString()}`);
    } catch (error) {
      state.failureCount += 1;
      if (source.platform === 'bilibili' && isBilibiliRateLimit(error)) {
        mediaVideoRateLimitStrikes += 1;
        const baseBackoff = Math.min(mediaVideoCircuitMaxDelay, mediaVideoCircuitBaseDelay * (2 ** (mediaVideoRateLimitStrikes - 1)));
        const backoff = Math.min(mediaVideoCircuitMaxDelay, randomMediaDelay(baseBackoff * 0.85, baseBackoff * 1.15));
        mediaVideoBlockedUntil = Date.now() + Math.max(backoff, Number(error.retryAfterMs) || 0);
        state.nextCheckAt = mediaVideoBlockedUntil;
        console.warn(`[media] B站触发风控，暂停视频检测至 ${new Date(mediaVideoBlockedUntil).toISOString()}: ${source.name || key}；原因：${error.message}`);
      } else {
        state.nextCheckAt = Date.now() + 10 * 60_000;
        console.warn(`[media] video source failed: ${source.name || key}`, error.message);
      }
    }
    const cycleComplete = videoSources.length > 0 && videoSources.every(videoSource => mediaVideoCycleSeen.has(mediaVideoSourceKey(videoSource)));
    if (cycleComplete) {
      const cycleNextAt = nextScheduledVideoRound(Date.now() + 1);
      mediaVideoCycleActive = false;
      for (const videoSource of videoSources) {
        const videoState = mediaVideoSourceStates.get(mediaVideoSourceKey(videoSource));
        if (videoState) videoState.nextCheckAt = cycleNextAt;
      }
      mediaVideoCycleSeen.clear();
      mediaVideoNextRequestAt = cycleNextAt;
      console.log(`[media] video cycle complete; next cycle ${new Date(cycleNextAt).toISOString()}`);
    } else {
      mediaVideoNextRequestAt = Date.now() + randomMediaDelay(mediaVideoRequestGapMin, mediaVideoRequestGapMax);
    }
    updateMediaVideoNextRefreshAt();
    await savePersistentMediaVideoState();
    return mediaCache.data;
  })().finally(() => { mediaVideosRefreshPromise = null; });
  return mediaVideosRefreshPromise;
}

function refreshMediaLive() {
  if (mediaLiveRefreshPromise) return mediaLiveRefreshPromise;
  const refreshStartedAt = Date.now();
  const refreshWork = loadPersistentMediaLive().then(() => fetchMediaLive()).then(async live => {
    if (Date.now() - refreshStartedAt >= mediaLiveRoundTimeout) {
      throw new Error('直播刷新结果已超过整轮时限，丢弃过期结果');
    }
    const failedSourceKeys = live.failedSourceKeys || new Set();
    const merged = [...live];
    const mergedKeys = new Set(merged.map(item => `${item.platform || ''}|${item.url || ''}`));
    const mergeNow = Date.now();
    for (const previous of Array.isArray(mediaCache.data.live) ? mediaCache.data.live : []) {
      const key = `${previous.platform || ''}|${previous.url || ''}`;
      const checkedAt = Date.parse(previous.checkedAt || '');
      const withinFailureGrace = Number.isFinite(checkedAt) && mergeNow - checkedAt <= mediaLiveFailedSourceGrace;
      if (failedSourceKeys.has(key) && !mergedKeys.has(key) && withinFailureGrace) {
        merged.push(previous);
        mergedKeys.add(key);
      }
    }
    merged.sort((a, b) => {
      if (a.isCN && b.isCN) return Number(a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sourceOrder ?? Number.MAX_SAFE_INTEGER);
      if (!a.isCN && !b.isCN) return Number(b.viewers || 0) - Number(a.viewers || 0);
      return a.isCN ? -1 : 1;
    });
    const previousLive = Array.isArray(mediaCache.data.live) ? mediaCache.data.live : [];
    const previousLiveProfiles = new Set(previousLive.flatMap(item => Array.isArray(item.profileIds) ? item.profileIds.map(String) : []));
    const previousLiveSources = new Set(previousLive.map(item => `${item.platform || ''}|${item.url || ''}`));
    const now = Date.now();
    mediaCache.data.live = merged;
    for (const item of merged) {
      const ids = Array.isArray(item.profileIds) ? item.profileIds.map(String) : [];
      const alreadyLive = ids.length ? ids.some(id => previousLiveProfiles.has(id)) : previousLiveSources.has(`${item.platform || ''}|${item.url || ''}`);
      if (!alreadyLive) {
        try { realtimeChat.announceLive(item); } catch (error) { console.warn('[realtime-chat] live notice failed:', error.message); }
      }
    }
    for (const item of previousLive) {
      const key = `${item.platform || ''}|${item.url || ''}`;
      if (!mergedKeys.has(key) && !failedSourceKeys.has(key)) {
        try { realtimeChat.announceLiveEnd(item); } catch (error) { console.warn('[realtime-chat] live end notice failed:', error.message); }
      }
    }
    mediaCache.data.liveUpdatedAt = new Date(now).toISOString();
    mediaCache.data.nextLiveRefreshAt = new Date(now + mediaLiveRefreshInterval).toISOString();
    mediaCache.data.updatedAt = new Date(now).toISOString();
    mediaCache.data.nextRefreshAt = new Date(Math.min(
      Date.parse(mediaCache.data.nextVideosRefreshAt || mediaCache.data.nextLiveRefreshAt),
      Date.parse(mediaCache.data.nextLiveRefreshAt)
    )).toISOString();
    mediaCache.liveSavedAt = now;
    await writeFile(mediaLiveCachePath, JSON.stringify({ savedAt: new Date(now).toISOString(), live: merged }, null, 2), 'utf8');
    console.log(`[media] live refresh complete: ${merged.length} live streams; next refresh ${mediaCache.data.nextLiveRefreshAt}`);
    return mediaCache.data;
  });
  mediaLiveRefreshPromise = withMediaTimeout(refreshWork, mediaLiveRoundTimeout, '直播刷新整轮任务')
    .finally(() => { mediaLiveRefreshPromise = null; });
  return mediaLiveRefreshPromise;
}

async function startMediaVideoScheduler() {
  await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState()]);
  ensureMediaVideoSourceStates();
  if (process.env.MEDIA_VIDEO_RESET === '1') {
    const resetAt = Date.now();
    mediaVideoNextRequestAt = nextScheduledVideoRound(resetAt);
    mediaVideoCycleActive = false;
    mediaVideoBlockedUntil = 0;
    mediaVideoRateLimitStrikes = 0;
    mediaVideoCycleOrder = shuffledMediaVideoKeys((mediaSources.videos || []).map(mediaVideoSourceKey));
    mediaVideoCycleSeen.clear();
    for (const source of Array.isArray(mediaSources.videos) ? mediaSources.videos : []) {
      const state = mediaVideoSourceStates.get(mediaVideoSourceKey(source));
      if (state) {
        state.nextCheckAt = resetAt;
        state.lastAttemptAt = 0;
        state.lastSuccessAt = 0;
        state.failureCount = 0;
        state.idleSuccesses = 0;
      }
    }
    await savePersistentMediaVideoState();
    console.log('[media] video scheduler reset; starting from the first configured source');
  }
  await refreshMediaVideos();
  await savePersistentMediaVideoState();
  scheduleMediaVideoRefresh();
  return mediaCache.data;
}

function refreshMediaCache() {
  return Promise.all([startMediaVideoScheduler(), refreshMediaLive()]).then(() => mediaCache.data);
}

async function getMediaCache() {
  await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState(), loadPersistentMediaLive()]);
  ensureMediaVideoSourceStates();
  if (!mediaVideoSchedulerTimer && !mediaVideosRefreshPromise) scheduleMediaVideoRefresh();
  const now = Date.now();
  const liveStale = !mediaCache.liveSavedAt || now - mediaCache.liveSavedAt >= mediaLiveRefreshInterval;
  if (!mediaCache.data.videos.length && mediaVideoNextDueAt() <= now) {
    await refreshMediaVideos();
    scheduleMediaVideoRefresh();
  }
  if (liveStale) {
    const refresh = refreshMediaLive();
    refresh.catch(error => console.warn('[media] 后台直播刷新失败:', error.message));
  }
  return mediaCache.data;
}

const gameAssetService = createGameAssetService({ join, readFile, writeFile, mkdir, fetch, gameAssetCacheDir, gameAssetRefreshes });
const { getGameAsset } = gameAssetService;

async function fetchLeaderboardPage(id, page, count = 100) {
  const upstream = new URL(api);
  upstream.search = new URLSearchParams({ title: 'age2', leaderboard_id: String(id), sortBy: '1', start: String((page - 1) * 100 + 1), count: String(count) });
  const response = await fetchUpstreamWithRateLimit(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`上游服务返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '游戏数据服务暂不可用');
  return payload;
}

async function fetchLeaderboard(id, pageCount = Math.ceil(maxLeaderboardRows / 100), startPage = 1) {
  if (id === 15) return fetchTournamentEloLeaderboard(pageCount, startPage);
  const pages = [];
  const endPage = startPage + pageCount;
  for (let page = startPage; page < endPage; page += 2) {
    if (pages.length) await new Promise(resolve => setTimeout(resolve, 250));
    const count = Math.min(200, (endPage - page) * 100);
    pages.push(await fetchLeaderboardPage(id, page, count));
    if ((page - 1) * 100 + count >= Number(pages[0]?.rankTotal || 0)) break;
  }
  const rows = leaderboardRowsFromPayloads(pages).map(row => isForcedChinaProfile(row.profileId) ? { ...row, country: 'cn' } : row);
  const total = Math.min(maxLeaderboardRows, Number(pages[0]?.rankTotal || 0) || rows.length);
  return {
    leaderboardId: id,
    label: types[id],
    total,
    pageSize: 100,
    pageCount: Math.min(Math.ceil(maxLeaderboardRows / 100), Math.max(1, Math.ceil(total / 100))),
    loadedPages: Array.from({ length: Math.min(pageCount, Math.ceil(rows.length / 100)) }, (_, index) => startPage + index),
    updatedAt: new Date().toISOString(),
    rows: rows.slice(0, Math.min(pageCount * 100, total, maxLeaderboardRows))
  };
}

async function fetchTournamentEloLeaderboard(pageCount = 3, startPage = 1) {
  if (!tournamentEloPlayersCache || Date.now() - tournamentEloPlayersFetchedAt >= 60 * 60_000) {
    const response = await fetchUpstreamWithRateLimit('https://aoe-elo.com/', { headers: { accept: 'text/html', 'user-agent': 'AOE2DE-CN/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`aoe-elo 返回 HTTP ${response.status}`);
    const html = await response.text();
    const match = html.match(/page\.statTable\.data\s*=\s*(\[[\s\S]*?\]);\s*\/\* code \*\//);
    if (!match) throw new Error('aoe-elo 页面未找到榜单数据');
    let pageRows;
    try { pageRows = JSON.parse(match[1]); } catch { throw new Error('aoe-elo 榜单数据解析失败'); }
    if (!Array.isArray(pageRows)) throw new Error('aoe-elo 榜单数据格式无效');
    tournamentEloPlayersCache = pageRows
    .filter(row => row?.player && Number.isFinite(Number(row.elo)))
    .sort((a, b) => Number(a.rank || 1e9) - Number(b.rank || 1e9) || Number(b.elo) - Number(a.elo))
    .slice(0, maxLeaderboardRows)
    .map((row, index) => ({
      profileId: String(row.player.id || ''),
      steamId: '',
      name: String(row.player.public_name || row.player.name || '未知玩家'),
      country: String(row.player.public_country_key || row.player.country_key || '').toUpperCase(),
      rating: Number(row.elo) || 0,
      highestRating: Number(row.elo_peak) || Number(row.elo) || 0,
      wins: Number(row.num_wins) || 0,
      losses: Math.max(0, (Number(row.num_matches) || 0) - (Number(row.num_wins) || 0)),
      streak: 0,
      eloChange: Number(row.elo_dev) || 0,
      lastMatchDate: row.last_series_time ? Math.floor(Date.parse(row.last_series_time) / 1000) : 0,
      rank: Number(row.rank) > 0 ? Number(row.rank) : index + 1
    }));
    tournamentEloPlayersFetchedAt = Date.now();
  }
  const allRows = tournamentEloPlayersCache;
  const total = allRows.length;
  const start = (startPage - 1) * 100;
  const end = Math.min(start + pageCount * 100, total);
  return {
    leaderboardId: 15,
    label: types[15],
    total,
    pageSize: 100,
    pageCount: Math.max(1, Math.ceil(total / 100)),
    loadedPages: Array.from({ length: Math.max(0, Math.ceil((end - start) / 100)) }, (_, index) => startPage + index),
    updatedAt: new Date().toISOString(),
    rows: allRows.slice(start, end)
  };
}

async function fetchLeaderboardSummary(leaderboardId, country) {
  if (leaderboardId !== 15) return leaderboardDumpSummary.get(leaderboardId, country);
  const board = await getLeaderboard(15);
  const rows = (board.rows || []).filter(row => !country || country === 'all' || (country === 'CN' ? ['cn', 'mo'].includes(String(row.country).toLowerCase()) : String(row.country).toLowerCase() === country.toLowerCase()));
  const ratings = rows.map(row => Number(row.rating)).filter(Number.isFinite);
  return { averageRating: ratings.length ? ratings.reduce((a,b)=>a+b,0)/ratings.length : null, countryPlayers: rows.length, totalPlayers: board.total, top100Country: rows.filter(row=>Number(row.rank)>0&&Number(row.rank)<=100).length };
}

function settleCacheWaiters(id, error) {
  const waiters = cacheWaiters.get(id) || [];
  cacheWaiters.delete(id);
  for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
}

function refreshLeaderboard(id) {
  if (leaderboardRefreshes.has(id)) return leaderboardRefreshes.get(id);
  const refresh = fetchLeaderboard(id, Math.ceil(maxLeaderboardRows / 100), 1).then(data => {
    const expiresAt = nextLeaderboardRefreshAt(id);
    leaderboardCache.set(id, { data, expiresAt });
    settleCacheWaiters(id);
    return data;
  }).catch(error => {
    settleCacheWaiters(id, error);
    throw error;
  }).finally(() => leaderboardRefreshes.delete(id));
  leaderboardRefreshes.set(id, refresh);
  return refresh;
}

async function getLeaderboard(id) {
  let cached = leaderboardCache.get(id);
  if (!cached) {
    await refreshLeaderboard(id);
    cached = leaderboardCache.get(id);
  }
  const now = Date.now();
  return { ...cached.data, cacheExpiresAt: cached.expiresAt > now ? cached.expiresAt : nextLeaderboardRefreshAt(id, now) };
}

async function getLeaderboardPage(id, page) {
  const requestedPage = Math.min(Math.ceil(maxLeaderboardRows / 100), Math.max(1, Number(page) || 1));
  let cached = leaderboardCache.get(id);
  if (!cached) cached = { data: await getLeaderboard(id), expiresAt: nextLeaderboardRefreshAt(id) };
  if (requestedPage > 3 && !cached.data.loadedPages?.includes(requestedPage)) {
    const key = `${id}:${requestedPage}`;
    let refresh = leaderboardRefreshes.get(key);
    if (!refresh) {
      refresh = fetchLeaderboard(id, 1, requestedPage).then(pageData => {
        const current = leaderboardCache.get(id) || cached;
        const merged = mergeLeaderboardData(current.data, pageData, maxLeaderboardRows);
        leaderboardCache.set(id, { data: merged, expiresAt: current.expiresAt || nextLeaderboardRefreshAt(id) });
        return merged;
      }).finally(() => leaderboardRefreshes.delete(key));
      leaderboardRefreshes.set(key, refresh);
    }
    await refresh;
    cached = leaderboardCache.get(id);
  }
  const now = Date.now();
  return { ...cached.data, cacheExpiresAt: cached.expiresAt > now ? cached.expiresAt : nextLeaderboardRefreshAt(id, now), requestedPage };
}

function nextLeaderboardRefreshAt(id, now = Date.now()) {
  const schedule = leaderboardSchedules[Number(id)];
  if (!schedule) return now + 60_000;
  const cycleStart = Math.floor((now - schedule.offset) / schedule.period) * schedule.period + schedule.offset;
  let target = cycleStart;
  if (target <= now) target += schedule.period;
  return target;
}

function scheduleLeaderboardRefresh() {
  const now = Date.now();
  const candidates = ladderOrder.map(id => ({ id, at: nextLeaderboardRefreshAt(id, now) }));
  const next = candidates.reduce((earliest, candidate) => candidate.at < earliest.at ? candidate : earliest);
  setTimeout(() => {
    // Schedule from the wall clock immediately so slow upstream requests do not
    // shift any ladder away from its configured refresh mark.
    scheduleLeaderboardRefresh();
    refreshLeaderboard(next.id).catch(error => {
      console.error(`榜单 ${next.id} 后台更新失败:`, error.message);
    });
  }, Math.max(0, next.at - Date.now()));
}
scheduleLeaderboardRefresh();
setInterval(() => { refreshMediaLive().catch(error => console.warn('[media] live refresh failed:', error.message)); }, mediaLiveRefreshInterval);

async function downloadProfileParquet(tempPath) {
  const response = await fetch(profileDumpUrl, { headers: { accept: 'application/vnd.apache.parquet' }, signal: AbortSignal.timeout(60 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Profile Parquet 返回 HTTP ${response.status}`);
  profileRefreshState.totalBytes = Number(response.headers.get('content-length')) || 0;
  const file = await open(tempPath, 'w');
  try {
    for await (const chunk of response.body) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset);
        offset += bytesWritten;
      }
      profileRefreshState.downloadedBytes += chunk.byteLength;
    }
    await file.sync();
  } finally {
    await file.close();
  }
}



async function importProfileParquet(db, parquetPath) {
  profileRefreshState.stage = '读取 Parquet 并整理玩家资料';
  const insert = db.prepare('INSERT OR REPLACE INTO profiles(profile_id, steam_id, name, clan, last_match_time, country) VALUES (?, ?, ?, ?, ?, ?)');
  const file = await asyncBufferFromFile(parquetPath);
  const metadata = await parquetMetadataAsync(file);
  const totalRows = Number(metadata.num_rows) || 0;
  const columns = ['profileId', 'steamId', 'name', 'clan', 'country'];
  const batchSize = 50_000;
  db.exec('BEGIN');
  for (let rowStart = 0; rowStart < totalRows; rowStart += batchSize) {
    const rows = await parquetReadObjects({ file, compressors, columns, rowStart, rowEnd: Math.min(totalRows, rowStart + batchSize) });
    for (const row of rows) {
      const profileId = String(row.profileId ?? '').trim();
      const name = String(row.name ?? '').trim();
      if (!/^\d+$/.test(profileId) || !name) continue;
      insert.run(profileId, String(row.steamId ?? '').trim(), name, String(row.clan ?? '').trim(), '', String(row.country ?? '').trim());
      profileRefreshState.processedRows += 1;
    }
    db.exec('COMMIT; BEGIN');
  }
  db.exec('COMMIT');
  if (!profileRefreshState.processedRows) throw new Error('Profile Parquet 中没有读取到玩家资料');
}

function profileStatePayload() {
  return {
    ready: Boolean(profileDb),
    updatedAt: profileCache?.updatedAt || null,
    refreshing: profileRefreshState.refreshing,
    stage: profileRefreshState.stage,
    downloadedBytes: profileRefreshState.downloadedBytes,
    totalBytes: profileRefreshState.totalBytes,
    processedRows: profileRefreshState.processedRows,
    error: profileRefreshState.error
  };
}

async function loadProfileCache() {
  await mkdir(dataDir, { recursive: true });
  try {
    const pointer = JSON.parse(await readFile(profilePointerPath, 'utf8'));
    const filename = String(pointer.filename || '');
    if (!/^profile-index-[\w-]+\.sqlite$/.test(filename)) throw new Error('缓存索引文件名无效');
    const loadedDb = new DatabaseSync(join(dataDir, filename));
    const meta = loadedDb.prepare("SELECT value FROM profile_meta WHERE key = 'updatedAt'").get();
    profileDb = loadedDb;
    profileCache = { filename, updatedAt: meta?.value || pointer.updatedAt || null, format: pointer.format || null };
    if (profileCache.format === 'parquet') await rm(legacyProfileCsvPath, { force: true });
    profileRefreshState.stage = '资料索引已就绪';
    await cleanupOldProfileIndexes(filename);
    await cleanupProfileDumpArtifacts(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('读取玩家资料缓存失败:', error.message);
  }
}

async function cleanupOldProfileIndexes(currentFilename) {
  for (const filename of await readdir(dataDir)) {
    if (/^profile-index-[\w-]+\.sqlite$/.test(filename) && filename !== currentFilename) {
      await rm(join(dataDir, filename), { force: true });
    }
  }
}

async function cleanupProfileDumpArtifacts(currentFilename) {
  for (const filename of await readdir(dataDir)) {
    if ((/^profile-dump-.*\.(?:parquet|csv)(?:\.tmp)?$/.test(filename)
      || /^profile-index-.*\.sqlite\.tmp(?:-journal)?$/.test(filename))
      && filename !== currentFilename) {
      await rm(join(dataDir, filename), { force: true });
    }
  }
}

async function buildProfileCache() {
  profileRefreshState.refreshing = true;
  profileRefreshState.stage = '下载 Parquet Profile dump';
  profileRefreshState.downloadedBytes = 0;
  profileRefreshState.totalBytes = 0;
  profileRefreshState.processedRows = 0;
  profileRefreshState.startedAt = new Date().toISOString();
  profileRefreshState.error = null;
  const id = `${Date.now()}-${randomUUID()}`;
  const tempFilename = `profile-index-${id}.sqlite.tmp`;
  const finalFilename = `profile-index-${id}.sqlite`;
  const tempDumpFilename = `profile-dump-${id}.parquet.tmp`;
  const dumpFilename = `profile-dump-${id}.parquet`;
  const tempPath = join(dataDir, tempFilename);
  const finalPath = join(dataDir, finalFilename);
  const tempDumpPath = join(dataDir, tempDumpFilename);
  const dumpPath = join(dataDir, dumpFilename);
  let sourceDumpPath = dumpPath;
  let db;
  try {
    // Every scheduled refresh needs a fresh upstream snapshot. Keep the
    // previous dump and active index intact while downloading and importing.
    await downloadProfileParquet(tempDumpPath);
    await rename(tempDumpPath, dumpPath);
    profileRefreshState.stage = '建立玩家资料索引';
    db = new DatabaseSync(tempPath);
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE profiles(profile_id TEXT PRIMARY KEY, steam_id TEXT, name TEXT NOT NULL, clan TEXT, last_match_time TEXT, country TEXT); CREATE TABLE profile_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    await importProfileParquet(db, sourceDumpPath);
    if (!profileRefreshState.processedRows) throw new Error('Profile dump 中没有读取到玩家资料');
    profileRefreshState.stage = '建立昵称搜索索引';
    db.exec("CREATE VIRTUAL TABLE profile_search USING fts5(name, content='profiles', content_rowid='rowid', tokenize='trigram'); INSERT INTO profile_search(profile_search) VALUES('rebuild');");
    const updatedAt = new Date().toISOString();
    db.prepare('INSERT INTO profile_meta(key, value) VALUES (?, ?)').run('updatedAt', updatedAt);
    db.close();
    db = null;
    await rename(tempPath, finalPath);
    const nextDb = new DatabaseSync(finalPath);
    const pointerTemp = `${profilePointerPath}.tmp`;
    await writeFile(pointerTemp, JSON.stringify({ filename: finalFilename, updatedAt, format: 'parquet' }), 'utf8');
    await rename(pointerTemp, profilePointerPath);
    const previousDb = profileDb;
    const previousFilename = profileCache?.filename;
    profileDb = nextDb;
    profileCache = { filename: finalFilename, updatedAt, format: 'parquet' };
    previousDb?.close();
    if (previousFilename && previousFilename !== finalFilename) await rm(join(dataDir, previousFilename), { force: true });
    await rm(legacyProfileCsvPath, { force: true });
    if (sourceDumpPath !== profileLocalDumpPath) await rename(dumpPath, profileLocalDumpPath);
    await cleanupOldProfileIndexes(finalFilename);
    await cleanupProfileDumpArtifacts(finalFilename);
    profileRefreshState.stage = '资料索引已就绪';
    console.log(`玩家资料索引更新完成：${profileRefreshState.processedRows.toLocaleString()} 条`);
    return profileCache;
  } catch (error) {
    try { db?.close(); } catch {}
    await rm(tempPath, { force: true }).catch(() => {});
    await rm(finalPath, { force: true }).catch(() => {});
    await rm(tempDumpPath, { force: true }).catch(() => {});
    await rm(dumpPath, { force: true }).catch(() => {});
    profileRefreshState.stage = profileDb ? '沿用上次资料索引' : '资料索引暂不可用';
    profileRefreshState.error = error.message;
    throw error;
  } finally {
    profileRefreshState.refreshing = false;
  }
}

function refreshProfileCache() {
  if (profileRefreshPromise) return profileRefreshPromise;
  profileRefreshPromise = buildProfileCache().finally(() => { profileRefreshPromise = null; });
  return profileRefreshPromise;
}

function nextProfileRefreshAt(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  let target = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 6, 30, 0, 0);
  if (target <= now) target += 24 * 60 * 60_000;
  return target;
}

async function startProfileCacheLifecycle() {
  await loadProfileCache();
  try {
    await stat(profileDownloadPausePath);
    profileRefreshState.refreshing = false;
    profileRefreshState.stage = 'Profile dump 下载已暂停';
    profileRefreshState.error = null;
    return;
  } catch {}
  const needsParquetMigration = profileCache?.format !== 'parquet';
  const delay = forceProfileRefresh || needsParquetMigration ? 0 : Math.max(0, nextProfileRefreshAt() - Date.now());
  setTimeout(async function refreshAtInterval() {
    try { await refreshProfileCache(); }
    catch (error) { console.error('玩家资料 dump 更新失败:', error.message); }
    const nextDelay = profileRefreshState.error ? profileRefreshRetryInterval : Math.max(1_000, nextProfileRefreshAt() - Date.now());
    setTimeout(refreshAtInterval, nextDelay);
  }, delay);
}

function profileLastMatchTimestamp(value) {
  if (value == null || value === '') return 0;
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeAoE2RecsProfile(data) {
  const profile = data?.person && typeof data.person === 'object' ? data.person : data;
  if (!profile || typeof profile !== 'object' || profile.found === false || profile.player === null) return null;
  if (!Array.isArray(profile.accounts) && !profile.player) return null;
  return {
    avatar: typeof profile.avatar === 'string' ? profile.avatar : '',
    player: profile.player && typeof profile.player === 'object' ? profile.player : null,
    accounts: Array.isArray(profile.accounts) ? profile.accounts : [],
    live: profile.live && typeof profile.live === 'object' ? profile.live : null,
    matches: Array.isArray(profile.matches) ? profile.matches.slice(0, 20) : []
  };
}


function worldsEdgeMatchCachePath(profileId) {
  return join(worldsEdgeMatchCacheDir, `${profileId}.json`);
}

function companionEpoch(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function hasOlderUnfinishedMatches(matches) {
  return Array.isArray(matches) && matches.slice(1).some(match =>
    Number(match?.started) > 0 && !Number(match?.finished) && match?.abandoned !== true
  );
}

function isTerminalMatch(match) {
  return Boolean(match && (Number(match.finished) > 0 || match.abandoned === true));
}

function normalizeCompanionMatches(payload) {
  return (Array.isArray(payload?.matches) ? payload.matches : []).map(match => {
    const leaderboardValue = String(match.leaderboard || '').trim().toLowerCase().replace(/\s+/g, '_');
    const rawType = String(match.type || '').trim().toUpperCase();
    const rawDiplomacy = String(match.diplomacy || '').trim().toUpperCase();
    let leaderboard = leaderboardValue === 'dm_1v1' ? 'DM 1v1' : leaderboardValue === 'dm_tg' || leaderboardValue === 'dm_team' ? 'DM TG' : leaderboardValue === 'rm_1v1' ? 'RM 1v1' : leaderboardValue === 'rm_tg' || leaderboardValue === 'rm_team' ? 'RM TG' : leaderboardValue === 'ew_1v1' ? 'EW 1v1' : leaderboardValue === 'ew_tg' || leaderboardValue === 'ew_team' ? 'EW TG' : '';
    if (!leaderboard && /DEATHMATCH|^DM$/.test(rawType)) leaderboard = /1V1|1\s*V\s*1/.test(rawDiplomacy) ? 'DM 1v1' : 'DM TG';
    const players = [];
    const teams = (Array.isArray(match.teams) ? match.teams : []).map((team, teamIndex) => {
      const members = [];
      for (const source of Array.isArray(team.players) ? team.players : []) {
        const player = {
          id: String(source.profileId), number: players.length, name: source.name || `玩家 ${source.profileId}`,
          civilization: source.civName || source.civ || '未知民族', civilization_id: source.civ || '', color_hex: source.colorHex || '#84928a',
          rating: Number.isFinite(Number(source.rating)) ? Number(source.rating) : null,
          color: Number.isFinite(Number(source.color)) ? Number(source.color) : null,
          ratingDelta: Number.isFinite(Number(source.ratingDiff)) ? Number(source.ratingDiff) : null,
          team: source.team ?? teamIndex + 1, country: source.country || '',
          winner: source.won === true
        };
        players.push(player);
        members.push(player.number);
      }
      return { members, winner: members.length > 0 && members.every(index => players[index].winner) };
    });
    const started = companionEpoch(match.started);
    const finished = companionEpoch(match.finished);
    // A missing finished timestamp can survive in upstream/cache data after
    // a disconnected match. Never expose an implausibly old record as LIVE.
    const now = Math.floor(Date.now() / 1000);
    const plausibleLiveAge = started > 0 && started <= now + 300 && now - started <= 3 * 60 * 60;
    return {
      id: match.matchId,
      leaderboard,
      lobby: leaderboard ? '' : (match.name || '未知大厅'),
      type: leaderboard.includes('TG') ? 'TG' : leaderboard.includes('1v1') ? '1v1' : rawType === 'DEATHMATCH' ? 'DM' : '',
      diplomacy: leaderboard.includes('1v1') ? '1v1' : leaderboard.includes('TG') ? 'TG' : rawDiplomacy,
      rms: match.mapName || match.map || '未知地图',
      started,
      finished,
      abandoned: match.abandoned === true,
      live: Boolean(plausibleLiveAge && !finished && !match.abandoned),
      duration: started && finished && finished >= started ? finished - started : 0,
      server: match.server || '',
      players,
      teams
    };
  }).sort((a, b) => Number(b.started) - Number(a.started));
}

const profileService = createProfileService({
  getProfileDb: () => profileDb,
  leaderboardCache,
  ladderOrder,
  types,
  personalStatsCache,
  personalStatsCacheTtl,
  fetchUpstreamWithRateLimit,
  forceChinaCountry,
  WebSocket
});
const { localProfileDetails, fetchPersonalLeaderboardStats } = profileService;

const matchesService = createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches });
const { fetchWorldsEdgeMatchesOnce, fetchLatestWorldsEdgeMatchOnce } = matchesService;
// Visible profile refreshes get queue priority and one bounded attempt; the
// realtime monitor retains its existing retry policy through matchesService.
const profileMatchesService = createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches, attempts:1, requestTimeoutMs:10_000, priority:5 });
const { fetchWorldsEdgeMatchesOnce:fetchProfileMatchesOnce, fetchLatestWorldsEdgeMatchOnce:fetchLatestProfileMatchOnce } = profileMatchesService;

const realtimeService = createRealtimeService({
  realtimePayloadPath: join(dataDir, 'realtime-payload.json'),
  readFile,
  writeFile,
  fetchLatestWorldsEdgeMatchOnce,
  localProfileDetails,
  getLeaderboard,
  getMediaCache,
  loadRlReference,
  fetchPersonalLeaderboardStats,
  worldsEdgeMatchCache,
  worldsEdgeMatchCachePath,
  forceChinaCountry,
  getLiveTournamentForPlayer,
  WebSocket,
  notificationProfileIds: ['197964'],
  onMatchAdded: match => queueDanmakuMatch(join(dataDir, 'danmaku/events'), match)
});
// End of server entrypoint.
async function readWorldsEdgeMatchesCache(profileId) {
  const key = String(profileId);
  let current = worldsEdgeMatchCache.get(key);
  if (!current) {
    try {
      const disk = JSON.parse(await readFile(worldsEdgeMatchCachePath(key), 'utf8'));
      if (disk && Array.isArray(disk.matches) && Number.isFinite(Number(disk.savedAt))) {
        current = { savedAt: Number(disk.savedAt), matches: disk.matches, pages: Number(disk.pages) || 1, hasMore: disk.hasMore !== false, hasOlderUnfinished: typeof disk.hasOlderUnfinished === 'boolean' ? disk.hasOlderUnfinished : hasOlderUnfinishedMatches(disk.matches) };
        worldsEdgeMatchCache.set(key, current);
      }
    } catch {
      current = null;
    }
  }
  return current;
}

async function getWorldsEdgeMatches(profileId, page = 1) {
  const key = String(profileId);
  const current = await readWorldsEdgeMatchesCache(key);
  const currentLooksLive = Boolean(current?.matches?.[0] && !current.matches[0].finished);
  // A profile page entry must always perform one lightweight latest-match check.
  // The match ID decides whether the cached 100-match history can be reused.
  // Keep the normal TTL shortcut for non-first pages, which are not part of the
  // initial profile-page load.
  if (current && page !== 1 && !currentLooksLive && Date.now() - current.savedAt < worldsEdgeMatchCacheTtl && current.pages >= page) return current;
  if (worldsEdgeMatchRefreshes.has(key)) return worldsEdgeMatchRefreshes.get(key);
  const refresh = (async () => {
    const isFresh = current && Date.now() - current.savedAt < worldsEdgeMatchCacheTtl;
    const stale = current;
    let latestChanged = false;
    let latestMatch = null;
    if (current && page === 1 && current.matches.length) {
      try {
        latestMatch = await fetchLatestProfileMatchOnce(profileId);
        if (latestMatch && String(latestMatch.id) === String(current.matches[0].id)) {
          // The newest ID can stay unchanged while an older cached match changes
          // from live to finished. Refresh the first upstream page whenever the
          // cache still contains an unfinished record, then let fresh records
          // replace cached records with the same match ID.
          const hasOlderUnfinished = current.hasOlderUnfinished === true;
          if (!hasOlderUnfinished && isTerminalMatch(latestMatch) && isTerminalMatch(current.matches[0])) return current;
          if (hasOlderUnfinished) {
            try {
              const olderUnfinishedIds = new Set(current.matches.slice(1)
                .filter(match => Number(match.started) > 0 && !Number(match.finished) && match.abandoned !== true)
                .map(match => String(match.id)));
              let freshPage = { matches: [] };
              for (const requestedCount of [10, 100]) {
                freshPage = await fetchProfileMatchesOnce(profileId, 1, requestedCount);
                const returnedIds = new Set(freshPage.matches.map(match => String(match.id)));
                if ([...olderUnfinishedIds].every(id => returnedIds.has(id)) || freshPage.matches.length < requestedCount) break;
              }
              const byId = new Map(current.matches.map(match => [String(match.id), match]));
              for (const match of freshPage.matches) byId.set(String(match.id), match);
              const refreshedMatches = [...byId.values()]
                .sort((a, b) => Number(b.started || 0) - Number(a.started || 0))
                .slice(0, 100);
              const refreshed = { ...current, matches: refreshedMatches, savedAt: Date.now(), pages: Math.max(1, current.pages || 1), hasOlderUnfinished: hasOlderUnfinishedMatches(refreshedMatches) };
              worldsEdgeMatchCache.set(key, refreshed);
              await writeFile(worldsEdgeMatchCachePath(profileId), JSON.stringify(refreshed), 'utf8');
              return refreshed;
            } catch {
              // Keep the lightweight latest-match refresh as a fallback.
            }
          }
          const refreshedMatches = current.matches.slice();
          refreshedMatches[0] = latestMatch;
          const refreshed = { ...current, matches: refreshedMatches, savedAt: Date.now(), hasOlderUnfinished: hasOlderUnfinishedMatches(refreshedMatches) };
          worldsEdgeMatchCache.set(key, refreshed);
          await writeFile(worldsEdgeMatchCachePath(profileId), JSON.stringify(refreshed), 'utf8');
          return refreshed;
        }
        latestChanged = Boolean(latestMatch && String(latestMatch.id) !== String(current.matches[0].id));
      } catch (error) {
        if (stale.matches.length && stale.pages >= page) return { ...stale, stale:true };
        throw error;
      }
    }
    if (latestChanged && latestMatch && current && page === 1) {
      // Find the cached latest match with at most two history requests.
      // This uses the cached match ID as a watermark and avoids estimating the
      // number of new matches from elapsed time.
      const anchorId = String(current.matches[0].id);
      let collected = [];
      let anchorIndex = -1;
      let pageCount = 0;
      for (const requestedCount of [10, 100]) {
        // Try a small incremental window, then fill the full range in one hop.
        // Always use page 1 because the page size changes between attempts.
        const result = await fetchProfileMatchesOnce(profileId, 1, requestedCount);
        pageCount += 1;
        collected = result.matches;
        anchorIndex = collected.findIndex(match => String(match.id) === anchorId);
        if (anchorIndex >= 0 || result.matches.length < requestedCount) break;
      }

      // If the old cache anchor is outside the first 100 matches, the cache is
      // too far behind to increment safely. The collected window becomes the
      // authoritative latest-100 snapshot.
      const incoming = anchorIndex >= 0 ? collected.slice(0, anchorIndex) : collected.slice(0, 100);
      const byId = new Map();
      for (const match of [...current.matches, ...incoming]) byId.set(String(match.id), match);
      const mergedMatches = [...byId.values()]
        .sort((a, b) => Number(b.started || 0) - Number(a.started || 0))
        .slice(0, 100);
      const merged = { savedAt: Date.now(), matches: mergedMatches, pages: 1, hasMore: false, upstreamPages: pageCount, hasOlderUnfinished: hasOlderUnfinishedMatches(mergedMatches) };
      worldsEdgeMatchCache.set(key, merged);
      await mkdir(worldsEdgeMatchCacheDir, { recursive: true });
      await writeFile(worldsEdgeMatchCachePath(profileId), JSON.stringify(merged), 'utf8');
      return merged;
    }

    // A new latest match without an incremental baseline requires rebuilding
    // page 1 from upstream. Do not append page 2 to the old cache.
    const existing = isFresh && !latestChanged ? current : { savedAt: 0, matches: [], pages: 0, hasMore: true, hasOlderUnfinished: false };
    let entry = existing;
    for (let nextPage = existing.pages + 1; nextPage <= page; nextPage += 1) {
      let result;
      try {
        result = await fetchProfileMatchesOnce(profileId, nextPage);
      } catch (error) {
        if (stale?.matches?.length && stale.pages >= page) return { ...stale, stale:true };
        throw error;
      }
      const known = new Set(entry.matches.map(match => String(match.id)));
      const mergedPageMatches = entry.matches.concat(result.matches.filter(match => !known.has(String(match.id))));
      entry = { savedAt: Date.now(), matches: mergedPageMatches, pages: nextPage, hasMore: result.hasMore, hasOlderUnfinished: hasOlderUnfinishedMatches(mergedPageMatches) };
      if (!result.hasMore) break;
    }
    worldsEdgeMatchCache.set(key, entry);
    await mkdir(worldsEdgeMatchCacheDir, { recursive: true });
    await writeFile(worldsEdgeMatchCachePath(profileId), JSON.stringify(entry), 'utf8');
    return entry;
  })().finally(() => worldsEdgeMatchRefreshes.delete(String(profileId)));
  worldsEdgeMatchRefreshes.set(key, refresh);
  return refresh;
}

function aoe2RecsProfilePath(profileId) {
  return join(aoe2RecsProfileCacheDir, `${profileId}.json`);
}

async function readAoE2RecsProfileCache(profileId) {
  const cached = aoe2RecsProfileCache.get(profileId);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(aoe2RecsProfilePath(profileId), 'utf8'));
    if (parsed?.savedAt && parsed.profile && Object.prototype.hasOwnProperty.call(parsed.profile, 'matches')) {
      aoe2RecsProfileCache.set(profileId, parsed);
      return parsed;
    }
  } catch {}
  return null;
}

async function writeAoE2RecsProfileCache(profileId, profile) {
  const cached = { savedAt: Date.now(), profile };
  await mkdir(aoe2RecsProfileCacheDir, { recursive: true });
  const tempPath = `${aoe2RecsProfilePath(profileId)}.tmp`;
  await writeFile(tempPath, JSON.stringify(cached), 'utf8');
  await rename(tempPath, aoe2RecsProfilePath(profileId));
  aoe2RecsProfileCache.set(profileId, cached);
  return cached;
}

function fetchAoE2RecsProfileOnce(profileId) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let requestSent = false;
    let sendTimer;
    let sends = 0;
    const timeout = setTimeout(() => finish(new Error('AoE2Recs 资料请求超时')), 20_000);
    const finish = (error, profile) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(sendTimer);
      try { socket?.close(); } catch {}
      error ? reject(error) : resolve(profile);
    };
    try { socket = new WebSocket('wss://aoe2recs.com/dashboard/api/'); }
    catch (error) { finish(error); return; }
    socket.addEventListener('error', () => finish(new Error('AoE2Recs WebSocket 连接失败')));
    socket.addEventListener('close', () => { if (!settled) finish(new Error('AoE2Recs WebSocket 已关闭')); });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!requestSent && (message.cls === 8 || message.cls === 3)) {
        requestSent = true;
        const sendProfileRequest = () => {
          if (settled || socket.readyState !== WebSocket.OPEN || sends >= 3) {
            clearInterval(sendTimer);
            return;
          }
          sends += 1;
          try { socket.send(JSON.stringify({ profile_id: Number(profileId) })); } catch (error) { finish(error); }
        };
        sendProfileRequest();
        sendTimer = setInterval(sendProfileRequest, 1_500);
      }
      if (message.cls === 13) {
        const profile = sanitizeAoE2RecsProfile(message.data);
        profile ? finish(null, profile) : finish(new Error('AoE2Recs 返回的资料格式无效'));
      }
    });
  });
}

async function refreshAoE2RecsProfile(profileId) {
  if (aoe2RecsProfileRefreshes.has(profileId)) return aoe2RecsProfileRefreshes.get(profileId);
  const refresh = (async () => {
    let lastError;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        const profile = await fetchAoE2RecsProfileOnce(profileId);
        return (await writeAoE2RecsProfileCache(profileId, profile)).profile;
      } catch (error) {
        lastError = error;
        if (attempt < 9) await new Promise(resolve => setTimeout(resolve, Math.min(500 * (2 ** attempt), 4_000)));
      }
    }
    throw lastError || new Error('AoE2Recs 资料请求失败');
  })().finally(() => aoe2RecsProfileRefreshes.delete(profileId));
  aoe2RecsProfileRefreshes.set(profileId, refresh);
  return refresh;
}

async function getAoE2RecsProfile(profileId) {
  const cached = await readAoE2RecsProfileCache(profileId);
  if (cached?.profile) {
    const age = Date.now() - Number(cached.savedAt || 0);
    if (age < aoe2RecsProfileCacheTtl) return { profile: cached.profile, cached: true, stale: false };
    refreshAoE2RecsProfile(profileId).catch(error => console.error(`选手资料 ${profileId} 后台更新失败:`, error.message));
    return { profile: cached.profile, cached: true, stale: true };
  }
  return { profile: await refreshAoE2RecsProfile(profileId), cached: false, stale: false };
}

const profileSearchPool = createProfileSearchPool();
async function searchProfiles(query, leaderboardId) {
  const normalized = query.trim();
  const queryLower = normalized.toLocaleLowerCase();
  const ratings = new Map();
  const selectedRatings = new Map();
  const cached = leaderboardCache.get(leaderboardId);
  for (const boardCache of leaderboardCache.values()) {
    for (const row of boardCache.data.rows) {
      const profileId = String(row.profileId || '');
      const rating = Number(row.rating);
      if (profileId && Number.isFinite(rating) && rating > (ratings.get(profileId) || 0)) ratings.set(profileId, rating);
    }
  }
  if (cached) for (const row of cached.data.rows) {
    const profileId = String(row.profileId || '');
    const rating = Number(row.rating);
    if (profileId && Number.isFinite(rating)) selectedRatings.set(profileId, rating);
  }
  const matchingProfiles = await profileSearchPool.query(join(dataDir, profileCache.filename), normalized);
  const candidates = new Map(matchingProfiles.map(player => [String(player.profileId), { ...player, aliases: [] }]));
  const profileById = profileDb.prepare('SELECT profile_id AS profileId, steam_id AS steamId, name, clan, country, last_match_time AS lastMatchTime FROM profiles WHERE profile_id = ?');
  for (const boardCache of leaderboardCache.values()) {
    for (const row of boardCache.data.rows) {
      const alias = String(row.alias || '');
      if (!alias.toLocaleLowerCase().includes(queryLower)) continue;
      const id = String(row.profileId || '');
      if (!id) continue;
      const existing = candidates.get(id);
      if (existing) {
        if (alias && alias.toLocaleLowerCase() !== existing.name.toLocaleLowerCase() && !existing.aliases.includes(alias)) existing.aliases.push(alias);
        if (!existing.clan) existing.clan = row.clan || alias.match(/^([A-Z0-9]{2,})[_\s.]/i)?.[1] || '';
        continue;
      }
      const profile = profileById.get(id);
      const inferredClan = alias.match(/^([A-Z0-9]{2,})[_\s.]/i)?.[1] || '';
      candidates.set(id, { ...(profile || {
        profileId: id,
        steamId: row.steamId || '',
        name: row.name,
        clan: row.clan || inferredClan,
        country: row.country || '',
        lastMatchTime: row.lastMatchDate || ''
      }), clan: profile?.clan || row.clan || inferredClan, aliases: alias && alias.toLocaleLowerCase() !== String(profile?.name || row.name).toLocaleLowerCase() ? [alias] : [] });
    }
  }
  const results = [...candidates.values()].map(player => {
    const name = player.name.toLocaleLowerCase();
    const matchingNames = [player.name, ...(player.aliases || [])].map(value => value.toLocaleLowerCase());
    const positions = matchingNames.map(value => value.indexOf(queryLower)).filter(value => value >= 0);
    const position = positions.length ? Math.min(...positions) : 0;
    const exact = matchingNames.some(value => value === queryLower);
    const startsWith = position === 0;
    return {
      ...player,
      rating: selectedRatings.get(String(player.profileId)) ?? ratings.get(String(player.profileId)) ?? null,
      matchQuality: exact ? 3 : startsWith ? 2 : position >= 0 ? 1 : 0,
      matchPosition: Math.max(0, position),
      matchLengthDifference: Math.abs([...player.name].length - [...normalized].length),
      lastMatchTimestamp: profileLastMatchTimestamp(player.lastMatchTime)
    };
  });
  results.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1)
    || b.matchQuality - a.matchQuality
    || a.matchPosition - b.matchPosition
    || a.matchLengthDifference - b.matchLengthDifference
    || b.lastMatchTimestamp - a.lastMatchTimestamp
    || Number(Boolean(b.clan?.trim())) - Number(Boolean(a.clan?.trim()))
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return results.slice(0, 30);
}

const chinaDayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
const feedbackDailyCounts = new Map();
let feedbackStatePromise = null;
let feedbackWriteQueue = Promise.resolve();
let siteTrafficStatePromise = null;
let siteTrafficState = { version: 1, days: {} };
let siteDailyArchiveTimer = null;
let siteDailyArchiveWriteQueue = Promise.resolve();
let liquipediaMatchesCache = null;
let liquipediaMatchesCacheLoaded = false;
let liquipediaMatchesRefreshPromise = null;
let liquipediaMatchesLastError = null;
const liquipediaLivePlayerTournaments = new Map();
let liquipediaTournamentsCache = null;
let liquipediaTournamentsRefreshPromise = null;
let liquipediaResultsCache = null;
let liquipediaResultsCachePromise = null;
const liquipediaResultsRefreshes = new Map();
let liquipediaResultsWriteQueue = Promise.resolve();
let liquipediaResultsSchedulerTimer = null;
const liquipediaParseQueue = [];
let liquipediaParseRunning = false;
let liquipediaParseLastStartedAt = 0;
let liquipediaParseSequence = 0;

function queueLiquipediaParse(task, priority=1) {
  return new Promise((resolve,reject) => {
    liquipediaParseQueue.push({task,priority,order:liquipediaParseSequence++,resolve,reject});
    if (!liquipediaParseRunning) void runLiquipediaParseQueue();
  });
}

async function runLiquipediaParseQueue() {
  liquipediaParseRunning = true;
  while (liquipediaParseQueue.length) {
    const delay = Math.max(0,31_000 - (Date.now()-liquipediaParseLastStartedAt));
    if (delay) await new Promise(resolve=>setTimeout(resolve,delay));
    liquipediaParseQueue.sort((left,right)=>left.priority-right.priority || left.order-right.order);
    const request = liquipediaParseQueue.shift();
    liquipediaParseLastStartedAt = Date.now();
    try { request.resolve(await request.task()); }
    catch (error) { request.reject(error); }
  }
  liquipediaParseRunning = false;
}

function parseLiquipediaTournaments(html) {
  const source = String(html || '');
  const listStart = source.indexOf('class="tournaments-list"');
  if (listStart < 0) return [];
  const list = source.slice(listStart);
  const items = [];
  for (const item of list.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const block = item[1];
    if (!/data-filter-category="Age of Empires II"/i.test(block)) continue;
    const tier = decodeLiquipediaHtml(block.match(/tournament-badge[^>]*>[\s\S]*?<div class="tournament-badge(?:__|&#95;&#95;)text">([\s\S]*?)<\/div>/i)?.[1] || '');
    const name = decodeLiquipediaHtml(block.match(/class="tournament-name">\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
    const href = block.match(/class="tournament-name">\s*<a[^>]*href="([^"]+)"/i)?.[1] || '';
    const logo = block.match(/class="tournament-icon"[\s\S]*?<img[^>]*src="([^"]+)"/i)?.[1] || '';
    const dates = decodeLiquipediaHtml(block.match(/class="tournaments-list-dates"[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '');
    const sectionMatches = [...list.slice(0, item.index || 0).matchAll(/tournaments-list-heading[^>]*>\s*([^<]+)\s*</gi)];
    const section = sectionMatches.length ? sectionMatches[sectionMatches.length - 1][1].trim() : '';
    if (!name) continue;
    items.push({ name, tier: tier || 'Misc', dates, status: /ongoing/i.test(section) ? 'Ongoing' : /completed|finished/i.test(section) ? 'Completed' : 'Upcoming', url: liquipediaUrl(href), logo: liquipediaUrl(logo) });
  }
  return items;
}

async function loadLiquipediaTournaments() {
  if (liquipediaTournamentsCache && Date.now() - Date.parse(liquipediaTournamentsCache.fetchedAt || 0) < liquipediaTournamentsRefreshInterval) return liquipediaTournamentsCache;
  if (liquipediaTournamentsRefreshPromise) return liquipediaTournamentsRefreshPromise;
  liquipediaTournamentsRefreshPromise = (async () => {
    try {
      const cached = JSON.parse(await readFile(liquipediaTournamentsCachePath, 'utf8'));
      if (cached?.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < liquipediaTournamentsRefreshInterval) { liquipediaTournamentsCache = cached; return cached; }
    } catch {}
    const payload = await queueLiquipediaParse(async () => {
      const response = await fetch(`${liquipediaApiUrl}?action=parse&page=Main_Page&prop=text&format=json`, { headers: { accept: 'application/json', 'user-agent': liquipediaUserAgent }, signal: AbortSignal.timeout(25_000) });
      if (!response.ok) throw new Error(`Liquipedia 首页返回 HTTP ${response.status}`);
      return response.json();
    },1);
    const next = { fetchedAt: new Date().toISOString(), tournaments: parseLiquipediaTournaments(payload?.parse?.text?.['*'] || '') };
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${liquipediaTournamentsCachePath}.tmp`, JSON.stringify(next, null, 2), 'utf8');
    await rename(`${liquipediaTournamentsCachePath}.tmp`, liquipediaTournamentsCachePath);
    liquipediaTournamentsCache = next;
    return next;
  })().finally(() => { liquipediaTournamentsRefreshPromise = null; });
  return liquipediaTournamentsRefreshPromise;
}

async function loadLiquipediaResultsCache() {
  if (liquipediaResultsCache) return liquipediaResultsCache;
  if (!liquipediaResultsCachePromise) liquipediaResultsCachePromise = (async () => {
    try {
      const cached = JSON.parse(await readFile(liquipediaResultsCachePath,'utf8'));
      if (cached?.version === 2 && cached.categories && typeof cached.categories === 'object') return cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[event-results] cache unavailable:',error.message);
    }
    return {version:2,categories:{}};
  })();
  liquipediaResultsCache = await liquipediaResultsCachePromise;
  return liquipediaResultsCache;
}

function refreshLiquipediaResults(category) {
  if (liquipediaResultsRefreshes.has(category)) return liquipediaResultsRefreshes.get(category);
  const configuration = tournamentResultCategories[category];
  const pending = (async () => {
    const cache = await loadLiquipediaResultsCache();
    const payload = await queueLiquipediaParse(async () => {
      const address = new URL(liquipediaApiUrl);
      address.search = new URLSearchParams({action:'parse',page:configuration.page,prop:'text',format:'json'}).toString();
      const response = await fetch(address,{headers:{accept:'application/json','accept-encoding':'gzip','user-agent':liquipediaUserAgent},signal:AbortSignal.timeout(30_000)});
      if (!response.ok) throw new Error(`${configuration.label}赛事页面返回 HTTP ${response.status}`);
      return response.json();
    },2);
    const previousScores=new Map((cache.categories[category]?.rows || []).filter(row=>row.url&&row.score).map(row=>[row.url,row.score]));
    const rows = parseTournamentResultsHtml(payload?.parse?.text?.['*'] || '').map(row=>({...row,score:row.score || previousScores.get(row.url) || ''}));
    if (!rows.length) throw new Error(`${configuration.label}赛事页面没有可用的表格`);
    const snapshot = {
      category,label:configuration.label,fetchedAt:new Date().toISOString(),
      sourceUrl:`https://liquipedia.net/ageofempires/${configuration.page}`,
      rows
    };
    cache.categories[category] = snapshot;
    liquipediaResultsWriteQueue = liquipediaResultsWriteQueue.catch(()=>{}).then(async () => {
      await mkdir(dataDir,{recursive:true});
      await writeFile(`${liquipediaResultsCachePath}.tmp`,JSON.stringify(cache),'utf8');
      await rename(`${liquipediaResultsCachePath}.tmp`,liquipediaResultsCachePath);
    });
    await liquipediaResultsWriteQueue;
    return snapshot;
  })().finally(()=>liquipediaResultsRefreshes.delete(category));
  liquipediaResultsRefreshes.set(category,pending);
  return pending;
}

async function scheduleLiquipediaResultsRefresh() {
  if (liquipediaResultsSchedulerTimer) clearTimeout(liquipediaResultsSchedulerTimer);
  liquipediaResultsSchedulerTimer = null;
  const cache = await loadLiquipediaResultsCache();
  const now = Date.now();
  const categories = Object.keys(tournamentResultCategories);
  const stale = categories.filter(category => {
    const fetchedAt = Date.parse(cache.categories[category]?.fetchedAt || 0);
    return !Number.isFinite(fetchedAt) || now - fetchedAt >= liquipediaResultsRefreshInterval;
  });
  if (stale.length) {
    console.log(`[event-results] background refresh starting: ${stale.join(', ')}`);
    const results = await Promise.allSettled(stale.map(category=>refreshLiquipediaResults(category)));
    const failed = results.filter(result=>result.status==='rejected');
    if (failed.length) {
      for (const result of failed) console.warn('[event-results] background refresh failed:',result.reason?.message || result.reason);
      liquipediaResultsSchedulerTimer = setTimeout(()=>scheduleLiquipediaResultsRefresh().catch(error=>console.warn('[event-results] scheduler failed:',error.message)),30*60_000);
      liquipediaResultsSchedulerTimer.unref?.();
      return;
    }
    console.log(`[event-results] background refresh complete: ${stale.length} categories`);
  }
  const deadlines = categories.map(category=>Date.parse(cache.categories[category]?.fetchedAt || 0)+liquipediaResultsRefreshInterval).filter(Number.isFinite);
  const nextAt = deadlines.length ? Math.min(...deadlines) : Date.now();
  const delay = Math.max(1000,nextAt-Date.now());
  console.log(`[event-results] next background refresh ${new Date(Date.now()+delay).toISOString()}`);
  liquipediaResultsSchedulerTimer = setTimeout(()=>scheduleLiquipediaResultsRefresh().catch(error=>console.warn('[event-results] scheduler failed:',error.message)),delay);
  liquipediaResultsSchedulerTimer.unref?.();
}

function normalizeEventPlayerName(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function resultScore(row, matches) {
  const event=normalizeEventPlayerName(row?.name);
  const winner=normalizeEventPlayerName(row?.winner);
  const runnerUp=normalizeEventPlayerName(row?.runnerUp);
  if (!event || !winner || !runnerUp) return '';
  for (const match of matches || []) {
    const tournament=normalizeEventPlayerName(match?.tournament?.name);
    if (!tournament || (!tournament.startsWith(event) && !event.startsWith(tournament))) continue;
    const opponents=(match.opponents || []).map(opponent=>normalizeEventPlayerName(opponent?.name));
    if (!opponents.includes(winner) || !opponents.includes(runnerUp)) continue;
    const scores=Array.isArray(match.score) ? match.score : [];
    if (scores.length < 2 || scores.some(score=>String(score ?? '').trim()==='')) continue;
    const winnerIndex=opponents.indexOf(winner),runnerUpIndex=opponents.indexOf(runnerUp);
    return `${scores[winnerIndex]}–${scores[runnerUpIndex]}`;
  }
  return '';
}

function rebuildLiquipediaLivePlayerCache(data) {
  liquipediaLivePlayerTournaments.clear();
  for (const match of Array.isArray(data?.upcoming) ? data.upcoming : []) {
    if (match?.status !== 'ongoing') continue;
    const tournament = String(match.tournament?.name || '').trim();
    if (!tournament) continue;
    const event = {
      name: tournament,
      url: String(match.tournament?.url || ''),
      bestOf: Number(match.bestOf) || null,
      score: Array.isArray(match.score) ? match.score : ['', ''],
      opponents: Array.isArray(match.opponents)
        ? match.opponents.map(opponent => ({ name: opponent?.name || '', members: Array.isArray(opponent?.members) ? opponent.members : [] }))
        : []
    };
    for (const opponent of Array.isArray(match.opponents) ? match.opponents : []) {
      const names = [...(Array.isArray(opponent?.members) ? opponent.members : []), opponent?.name];
      for (const name of names) {
        const key = normalizeEventPlayerName(name);
        if (key && !liquipediaLivePlayerTournaments.has(key)) liquipediaLivePlayerTournaments.set(key, event);
      }
    }
  }
}

function getLiveTournamentForPlayer(playerName) {
  const key = normalizeEventPlayerName(playerName);
  if (!key) return null;
  const exact = liquipediaLivePlayerTournaments.get(key);
  if (exact) return exact;

  // Liquipedia and the live match API may use a shortened or decorated
  // player name (for example JorDan vs JorDan_AoE). Only accept a fuzzy
  // match when the meaningful part is long enough and it identifies one
  // unique ongoing tournament.
  if (key.length < 5) return null;
  const candidates = [];
  for (const [candidateKey, event] of liquipediaLivePlayerTournaments.entries()) {
    if (candidateKey.startsWith(key) || key.startsWith(candidateKey)) candidates.push(event);
  }
  const unique = [...new Map(candidates.map(event => [event.url || event.name, event])).values()];
  return unique.length === 1 ? unique[0] : null;
}
let siteTrafficWriteQueue = Promise.resolve();

function chinaDayKey(date = new Date()) {
  const parts = Object.fromEntries(chinaDayFormatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function normalizeClientIp(value) {
  let ip = String(value || '').split(',')[0].trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (/^\[[^\]]+\](?::\d+)?$/.test(ip)) ip = ip.slice(1, ip.indexOf(']'));
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip || 'unknown';
}

function isInternalIp(ip) {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip)) return true;
  const private172 = ip.match(/^172\.(\d+)\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return /^(?:fc|fd|fe80):/i.test(ip);
}

function requestClientIp(req) {
  const peerIp = normalizeClientIp(req.socket?.remoteAddress);
  const realIp = isInternalIp(peerIp) ? normalizeClientIp(req.headers['x-real-ip']) : '';
  return realIp && realIp !== 'unknown' ? realIp : peerIp;
}

function excludeFromSiteTraffic(ip) {
  return siteTrafficExcludedIps.has(ip) || isInternalIp(ip) || ip === 'unknown';
}

async function readJsonRequest(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!tooLarge) {
          tooLarge = true;
          reject(Object.assign(new Error('提交内容过长'), { statusCode: 413 }));
          req.resume();
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('提交内容过长');
        error.statusCode = 413;
        return reject(error);
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        const error = new Error('提交格式不正确');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function ensureFeedbackState() {
  if (feedbackStatePromise) return feedbackStatePromise;
  feedbackStatePromise = (async () => {
    let text = '';
    try {
      text = await readFile(feedbackLogPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const today = chinaDayKey();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const recordDay = record.day || chinaDayKey(new Date(record.sentAt));
        if (recordDay !== today || !record.ip) continue;
        const key = `${today}|${record.ip}`;
        feedbackDailyCounts.set(key, (feedbackDailyCounts.get(key) || 0) + 1);
      } catch {}
    }
  })().catch(error => {
    feedbackStatePromise = null;
    throw error;
  });
  return feedbackStatePromise;
}

async function feedbackStatus(ip) {
  await ensureFeedbackState();
  const key = `${chinaDayKey()}|${ip}`;
  const used = feedbackDailyCounts.get(key) || 0;
  return { limit: feedbackDailyLimit, used, remaining: Math.max(0, feedbackDailyLimit - used) };
}

async function saveFeedback(ip, content) {
  const day = chinaDayKey();
  const key = `${day}|${ip}`;
  const status = await feedbackStatus(ip);
  if (status.remaining <= 0) {
    const error = new Error('今天的反馈提交次数已用完，请明天再试');
    error.statusCode = 429;
    throw error;
  }
  const sentAt = new Date().toISOString();
  const record = { day, ip, content, sentAt };
  feedbackDailyCounts.set(key, status.used + 1);
  const write = feedbackWriteQueue.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    await appendFile(feedbackLogPath, `${JSON.stringify(record)}\n`, 'utf8');
  });
  feedbackWriteQueue = write;
  try {
    await write;
  } catch (error) {
    feedbackDailyCounts.set(key, Math.max(0, (feedbackDailyCounts.get(key) || 1) - 1));
    throw error;
  }
  return { sentAt, limit: feedbackDailyLimit, used: status.used + 1, remaining: Math.max(0, status.remaining - 1) };
}

async function ensureSiteTrafficState() {
  if (siteTrafficStatePromise) return siteTrafficStatePromise;
  siteTrafficStatePromise = (async () => {
    try {
      const saved = JSON.parse(await readFile(siteTrafficPath, 'utf8'));
      if (saved && typeof saved.days === 'object') siteTrafficState = { version: 1, days: saved.days };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return siteTrafficState;
  })().catch(error => {
    siteTrafficStatePromise = null;
    throw error;
  });
  return siteTrafficStatePromise;
}

function currentSiteStats() {
  const date = chinaDayKey();
  const day = siteTrafficState.days[date] || {};
  const visitors = Array.isArray(day.visitors) ? day.visitors : [];
  return { date, users: visitors.length, views: Math.max(0, Number(day.views) || 0) };
}

async function persistSiteTraffic() {
  const snapshot = JSON.stringify(siteTrafficState, null, 2);
  const temporaryPath = `${siteTrafficPath}.tmp`;
  const write = siteTrafficWriteQueue.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(temporaryPath, snapshot, 'utf8');
    await rename(temporaryPath, siteTrafficPath);
  });
  siteTrafficWriteQueue = write;
  return write;
}

async function recordPageView(req) {
  await ensureSiteTrafficState();
  const ip = requestClientIp(req);
  if (excludeFromSiteTraffic(ip)) return { ...currentSiteStats(), counted: false };
  const date = chinaDayKey();
  const day = siteTrafficState.days[date] && typeof siteTrafficState.days[date] === 'object'
    ? siteTrafficState.days[date]
    : { views: 0, visitors: [], updatedAt: null };
  const visitors = new Set(Array.isArray(day.visitors) ? day.visitors : []);
  visitors.add(createHash('sha256').update(`aoe2cn-site-traffic-v1:${ip}`).digest('hex'));
  siteTrafficState.days[date] = {
    views: Math.max(0, Number(day.views) || 0) + 1,
    visitors: [...visitors],
    uniqueVisitors: visitors.size,
    updatedAt: new Date().toISOString()
  };
  await persistSiteTraffic();
  return { ...currentSiteStats(), counted: true };
}

async function archiveSiteDay(date = chinaDayKey()) {
  await ensureSiteTrafficState();
  let existing = '';
  try { existing = await readFile(siteDailyArchivePath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  for (const line of existing.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { if (JSON.parse(line).date === date) return false; } catch {}
  }
  let feedbackText = '';
  try { feedbackText = await readFile(feedbackLogPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const feedback = [];
  for (const line of feedbackText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const recordDay = record.day || chinaDayKey(new Date(record.sentAt));
      if (recordDay === date && typeof record.content === 'string') feedback.push({ content: record.content, sentAt: record.sentAt || null });
    } catch {}
  }
  const day = siteTrafficState.days[date] || {};
  const visitors = Array.isArray(day.visitors) ? day.visitors : [];
  const record = {
    date,
    recordedAt: new Date().toISOString(),
    users: visitors.length,
    views: Math.max(0, Number(day.views) || 0),
    feedback
  };
  const write = siteDailyArchiveWriteQueue.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true });
    await appendFile(siteDailyArchivePath, `${JSON.stringify(record)}\n`, 'utf8');
  });
  siteDailyArchiveWriteQueue = write;
  await write;
  console.log(`[stats] daily archive saved: ${date}; users ${record.users}; views ${record.views}; feedback ${feedback.length}`);
  return true;
}

function scheduleSiteDailyArchive() {
  if (siteDailyArchiveTimer) clearTimeout(siteDailyArchiveTimer);
  const now = Date.now();
  const today = chinaDayKey(new Date(now));
  let target = Date.parse(`${today}T23:59:00+08:00`);
  if (!Number.isFinite(target) || target <= now) {
    const tomorrow = new Date(Date.parse(`${today}T12:00:00+08:00`) + 24 * 60 * 60_000);
    target = Date.parse(`${chinaDayKey(tomorrow)}T23:59:00+08:00`);
  }
  siteDailyArchiveTimer = setTimeout(async () => {
    try { await archiveSiteDay(chinaDayKey()); } catch (error) { console.warn('[stats] daily archive failed:', error.message); }
    scheduleSiteDailyArchive();
  }, Math.max(1_000, target - now));
  siteDailyArchiveTimer.unref?.();
  console.log(`[stats] daily archive scheduled: ${new Date(target).toISOString()}`);
}

function decodeLiquipediaHtml(value) {
  return String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function liquipediaUrl(value) {
  try {
    const url = new URL(decodeLiquipediaHtml(value), 'https://liquipedia.net');
    return url.hostname === 'liquipedia.net' || url.hostname.endsWith('.liquipedia.net') ? url.href : '';
  } catch {
    return '';
  }
}

function balancedDivAt(source, start) {
  const tokens = /<\/?div\b[^>]*>/gi;
  tokens.lastIndex = start;
  let depth = 0;
  for (let token; (token = tokens.exec(source));) {
    if (token[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) return source.slice(start, tokens.lastIndex);
  }
  return '';
}

function liquipediaDivBlocks(source, className) {
  const openings = /<div\b[^>]*class="([^"]*)"[^>]*>/gi;
  const blocks = [];
  for (const opening of source.matchAll(openings)) {
    if (!opening[1].split(/\s+/).includes(className)) continue;
    const block = balancedDivAt(source, opening.index);
    if (block) blocks.push({ opening: opening[0], html: block });
  }
  return blocks;
}

function parseLiquipediaMatch(card) {
  const timestamp = Number(card.match(/data-timestamp="(\d+)"/)?.[1] || 0);
  const finished = /data-finished="finished"/i.test(card);
  const opponentBlocks = liquipediaDivBlocks(card, 'match-info-header-opponent').slice(0, 2);
  const opponents = opponentBlocks.map(block => {
    const members = [...block.html.matchAll(/<span class="name"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(match => decodeLiquipediaHtml(match[1]))
      .filter(Boolean);
    const flagImage = block.html.match(/<span class="flag"[^>]*>[\s\S]*?<img\b[^>]*src="([^"]+)"/i)?.[1] || '';
    const country = decodeLiquipediaHtml(block.html.match(/<span class="flag"[^>]*>[\s\S]*?<img\b[^>]*alt="([^"]*)"/i)?.[1]);
    const countryCode = flagImage.match(/\/([a-z]{2})_hd\.png(?:\/|$)/i)?.[1]?.toUpperCase() || '';
    const href = block.html.match(/<span class="name"[^>]*>[\s\S]*?<a\b[^>]*href="([^"]+)"/i)?.[1] || '';
    return {
      name: members.join(' / ') || '待定',
      members,
      country,
      countryCode,
      flag: liquipediaUrl(flagImage),
      url: liquipediaUrl(href),
      winner: /match-info-header-winner/i.test(block.opening),
      loser: /match-info-header-loser/i.test(block.opening)
    };
  });
  while (opponents.length < 2) opponents.push({ name: '待定', members: [], country: '', countryCode: '', flag: '', url: '', winner: false, loser: false });
  const scores = [...card.matchAll(/class="match-info-header-scoreholder-score(?: [^"]*)?"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(match => decodeLiquipediaHtml(match[1]))
    .slice(0, 2);
  const tournamentBlock = liquipediaDivBlocks(card, 'match-info-tournament')[0]?.html || '';
  const tournamentName = decodeLiquipediaHtml(tournamentBlock.match(/<span class="match-info-tournament-name"[^>]*>([\s\S]*?)<\/span>/i)?.[1]) || '未命名赛事';
  const tournamentHref = tournamentBlock.match(/<a\b[^>]*href="([^"]+)"/i)?.[1] || '';
  let tournamentLogoLight = '';
  let tournamentLogoDark = '';
  for (const logo of tournamentBlock.matchAll(/<span class="league-icon-small-image([^"]*)"[^>]*>[\s\S]*?<img\b[^>]*src="([^"]+)"/gi)) {
    const source = liquipediaUrl(logo[2]);
    if (!source) continue;
    if (/darkmode/i.test(logo[1])) tournamentLogoDark ||= source;
    else if (/lightmode/i.test(logo[1])) tournamentLogoLight ||= source;
    else {
      tournamentLogoLight ||= source;
      tournamentLogoDark ||= source;
    }
  }
  const plainText = decodeLiquipediaHtml(card);
  const bestOf = Number(plainText.match(/\(Bo(\d+)\)/i)?.[1] || 0) || null;
  const status = finished ? 'completed' : timestamp > 0 && timestamp * 1000 <= Date.now() ? 'ongoing' : 'upcoming';
  const identity = [timestamp, tournamentName, ...opponents.map(opponent => opponent.name)].join('|');
  return {
    id: createHash('sha256').update(identity).digest('hex').slice(0, 16),
    status,
    startTime: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
    timestamp,
    opponents,
    score: scores.length >= 2 ? scores : ['', ''],
    bestOf,
    tournament: {
      name: tournamentName,
      url: liquipediaUrl(tournamentHref),
      logo: tournamentLogoLight || tournamentLogoDark,
      logoLight: tournamentLogoLight || tournamentLogoDark,
      logoDark: tournamentLogoDark || tournamentLogoLight
    }
  };
}

function parseLiquipediaMatches(html) {
  const deduped = new Map();
  for (const block of liquipediaDivBlocks(html, 'match-info')) {
    const match = parseLiquipediaMatch(block.html);
    if (match.timestamp && match.opponents.some(opponent => opponent.name !== '待定')) deduped.set(match.id, match);
  }
  const matches = [...deduped.values()];
  const upcoming = matches
    .filter(match => match.status !== 'completed')
    .sort((left, right) => (left.status === 'ongoing' ? -1 : 1) - (right.status === 'ongoing' ? -1 : 1) || left.timestamp - right.timestamp);
  const completed = matches.filter(match => match.status === 'completed').sort((left, right) => right.timestamp - left.timestamp);
  return { upcoming, completed };
}

function normalizedTournamentTier(value) {
  const match = String(value || '').trim().toUpperCase().match(/^([SAB])(?:[- ]?TIER)?$/);
  return match?.[1] || '';
}

async function addMatchTiers(parsed) {
  let tournaments = [];
  try { tournaments = (await loadLiquipediaTournaments()).tournaments || []; } catch {}
  const tiers = new Map(tournaments.map(item=>[normalizeEventPlayerName(item.name), normalizedTournamentTier(item.tier)]));
  const apply = match => ({ ...match, tournament:{ ...match.tournament, tier:tiers.get(normalizeEventPlayerName(match.tournament?.name)) || '' } });
  return { upcoming:parsed.upcoming.map(apply), completed:parsed.completed.map(apply) };
}

function announceMatchTransitions(previous, next) {
  if (!previous) return;
  const prior = new Map([...(previous.upcoming || []),...(previous.completed || [])].map(match=>[match.id,match]));
  for (const match of next.upcoming || []) {
    const tier=normalizedTournamentTier(match.tournament?.tier);
    if (tier && match.status==='ongoing' && prior.get(match.id)?.status!=='ongoing') realtimeChat.announceMatch({phase:'start',match,tier});
  }
  for (const match of next.completed || []) {
    const tier=normalizedTournamentTier(match.tournament?.tier);
    if (tier && prior.get(match.id)?.status!=='completed') realtimeChat.announceMatch({phase:'end',match,tier});
  }
}

async function loadLiquipediaMatchesCache() {
  if (liquipediaMatchesCacheLoaded) return liquipediaMatchesCache;
  liquipediaMatchesCacheLoaded = true;
  try {
    const cached = JSON.parse(await readFile(liquipediaMatchesCachePath, 'utf8'));
    if (cached && Array.isArray(cached.upcoming) && Array.isArray(cached.completed)) {
      liquipediaMatchesCache = cached;
      rebuildLiquipediaLivePlayerCache(cached);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[events] cached matches unavailable:', error.message);
  }
  return liquipediaMatchesCache;
}

async function refreshLiquipediaMatches() {
  if (liquipediaMatchesRefreshPromise) return liquipediaMatchesRefreshPromise;
  liquipediaMatchesRefreshPromise = (async () => {
    await loadLiquipediaMatchesCache();
    const cachedAt = Date.parse(liquipediaMatchesCache?.fetchedAt || 0);
    if (Number.isFinite(cachedAt) && Date.now() - cachedAt < liquipediaMatchesRefreshInterval) return liquipediaMatchesCache;
    const sourceText = '<div data-aoe2cn-section="upcoming">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=upcoming|limit=50|filterbuttons-game=Age of Empires II}}</div><div data-aoe2cn-section="recent">{{#invoke:Lua|invoke|module=MatchTicker/Custom|fn=mainPage|type=recent|limit=50|filterbuttons-game=Age of Empires II}}</div>';
    const form = new URLSearchParams({ action: 'parse', text: sourceText, title: 'Liquipedia:Upcoming and ongoing matches', prop: 'text', format: 'json', formatversion: '2' });
    const payload = await queueLiquipediaParse(async () => {
      const response = await fetch(liquipediaApiUrl, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': liquipediaUserAgent
        },
        body: form,
        signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) throw new Error(`Liquipedia API 返回 HTTP ${response.status}`);
      return response.json();
    },0);
    const html = String(payload?.parse?.text || '');
    if (!html.includes('match-info')) throw new Error('Liquipedia API 未返回比赛信息');
    const previous = liquipediaMatchesCache;
    const parsed = await addMatchTiers(parseLiquipediaMatches(html));
    const next = {
      fetchedAt: new Date().toISOString(),
      refreshIntervalMs: liquipediaMatchesRefreshInterval,
      upcoming: parsed.upcoming,
      completed: parsed.completed,
      source: {
        name: 'Liquipedia',
        url: 'https://liquipedia.net/ageofempires/Liquipedia:Upcoming_and_ongoing_matches',
        license: 'CC BY-SA 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/'
      }
    };
    await mkdir(dataDir, { recursive: true });
    const temporaryPath = `${liquipediaMatchesCachePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporaryPath, liquipediaMatchesCachePath);
    liquipediaMatchesCache = next;
    rebuildLiquipediaLivePlayerCache(next);
    announceMatchTransitions(previous, next);
    liquipediaMatchesLastError = null;
    return next;
  })().catch(error => {
    liquipediaMatchesLastError = error.message || String(error);
    throw error;
  }).finally(() => {
    liquipediaMatchesRefreshPromise = null;
  });
  return liquipediaMatchesRefreshPromise;
}

function nextBeijingHour(hour, now=Date.now()) {
  const shifted=new Date(now+8*60*60_000);
  let target=Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate(),hour-8,0,0,0);
  if (target<=now) target+=24*60*60_000;
  return target;
}

function scheduleMatchPreview() {
  const target=nextBeijingHour(18);
  setTimeout(async()=>{
    try {
      const data=await refreshLiquipediaMatches();
      const start=Date.now(), end=start+12*60*60_000;
      const matches=(data?.upcoming || []).filter(match=>match.timestamp*1000>=start && match.timestamp*1000<end)
        .map(match=>({...match,tier:normalizedTournamentTier(match.tournament?.tier)})).filter(match=>match.tier);
      realtimeChat.announceSchedule({day:chinaDayKey(new Date()),matches});
    } catch(error) { console.warn('[realtime-chat] match preview failed:',error.message); }
    scheduleMatchPreview();
  },Math.max(1000,target-Date.now())).unref();
}

async function startLiquipediaMatchesLifecycle() {
  await loadLiquipediaMatchesCache();
  try {
    await refreshLiquipediaMatches();
  } catch (error) {
    console.warn('[events] initial Liquipedia refresh failed:', error.message);
  }
  setInterval(() => {
    refreshLiquipediaMatches().catch(error => console.warn('[events] Liquipedia refresh failed:', error.message));
  }, liquipediaMatchesRefreshInterval).unref();
  scheduleMatchPreview();
}

function sendNoStoreJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  return res.end(JSON.stringify(data));
}

function sendVersionedJson(req, res, data, version, maxAgeSeconds) {
  const versionText = String(version || 'snapshot').replace(/[^a-zA-Z0-9_.:-]/g, '_');
  const etag = `"${versionText}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    etag,
    'cache-control': `public, max-age=${Math.max(1, Math.floor(maxAgeSeconds || 60))}, stale-while-revalidate=30`
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  return res.end(JSON.stringify(data));
}

const httpServer = http.createServer(safeHttpHandler(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const protectionIp = requestClientIp(req);
  if (!apiProtection.allow(req, res, url.pathname, protectionIp, isInternalIp(protectionIp))) return;
  if (['/api/civilization-stats', '/api/civilization-stats/meta', '/api/civilization-stats/winrates'].includes(url.pathname)) {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    try {
      const kind = url.pathname.endsWith('/meta') ? 'meta' : url.pathname.endsWith('/winrates') ? 'winrates' : 'stats';
      const filters = kind === 'stats' ? parseCivilizationFilters(url.searchParams) : {};
      const result = await civilizationStats.query(kind, filters);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
      return res.end(JSON.stringify(result));
    } catch (error) {
      return sendNoStoreJson(res, error.statusCode || 503, { error: error.statusCode === 400 ? error.message : '民族数据暂时无法读取，请稍后重试' });
    }
  }
  if (url.pathname === '/replay-analysis' && url.search) res.setHeader('x-robots-tag', 'noindex, nofollow');
  if (url.pathname === '/api/internal/health') {
    if (!isInternalIp(protectionIp)) return sendNoStoreJson(res, 404, { error: 'Not found' });
    const worker = await background.health();
    return sendNoStoreJson(res, 200, { ok: true, uptime: process.uptime(), background: worker, caches: { avatars: avatarCache.stats(), personalStats: personalStatsCache.stats(), livePlayerStats: livePlayerStatsCache.stats(), profiles: aoe2RecsProfileCache.stats(), matches: worldsEdgeMatchCache.stats() } });
  }
  if (url.pathname === '/api/replay-analysis/status') {
    const jobId = url.searchParams.get('jobId') || '';
    if (!/^[a-f0-9-]{36}$/.test(jobId)) return sendNoStoreJson(res, 400, { error: '无效的任务 ID' });
    const response = await background.poll(jobId);
    return streamResponse(response, res, { limit: 128 * 1024 * 1024,
      headers: { 'x-replay-cache': response.headers.get('x-replay-cache') || '' } });
  }
  if (url.pathname === '/api/protection/status') {
    if (!isInternalIp(protectionIp)) return sendNoStoreJson(res, 404, { error: 'Not found' });
    return sendNoStoreJson(res, 200, apiProtection.stats());
  }
  if (url.pathname === '/api/site-stats') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    try {
      await ensureSiteTrafficState();
      const stats = currentSiteStats();
      return sendVersionedJson(req, res, stats, `site-stats-${stats.date}-${stats.users}-${stats.views}`, 60);
    } catch (error) {
      return sendNoStoreJson(res, 500, { error: error.message || '读取访问统计失败' });
    }
  }
  if (url.pathname === '/api/page-view') {
    if (req.method !== 'POST') return sendNoStoreJson(res, 405, { error: '仅支持 POST 请求' });
    try {
      return sendNoStoreJson(res, 200, await recordPageView(req));
    } catch (error) {
      return sendNoStoreJson(res, 500, { error: error.message || '记录访问失败' });
    }
  }
  if (url.pathname === '/api/events') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    const cached = await loadLiquipediaMatchesCache();
    if (!cached) return sendNoStoreJson(res, 503, { error: '赛事数据正在首次同步，请稍后重试' });
    const data = { ...cached, stale: Boolean(liquipediaMatchesLastError) };
    return sendVersionedJson(req, res, data, `events-${cached.fetchedAt}`, 60);
  }
  if (url.pathname === '/api/tournaments') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    try {
      const data = await loadLiquipediaTournaments();
      return sendVersionedJson(req, res, data, `tournaments-${data.fetchedAt}`, 60);
    } catch (error) {
      return sendNoStoreJson(res, 502, { error: error.message || '赛事列表获取失败' });
    }
  }
  if (url.pathname === '/api/tournament-results') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    const category = url.searchParams.get('category') || 's';
    if (!Object.hasOwn(tournamentResultCategories,category)) return sendNoStoreJson(res,400,{error:'未知赛事分类'});
    const cache = await loadLiquipediaResultsCache();
    const snapshot = cache.categories[category];
    const fresh = snapshot && Date.now()-Date.parse(snapshot.fetchedAt || 0) < liquipediaResultsRefreshInterval;
    if (!fresh) refreshLiquipediaResults(category).catch(error=>console.warn(`[event-results] ${category} refresh failed:`,error.message));
    if (!snapshot) return sendNoStoreJson(res,202,{status:'syncing',retryAfterSeconds:30});
    const matches=await loadLiquipediaMatchesCache();
    const completed=matches?.completed || [];
    const rows=snapshot.rows.map(row=>({...row,score:row.score || resultScore(row,completed)}));
    return sendVersionedJson(req,res,{...snapshot,rows,stale:!fresh},`tournament-results-${category}-${snapshot.fetchedAt}`,300);
  }
  if (url.pathname === '/api/feedback/recent') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    try {
      return sendNoStoreJson(res, 200, { items: feedbackLikes.decorate(await recentFeedback(feedbackLogPath), requestClientIp(req)) });
    } catch {
      return sendNoStoreJson(res, 500, { error: '暂时无法读取反馈列表' });
    }
  }
  if (url.pathname === '/api/feedback/like') {
    if (req.method !== 'POST') return sendNoStoreJson(res, 405, { error: '仅支持 POST 请求' });
    let source;
    try { source = new URL(req.headers.origin).host; } catch {}
    if (source !== req.headers.host || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return sendNoStoreJson(res, 403, { error: '请从本站反馈页面点赞' });
    }
    try {
      const payload = await readJsonRequest(req);
      const id = payload?.id;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return sendNoStoreJson(res, 400, { error: '反馈编号无效' });
      const items = await recentFeedback(feedbackLogPath);
      if (!items.some(item => item.id === id)) return sendNoStoreJson(res, 404, { error: '反馈已不在最新列表，请刷新后重试' });
      return sendNoStoreJson(res, 200, { id, ...feedbackLikes.like(id, requestClientIp(req)) });
    } catch (error) {
      return sendNoStoreJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : '点赞保存失败，请稍后重试' });
    }
  }
  if (url.pathname === '/api/feedback') {
    const ip = requestClientIp(req);
    if (req.method === 'GET') {
      try {
        return sendNoStoreJson(res, 200, await feedbackStatus(ip));
      } catch (error) {
        return sendNoStoreJson(res, 500, { error: error.message || '读取反馈状态失败' });
      }
    }
    if (req.method !== 'POST') return sendNoStoreJson(res, 405, { error: '仅支持 GET 或 POST 请求' });
    try {
      const payload = await readJsonRequest(req);
      const content = String(payload?.content || '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
      const length = [...content].length;
      if (!length) return sendNoStoreJson(res, 400, { error: '请输入建议或反馈' });
      if (length > feedbackMaxLength) return sendNoStoreJson(res, 400, { error: `反馈内容不能超过 ${feedbackMaxLength} 个字` });
      return sendNoStoreJson(res, 201, { ok: true, ...(await saveFeedback(ip, content)) });
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      return sendNoStoreJson(res, statusCode, { error: statusCode >= 500 ? '反馈保存失败，请稍后再试' : error.message });
    }
  }
  if (url.pathname === '/api/realtime/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(realtimeService.getRealtimeStatus()));
  }
  if (url.pathname === '/api/realtime/chat' || url.pathname === '/api/realtime/chat/nickname') {
    const nicknameOnly = url.pathname.endsWith('/nickname');
    if (req.method === 'GET' && !nicknameOnly) {
      try { return sendNoStoreJson(res, 200, { messages: realtimeChat.list(), viewer: realtimeChat.viewer(requestClientIp(req)) }); }
      catch { return sendNoStoreJson(res, 500, { error: '聊天记录暂时无法读取' }); }
    }
    if (req.method !== 'POST') return sendNoStoreJson(res, 405, { error: '仅支持 GET 或 POST 请求' });
    let originHost = '';
    try { originHost = new URL(req.headers.origin).host; } catch {}
    if (originHost !== req.headers.host || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return sendNoStoreJson(res, 403, { error: '请从本站实时对局页面发言' });
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendNoStoreJson(res, 415, { error: '请使用 JSON 格式提交' });
    try {
      const body = await readJsonRequest(req, 1024);
      const ip = requestClientIp(req);
      if (nicknameOnly) return sendNoStoreJson(res, 200, { viewer: realtimeChat.rename({ name: body?.name, ip }) });
      const message = realtimeChat.post({ name: body?.name, message: body?.message, ip });
      return sendNoStoreJson(res, 201, { message, viewer: realtimeChat.viewer(ip) });
    } catch (error) {
      return sendNoStoreJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : '发言暂时无法发送' });
    }
  }
  if (url.pathname === '/api/realtime/version') {
    let profileIds = [];
    try { const pool = JSON.parse(await readFile(join(dataDir, 'realtime-profile-pool.json'), 'utf8')); profileIds = Array.isArray(pool.ids) && pool.ids.length ? pool.ids : [506898,8793414,212721,3025516,1966276]; } catch { profileIds = [506898,8793414,212721,3025516,1966276]; }
    const ids = [...new Set(profileIds.map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const cachedPayload = await realtimeService.getCachedPayload(ids);
    const version = cachedPayload?.checkedAt || null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ version, checkedAt: version }));
  }
  if (url.pathname === '/api/realtime') {
    let profileIds = [];
    try { const requested = url.searchParams.get('profile_ids'); if (requested) profileIds = JSON.parse(requested); else { const pool = JSON.parse(await readFile(join(dataDir, 'realtime-profile-pool.json'), 'utf8')); profileIds = Array.isArray(pool.ids) && pool.ids.length ? pool.ids : [506898,8793414,212721,3025516,1966276]; } } catch { profileIds = [506898,8793414,212721,3025516,1966276]; }
    const ids = [...new Set(profileIds.map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    // This endpoint is cache-only. The scheduled server task is the only code
    // path that calls the upstream match API; browser reads never trigger refresh.
    const cachedPayload = await realtimeService.getCachedPayload(ids);
    if (cachedPayload) {
      const etag = `"realtime-${Buffer.from(String(cachedPayload.checkedAt || 'empty')).toString('base64url')}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag, 'cache-control': 'private, no-cache' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-cache', etag });
      return res.end(JSON.stringify(cachedPayload));
    }
    const emptyPayload = { source: 'aoe2companion-latest', checkedAt: null, states: [] };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(emptyPayload));
  }
  if (url.pathname === '/api/profile-search/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(profileStatePayload()));
  }
  if (url.pathname === '/api/profile-search') {
    const query = (url.searchParams.get('q') || '').trim();
    if ([...query].length < 2 || [...query].length > 80) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '昵称至少输入2个字符，最多80个字符' }));
    }
    if (!profileDb) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: '玩家资料索引尚未准备好', ...profileStatePayload() }));
    }
    try {
      const leaderboardId = Number(url.searchParams.get('leaderboardId') || 3);
      const results = await searchProfiles(query, types[leaderboardId] ? leaderboardId : 3);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ query, results, updatedAt: profileCache?.updatedAt || null }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '查询玩家资料失败' }));
    }
  }
  if (url.pathname === '/api/profile-details') {
    const profileId = url.searchParams.get('id') || '';
    if (!/^\d+$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的选手 ID' }));
    }
    try {
      const profile = localProfileDetails(profileId);
      if (!profile) throw new Error('本地资料库中没有该选手');
      const rlReference = (await loadRlReference()).get(String(profileId)) || null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
      return res.end(JSON.stringify({ ...profile, rlReference, cached: true, stale: false, source: 'profile-dump' }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取选手资料失败' }));
    }
  }
  if (url.pathname === '/api/profile-accounts') {
    const profileId = url.searchParams.get('id') || '';
    if (!/^\d+$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的选手 ID' }));
    }
    try {
      const result = await getAoE2RecsProfile(profileId);
      const rlReference = await loadRlReference();
      const accounts = (result.profile.accounts || []).map(account => ({ ...account, rlReference: rlReference.get(String(account.id ?? '').trim()) || null }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': result.stale ? 'no-cache' : 'public, max-age=300' });
      return res.end(JSON.stringify({ accounts, avatar: result.profile.avatar || '', cached: result.cached, stale: result.stale, source: 'aoe2recs' }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取账号与曾用名失败' }));
    }
  }
  if (url.pathname === '/api/profile-matches') {
    const profileId = url.searchParams.get('id') || '';
    if (!/^\d+$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的选手 ID' }));
    }
    if (url.searchParams.get('latest') === '1') {
      try {
        const latest = await fetchLatestProfileMatchOnce(profileId);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ matches: latest ? [latest] : [], latest: true }));
      } catch {
        try {
          const fallback = await readWorldsEdgeMatchesCache(profileId);
          if (!fallback?.matches?.length) throw new Error('查询失败，暂无可用对局缓存');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ matches: fallback.matches?.[0] ? [fallback.matches[0]] : [], latest: true, stale: true }));
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ error: error.message || '获取最新对局失败' }));
        }
      }
    }
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    const limit = Math.min(100, Math.max(20, Number(url.searchParams.get('limit') || 100)));
    const progressive = url.searchParams.get('progressive') === '1' && offset === 0;
    try {
      if (progressive) {
        let initial = await readWorldsEdgeMatchesCache(profileId);
        const cachedFirst = Boolean(initial?.matches?.length);
        if (!cachedFirst) try {
          initial = await fetchProfileMatchesOnce(profileId, 1, 20);
        } catch {
          // If the initial lookup fails, use an existing snapshot without
          // starting another series of upstream retries.
          const fallback = await readWorldsEdgeMatchesCache(profileId);
          if (!fallback?.matches?.length) throw new Error('查询失败，暂无可用对局缓存');
          initial = { matches: fallback.matches.slice(0, 20), hasMore: false };
        }
        // Continue the cache refresh in the background. The first 20 matches
        // are already available to the client and can be rendered immediately.
        getWorldsEdgeMatches(profileId, 1).catch(error => console.error(`选手 ${profileId} 对局缓存更新失败:`, error.message));
        const page = initial.matches.slice(0, 20);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ matches: page, offset: 0, total: page.length, hasMore: true, progressive: true, cached:cachedFirst,
          stale:cachedFirst && Date.now()-initial.savedAt >= worldsEdgeMatchCacheTtl }));
      }
      const pageNumber = Math.floor(offset / 100) + 1;
      const cached = await getWorldsEdgeMatches(profileId, pageNumber);
      const matches = cached.matches;
      const page = matches.slice(offset, offset + limit);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cached.stale ? 'no-store' : 'public, max-age=60' });
      return res.end(JSON.stringify({ matches: page, offset, total: matches.length, hasMore: offset + page.length < matches.length || cached.hasMore, stale:Boolean(cached.stale) }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取近期对局失败' }));
    }
  }
  if (url.pathname === '/api/replay-match-info') {
    const matchId = url.searchParams.get('matchId') || '';
    if (!/^[1-9]\d{0,15}$/.test(matchId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: '无效的比赛 ID' }));
    }
    try {
      const data = await replayAnalysisService.getMatchInfo(matchId);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=1800' });
      return res.end(JSON.stringify(data));
    } catch {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: '暂时无法读取对局信息' }));
    }
  }
  if (url.pathname === '/api/replay-analysis') {
    const matchId = url.searchParams.get('matchId') || '';
    const profileId = url.searchParams.get('profileId') || '';
    if (!['GET', 'POST'].includes(req.method)) {
      res.writeHead(405, { allow: 'GET, POST' });
      return res.end();
    }
    if (!/^[1-9]\d{0,15}$/.test(matchId) || !/^[1-9]\d{0,15}$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: '无效的比赛或玩家 ID' }));
    }
    try {
      // Crawlers rendering a replay page may read a cached result, but a GET
      // must never download or parse a recording. A button explicitly POSTs.
      if (req.method === 'GET') {
        const cached = await background.cached(matchId, profileId);
        return streamResponse(cached, res, { limit: 128 * 1024 * 1024, headers: { 'x-replay-cache': cached.headers.get('x-replay-cache') || '' } });
      }
      const task = await background.submit(matchId, profileId);
      return sendNoStoreJson(res, 202, { ...task, pollUrl: `/api/replay-analysis/status?jobId=${task.jobId}` });
    } catch (error) {
      console.error('录像分析失败:', matchId, profileId, error.message);
      res.writeHead(error.statusCode || 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '录像分析失败，请稍后重试' }));
    }
  }
  if (url.pathname === '/api/match-replay') {
    const matchId = url.searchParams.get('matchId') || '';
    const profileId = url.searchParams.get('profileId') || '';
    if (!/^\d+$/.test(matchId) || !/^\d+$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的比赛或玩家 ID' }));
    }
    try {
      const response = await background.download(matchId, profileId);
      return await streamResponse(response, res);
    } catch (error) {
      if (res.headersSent) throw error;
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '录像下载失败' }));
    }
  }
  if (url.pathname === '/api/profile-leaderboards') {
    const profileId = url.searchParams.get('id') || '';
    if (!/^\d+$/.test(profileId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的选手 ID' }));
    }
    try {
      const leaderboards = await fetchPersonalLeaderboardStats(profileId, { rankedOnly:url.searchParams.get('progressive') === '1' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': leaderboards.some(row => row.pending || row.stale) ? 'no-store' : 'public, max-age=600' });
      return res.end(JSON.stringify({ leaderboards, source: 'getPersonalStat' }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取个人天梯数据失败' }));
    }
  }
  if (url.pathname.startsWith('/assets/game/')) {
    const assetMatch = url.pathname.match(/^\/assets\/game\/(map|civilization)\/([a-z0-9_]+)\.png$/);
    if (!assetMatch) {
      res.writeHead(404); return res.end('Not found');
    }
    try {
      const data = await getGameAsset(assetMatch[1], assetMatch[2]);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800, immutable' });
      return res.end(data);
    } catch {
      res.writeHead(404, { 'cache-control': 'public, max-age=300' });
      return res.end('Not found');
    }
  }
  if (url.pathname === '/api/leaderboard-summary') {
    try {
      const leaderboardId = Number(url.searchParams.get('id') || 3);
      const requestedCountry = String(url.searchParams.get('country') || 'all');
      const country = requestedCountry.toLowerCase() === 'all' ? 'all' : requestedCountry.toUpperCase();
      if (!types[leaderboardId]) throw new Error('榜单类型无效');
      const summary = await fetchLeaderboardSummary(leaderboardId, country);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(summary));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '无法获取榜单摘要' }));
    }
  }
  if (url.pathname === '/api/leaderboard') {
    const id = Number(url.searchParams.get('id') || 3);
    if (!types[id]) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '不支持的榜单类型' }));
    }
    try {
      const page = Math.max(1, Number(url.searchParams.get('page') || 1));
      const data = await getLeaderboardPage(id, page);
      // Each response carries the next scheduler deadline even when rows have
      // not changed. An ETag based only on updatedAt can reuse an expired body.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '获取天梯数据失败' }));
    }
  }

  if (url.pathname === '/api/media/thumbnail') {
    try {
      const sourceUrl = url.searchParams.get('url') || '';
      const id = url.searchParams.get('id') || 'thumbnail';
      const live = url.searchParams.get('live') === '1';
      const thumbnail = await getMediaThumbnail(sourceUrl, id, live ? 5 * 60_000 : 0);
      res.writeHead(200, { 'content-type': thumbnail.contentType, 'cache-control': `public, max-age=${live ? 300 : 86400}` });
      return res.end(thumbnail.data);
    } catch (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(error.message || '封面不可用');
    }
  }

  if (url.pathname === '/api/media') {
    try {
      let data = await getMediaCache();
      let promotionDeadline = Infinity;
      try {
        const promotions = JSON.parse(await readFile(join(dataDir, 'media-video-promotions.json'), 'utf8'));
        const active = promotions.filter(item => item.id && item.url && Date.parse(item.expiresAt) > Date.now());
        if (active.length) {
          const ids = new Set(active.map(item => String(item.id)));
          promotionDeadline = Math.min(...active.map(item => Date.parse(item.expiresAt)));
          data = { ...data, videos: [...active, ...data.videos.filter(item => !ids.has(String(item.id)))] };
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const maxAgeSeconds = Math.max(1, Math.min(60, Math.ceil((Math.min(promotionDeadline, Date.parse(data.nextRefreshAt || '')) - Date.now()) / 1000)));
      return sendVersionedJson(req, res, data, `media-${data.updatedAt || 'snapshot'}-promotion-${Number.isFinite(promotionDeadline) ? promotionDeadline : 'none'}`, maxAgeSeconds);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '获取视频直播数据失败' }));
    }
  }

  if (url.pathname === '/api/updates') {
    try {
      const data = await getBilibiliUpdates(url.searchParams.get('articleId') || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取更新汇总失败' }));
    }
  }

  if (url.pathname === '/api/build-orders') {
    try {
      const data = await getBuildOrders(url.searchParams.get('slug') || '');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取开局指南失败' }));
    }
  }

  if (url.pathname.startsWith('/api/avatar-image/')) {
    const match = url.pathname.match(/^\/api\/avatar-image\/([a-f0-9]{64})\.(jpeg|png|webp|gif)$/);
    const bytes = match ? await avatarCache.image(match[1]) : null;
    if (!bytes) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
    const etag = `"${match[1]}"`;
    const headers = { 'content-type': `image/${match[2]}`, 'cache-control': 'public, max-age=86400', etag, 'x-content-type-options': 'nosniff' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, { ...headers, 'content-length': bytes.length });
    return res.end(bytes);
  }
  if (url.pathname === '/api/avatar') {
    let steamId = url.searchParams.get('steamId') || '';
    const profileId = url.searchParams.get('profileId') || '';
    if (!/^\d{17}$/.test(steamId) && /^\d+$/.test(profileId) && profileDb) {
      steamId = String(profileDb.prepare('SELECT steam_id AS steamId FROM profiles WHERE profile_id = ?').get(profileId)?.steamId || '');
    }
    const key = /^\d{17}$/.test(steamId) ? `steam:${steamId}` : /^\d+$/.test(profileId) ? `profile:${profileId}` : '';
    if (!key) { res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ error: '找不到可用头像' })); }
    try {
      const entry = await avatarCache.get(key);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': entry.expires > Date.now() ? 'private, max-age=86400' : 'no-cache' });
      return res.end(JSON.stringify({ avatar: `/api/avatar-image/${entry.hash}.${entry.type.split('/')[1]}`, expires: entry.expires }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '头像暂不可用' }));
    }
  }

  const relative = url.pathname === '/' || /^\/(?:profile(?:\/\d+)?|media(?:\/videos)?|replay-analysis|updates|realtime|events(?:\/results)?|feedback|civilizations|tech-tree|build-orders(?:\/[a-z0-9-]+)?)\/?$/i.test(url.pathname) ? 'index.html' : url.pathname.slice(1);
  const path = await staticFilePath(join(root, 'public'), relative);
  try {
    const data = await readFile(path);
    const extension = extname(path).toLowerCase();
    const cacheableAsset = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf'].includes(extension);
    res.writeHead(200, {
      'content-type': mime[extension] || 'application/octet-stream',
      'cache-control': cacheableAsset ? 'public, max-age=604800, immutable' : 'no-cache'
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}));
httpServer.requestTimeout = 30000;
httpServer.headersTimeout = 15000;
httpServer.keepAliveTimeout = 5000;
httpServer.maxHeadersCount = 100;
httpServer.listen(port, '127.0.0.1', () => {
  console.log(`AoE2DE Ladder running at http://localhost:${port}`);
  startLiquipediaMatchesLifecycle().catch(error => console.warn('[events] lifecycle startup failed:', error.message));
  scheduleLiquipediaResultsRefresh().catch(error=>console.warn('[event-results] scheduler startup failed:',error.message));
  refreshMediaCache().catch(error => console.warn('[media] initial refresh failed:', error.message));
  startBilibiliUpdatesLifecycle().catch(error => console.warn('[updates] lifecycle startup failed:', error.message));
  leaderboardDumpSummary.start();
  startProfileCacheLifecycle().catch(error => console.error('启动玩家资料缓存失败:', error.message));
  ensureSiteTrafficState().then(() => scheduleSiteDailyArchive()).catch(error => console.warn('[stats] daily archive startup failed:', error.message));
  let lastRealtimeApiFallbackAt = Date.now();
  const refreshRealtimeOnServer = async () => {
    try {
      const pool = JSON.parse(await readFile(join(dataDir, 'realtime-profile-pool.json'), 'utf8'));
      const ids = Array.isArray(pool.ids) && pool.ids.length ? pool.ids : [506898,8793414,212721,3025516,1966276];
      await realtimeService.startRealtimeWebSockets(ids);
      if (!realtimeService.realtimeWebSocketsHealthy(ids)) {
        const cachedPayload = await realtimeService.getCachedPayload(ids);
        const fallbackIntervalMs = 5 * 60 * 1000;
        if (!cachedPayload || Date.now() - lastRealtimeApiFallbackAt >= fallbackIntervalMs) {
          lastRealtimeApiFallbackAt = Date.now();
          await realtimeService.refreshRealtimePayload(ids);
        }
      }
    } catch (error) { console.warn('[realtime] scheduled refresh failed:', error.message); }
  };
  setTimeout(refreshRealtimeOnServer, 1000).unref();
  setInterval(refreshRealtimeOnServer, 60 * 1000).unref();
});


process.once('SIGTERM', () => {
  feedbackLikes.close();
  httpServer.close();
  Promise.all([apiProtection.flush(), civilizationStats.close()]).finally(() => process.exit(0));
});
