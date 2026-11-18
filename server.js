import { createMediaScheduler } from './server/services/media-scheduler.js';
import { createMediaVideoStateStore } from './server/services/media-video-state.js';
import { createProfileRoutes } from './server/routes/profile.js';
import { chromium } from 'playwright';
import { createAoE2RecsBrowser } from './server/services/aoe2recs-browser.js';
import { createAoE2RecsRequestGate } from './server/services/aoe2recs-request-gate.js';
import { qualifiesForSchedule } from './public/realtime-schedule.js';
import { BoundedCache } from './server/services/bounded-cache.js';
import { createCivilizationStats, parseCivilizationFilters } from './server/services/civilization-stats.js';
import { createBackgroundClient } from './server/services/background-client.js';
import { queueDanmakuMatch } from './server/services/danmaku-outbox.js';
import { streamResponse } from './server/services/response-stream.js';
import { safeHttpHandler, staticFilePath } from './server/services/http-safety.js';
import { createApiProtection } from './server/services/api-protection.js';
import { createAvatarCache } from './server/services/avatar-cache.js';
import { createProfileSearchPool } from './server/services/profile-search-pool.js';
import { resolveTournament } from './server/services/tournament-identity.js';
import { createVerifiedRealtimeNames } from './server/services/realtime-player-names.js';
import { parseTournamentRounds, findTournamentRound } from './server/services/tournament-rounds.js';
import http from 'node:http';
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
import { appendNewTournamentResults, parseTournamentResultsHtml, tournamentResultCategories } from './server/services/liquipedia-tournament-results.js';
import { forceChinaCountry, isForcedChinaProfile } from './server/services/country-overrides.js';
import { fetchKickLive } from './server/services/kick-live.js';
import { createPlayerTeams } from './server/services/player-teams.js';
import { applyCnzsRoster, createCnzsRoster } from './server/services/liquipedia-cnzs.js';
import { createTeamRosterSync } from './server/services/liquipedia-team-rosters.js';
import { createProfileAccountsReader } from './server/services/profile-accounts.js';
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
const liquipediaMatchTiersCachePath = join(dataDir, 'liquipedia-match-tiers.json');
const tournamentEloTop32CachePath = join(dataDir, 'tournament-elo-top32.json');
const tournamentEloTop32RefreshInterval = 24 * 60 * 60_000;
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
      // Daily leaderboard avatar warmup must never consume the AoE2Recs
      // profile request gate. Keep the previous cached image when Steam fails.
      throw error;
    }
  }
});
const leaderboardCache = new Map();
const leaderboardRefreshes = new Map();
const leaderboardAvatarWarmup = { running:false, lastStartedAt:null, lastCompletedAt:null, result:null, error:null };
let tournamentEloPlayersCache = null;
let tournamentEloPlayersFetchedAt = 0;
let tournamentEloTop32Cache = null;
let tournamentEloTop32CacheLoadPromise = null;
let tournamentEloTop32RefreshPromise = null;
let tournamentEloTop32RetryAfter = 0;
let liquipediaMatchTiersCache = null;
let liquipediaMatchTiersCacheLoadPromise = null;
const liquipediaMatchTierQueue = [];
const liquipediaMatchTierQueued = new Set();
let liquipediaMatchTierQueueRunning = false;
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
const aoe2RecsSearchEntries = new Map();
let aoe2RecsSearchLoaded = false, aoe2RecsSearchLoading = null;
const aoe2RecsGateStatePath = join(dataDir, 'aoe2recs-request-cooldown.json');
const aoe2RecsBrowser = createAoE2RecsBrowser({ connect:() => chromium.connectOverCDP('http://127.0.0.1:9228', { timeout:10_000 }) });
let aoe2RecsVerificationNotified = false;
const fetchAoE2RecsProfileOnce = createAoE2RecsRequestGate({
  request: fetchAoE2RecsProfileTransport,
  readState: async () => {
    try { return JSON.parse(await readFile(aoe2RecsGateStatePath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  },
  saveState: async state => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${aoe2RecsGateStatePath}.tmp`, JSON.stringify(state), 'utf8');
    await rename(`${aoe2RecsGateStatePath}.tmp`, aoe2RecsGateStatePath);
  }
});
process.on('SIGUSR2', () => {
  fetchAoE2RecsProfileOnce.resetCooldown?.()
    .then(() => console.log('[aoe2recs] cooldown cleared by operator'))
    .catch(error => console.warn('[aoe2recs] cooldown reset failed:', error.message));
});
const gameAssetRefreshes = new Map();
const aoe2RecsProfileCacheTtl = 15 * 24 * 60 * 60_000;
const worldsEdgeMatchCacheDir = join(dataDir, 'worldsedge-matches');
const worldsEdgeMatchCacheTtl = 10 * 60_000;
const worldsEdgeMatchCache = new BoundedCache(512);
const worldsEdgeMatchRepairRefreshes = new Map();
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
const { state: mediaVideoState, load: loadPersistentMediaVideoState, save: savePersistentMediaVideoState } = createMediaVideoStateStore(mediaVideoStatePath);
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
        ratingProfileId: /^\d+$/.test(String(player.ratingProfileId || '')) ? String(player.ratingProfileId) : null,
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
  getBlockedUntil: host => host === 'api.bilibili.com' ? mediaVideoState.apiBlockedUntil : 0,
  onRisk: async ({host, blockedUntil}) => {
    if (host !== 'api.bilibili.com') return;
    await loadPersistentMediaVideoState();
    mediaVideoState.apiBlockedUntil = Math.max(mediaVideoState.apiBlockedUntil, blockedUntil);
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

function isBilibiliRateLimit(error) {
  return error?.riskResponse === true || error?.cooldown === true || [403, 412, 429].includes(Number(error?.status)) || [-412, -352, -403].includes(Number(error?.bilibiliCode));
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
      .filter(stat => Number(stat.leaderboard_id) === leaderboardId && Number(stat.rating) > 0 && Number.isFinite(Number(stat.rating)))
      .map(stat => ({ profileId: profileByStatGroup.get(Number(stat.statgroup_id)) || null, rating: Number(stat.rating), rank: Number(stat.rank) > 0 ? Number(stat.rank) : null }))
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
  if (source.platform === 'kick') return fetchKickLive(source);
  if (source.platform === 'douyu') return fetchDouyuLive(source);
  if (source.platform === 'douyin') return fetchDouyinLive(source);
  return fetchGenericLive(source);
}

async function fetchMediaLive() {
  const configured = await loadSelectedStreamers();
  const sources = configured.length ? configured : (Array.isArray(mediaSources.live) ? mediaSources.live : []);
  const results = [];
  // Keep the full round within the 90-second deadline even when several
  // platforms stall until their per-source timeout. With 128 configured
  // sources, batches of ten could spend more than six minutes here.
  const batchSize = 64;
  for (let index = 0; index < sources.length; index += batchSize) {
    const batch = sources.slice(index, index + batchSize);
    const batchResults = await Promise.all(batch.map(async source => {
      try {
        const item = await withMediaTimeout(
          fetchMediaLiveSource(source),
          mediaLiveSourceTimeout,
          `直播源 ${source.name || source.platform || source.url}`
        );
        return { ...item, name: source.name, rl: source.rl || [], ratingProfileId:source.ratingProfileId, isCN: source.isCN, sourceOrder: source.sourceOrder };
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
  const enriched = await Promise.all([...selected.values()].map(async item => {
    const { rl, ratingProfileId, ...publicItem } = item;
    const profileIds = (Array.isArray(rl) ? rl : []).map(String).filter(id => /^\d+$/.test(id));
    try {
      const leaderboards = await fetchLivePlayerLeaderboardStats(ratingProfileId ? [ratingProfileId] : rl);
      return leaderboards ? { ...publicItem, profileIds, leaderboards } : { ...publicItem, profileIds };
    } catch (error) {
      console.warn(`[media] live player stats failed: ${item.name || item.id}`, error.message);
      return { ...publicItem, profileIds };
    }
  }));
  const sorted = enriched.sort((a, b) => {
    if (a.isCN && b.isCN) return Number(a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sourceOrder ?? Number.MAX_SAFE_INTEGER);
    if (!a.isCN && !b.isCN) return Number(b.viewers || 0) - Number(a.viewers || 0);
    return a.isCN ? -1 : 1;
  });
  Object.defineProperty(sorted, 'failedSourceKeys', { value: failedSourceKeys, enumerable: false });
  return sorted;
}

const { refreshMediaLive, refreshMediaCache, getMediaCache } = createMediaScheduler({
    mediaCache, mediaSources, mediaVideoState, mediaVideoPaused, mediaVideoPauseUntil,
    loadPersistentMediaVideos, loadPersistentMediaVideoState, savePersistentMediaVideoState,
    loadPersistentMediaLive, fetchMediaVideoSource, fetchMediaLive, isBilibiliRateLimit,
    mediaVideoRequestGapMin, mediaVideoRequestGapMax, mediaVideoCircuitMaxDelay, mediaVideoCircuitBaseDelay,
    mediaLiveRoundTimeout, mediaLiveFailedSourceGrace, mediaLiveRefreshInterval, withMediaTimeout,
    dataDir, mediaVideoCachePath, mediaLiveCachePath, realtimeChat
});

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

async function loadTournamentEloTop32Cache() {
  if (tournamentEloTop32Cache) return tournamentEloTop32Cache;
  if (!tournamentEloTop32CacheLoadPromise) tournamentEloTop32CacheLoadPromise = (async () => {
    try {
      const cached = JSON.parse(await readFile(tournamentEloTop32CachePath, 'utf8'));
      if (cached?.fetchedAt && Array.isArray(cached.players)) tournamentEloTop32Cache = cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[events] tournament Elo top-32 cache unavailable:', error.message);
    }
    return tournamentEloTop32Cache;
  })();
  return tournamentEloTop32CacheLoadPromise;
}

function refreshTournamentEloTop32Cache() {
  if (tournamentEloTop32RefreshPromise) return tournamentEloTop32RefreshPromise;
  tournamentEloTop32RefreshPromise = (async () => {
    const board = await fetchTournamentEloLeaderboard(1, 1);
    const players = (board.rows || [])
      .filter(row => Number(row.rank) > 0 && Number(row.rank) <= 32 && String(row.name || '').trim())
      .map(row => ({ profileId: String(row.profileId || ''), name: String(row.name).trim(), rank: Number(row.rank) }));
    if (!players.length) throw new Error('赛事积分榜单没有有效的前32名数据');
    const next = { fetchedAt: new Date().toISOString(), players };
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${tournamentEloTop32CachePath}.tmp`, JSON.stringify(next, null, 2), 'utf8');
    await rename(`${tournamentEloTop32CachePath}.tmp`, tournamentEloTop32CachePath);
    tournamentEloTop32Cache = next;
    console.log(`[events] tournament Elo top-32 cache refreshed: ${players.length} players`);
    return next;
  })().catch(error => {
    tournamentEloTop32RetryAfter = Date.now() + 60 * 60_000;
    throw error;
  }).finally(() => { tournamentEloTop32RefreshPromise = null; });
  return tournamentEloTop32RefreshPromise;
}

async function getTournamentEloTop32Cache() {
  const cached = await loadTournamentEloTop32Cache();
  const fetchedAt = Date.parse(cached?.fetchedAt || 0);
  if ((!cached || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= tournamentEloTop32RefreshInterval) && Date.now() >= tournamentEloTop32RetryAfter) {
    refreshTournamentEloTop32Cache().catch(error => console.warn('[events] tournament Elo top-32 refresh failed:', error.message));
  }
  return cached;
}

async function addTournamentEloTop32Qualification(data) {
  const cache = await getTournamentEloTop32Cache();
  const names = new Set((cache?.players || []).map(player => normalizeEventPlayerName(player.name)).filter(Boolean));
  const mark = match => {
    const hasTop32Player = (match.opponents || []).some(opponent => {
      const namesOnSide = [...(Array.isArray(opponent.members) ? opponent.members : []), opponent.name];
      return namesOnSide.some(name => names.has(normalizeEventPlayerName(name)));
    });
    return { ...match, hasTournamentEloTop32Player: hasTop32Player };
  };
  const qualified = {
    ...data,
    tournamentEloTop32UpdatedAt: cache?.fetchedAt || null,
    upcoming: (data.upcoming || []).map(mark),
    completed: (data.completed || []).map(mark)
  };
  queueMissingLiquipediaMatchTiers(qualified).catch(error => console.warn('[events] match tier metadata queue failed:', error.message));
  return qualified;
}

function scheduleDailyTournamentEloTop32Refresh() {
  const now = Date.now();
  const chinaNow = new Date(now + 8 * 60 * 60_000);
  let target = Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate(), 4, 30) - 8 * 60 * 60_000;
  if (target <= now) target += 24 * 60 * 60_000;
  const timer = setTimeout(async () => {
    try { await refreshTournamentEloTop32Cache(); }
    catch (error) { console.warn('[events] daily tournament Elo top-32 refresh failed:', error.message); }
    scheduleDailyTournamentEloTop32Refresh();
  }, Math.max(1_000, target - now));
  timer.unref?.();
  void getTournamentEloTop32Cache();
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

async function withCachedLeaderboardAvatars(data) {
  await avatarCache.ready;
  const rows = await Promise.all((data.rows || []).map(async row => {
    const steamId = String(row.steamId || '');
    const profileId = String(row.profileId || '');
    const key = /^\d{17}$/.test(steamId) ? `steam:${steamId}` : /^\d+$/.test(profileId) ? `profile:${profileId}` : '';
    const entry = key ? await avatarCache.peek(key) : null;
    return { ...row, avatar:entry ? `/api/avatar-image/${entry.hash}.${entry.type.split('/')[1]}` : '' };
  }));
  return { ...data, rows };
}

async function getLeaderboard(id) {
  let cached = leaderboardCache.get(id);
  if (!cached) {
    await refreshLeaderboard(id);
    cached = leaderboardCache.get(id);
  }
  const now = Date.now();
  return withCachedLeaderboardAvatars({ ...cached.data, cacheExpiresAt: cached.expiresAt > now ? cached.expiresAt : nextLeaderboardRefreshAt(id, now) });
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
  return withCachedLeaderboardAvatars({ ...cached.data, cacheExpiresAt: cached.expiresAt > now ? cached.expiresAt : nextLeaderboardRefreshAt(id, now), requestedPage });
}

async function prewarmLeaderboardAvatars() {
  if (leaderboardAvatarWarmup.running) return;
  leaderboardAvatarWarmup.running = true;
  leaderboardAvatarWarmup.lastStartedAt = new Date().toISOString();
  leaderboardAvatarWarmup.error = null;
  try {
    await Promise.all([getLeaderboard(3), getLeaderboard(4)]);
    const keys = [];
    for (const id of [3,4]) for (const row of leaderboardCache.get(id)?.data?.rows || []) {
      const steamId = String(row.steamId || ''), profileId = String(row.profileId || '');
      if (/^\d{17}$/.test(steamId)) keys.push(`steam:${steamId}`);
      else if (/^\d+$/.test(profileId)) keys.push(`profile:${profileId}`);
    }
    leaderboardAvatarWarmup.result = await avatarCache.prewarm(keys, 1000, 8);
    leaderboardAvatarWarmup.lastCompletedAt = new Date().toISOString();
    console.log('[avatars] daily leaderboard warmup complete:', leaderboardAvatarWarmup.result);
  } catch (error) {
    leaderboardAvatarWarmup.error = error.message;
    console.warn('[avatars] daily leaderboard warmup failed:', error.message);
  } finally { leaderboardAvatarWarmup.running = false; }
}

function scheduleDailyLeaderboardAvatarWarmup() {
  const now = Date.now(), chinaNow = new Date(now + 8 * 60 * 60_000);
  const targetChina = Date.UTC(chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate(), 4, 15);
  let target = targetChina - 8 * 60 * 60_000;
  if (target <= now) target += 24 * 60 * 60_000;
  const timer = setTimeout(() => {
    void prewarmLeaderboardAvatars();
    scheduleDailyLeaderboardAvatarWarmup();
  }, target - now);
  timer.unref();
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
scheduleDailyLeaderboardAvatarWarmup();
setTimeout(() => { void prewarmLeaderboardAvatars(); }, 15_000).unref();
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
    profileRefreshState.stage = '建立两字符昵称索引';
    db.exec("CREATE TABLE profile_bigram(term TEXT NOT NULL, profile_rowid INTEGER NOT NULL, PRIMARY KEY(term, profile_rowid)) WITHOUT ROWID; WITH RECURSIVE grams(profile_rowid, normalized, position, last_position) AS (SELECT rowid, lower(substr(name,1,80)), 1, length(substr(name,1,80))-1 FROM profiles WHERE length(name)>=2 UNION ALL SELECT profile_rowid, normalized, position+1, last_position FROM grams WHERE position<last_position) INSERT OR IGNORE INTO profile_bigram(term,profile_rowid) SELECT substr(normalized,position,2),profile_rowid FROM grams;");
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
    matches: Array.isArray(profile.matches) ? profile.matches.slice(0, 20) : [],
    hours: Array.isArray(profile.hours) || (profile.hours && typeof profile.hours === 'object') ? profile.hours : null,
    opps: Array.isArray(profile.opps) || (profile.opps && typeof profile.opps === 'object') ? profile.opps : null,
    teaming: Array.isArray(profile.teaming) || (profile.teaming && typeof profile.teaming === 'object') ? profile.teaming : null
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

const loadVerifiedPlayerProfiles = createVerifiedRealtimeNames({readFile,cacheDir:aoe2RecsProfileCacheDir});
const playerTeams = createPlayerTeams({
  readFile,writeFile,rename,cachePath:join(dataDir,'player-teams.json'),
  loadProfile:async id=>{
    const cached = await readAoE2RecsProfileCache(id);
    if (cached?.profile && Date.now() - Number(cached.savedAt || 0) < aoe2RecsProfileCacheTtl) {
      return { ...cached.profile, cacheSavedAt: cached.savedAt };
    }
    return refreshAoE2RecsProfile(id);
  },
  onChange:()=>realtimeService.refreshEnrichment()
});
const cnzsRosterPath = join(dataDir, 'liquipedia-cnzs-roster.json');
const teamRosterPath = join(dataDir, 'liquipedia-team-rosters.json');
const fetchLiquipediaTeamData = (params, priority = 3) => queueLiquipediaParse(async () => {
  const url = new URL(liquipediaApiUrl);
  url.search = new URLSearchParams({ ...params, format: 'json', formatversion: '2' });
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': liquipediaUserAgent },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw Error(data.error.code || 'Liquipedia API error');
  return data;
}, priority);
const teamRosterSync = createTeamRosterSync({
  read: () => readFile(teamRosterPath, 'utf8'),
  save: async text => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(teamRosterPath + '.tmp', text, 'utf8');
    await rename(teamRosterPath + '.tmp', teamRosterPath);
  },
  fetchDirectory: async () => (await fetchLiquipediaTeamData({
    action: 'parse', page: 'Portal:Teams', section: '1', prop: 'text'
  })).parse?.text,
  fetchTeamPages: async titles => {
    const sources = new Map();
    for (let i = 0; i < titles.length; i += 45) {
      const data = await fetchLiquipediaTeamData({
        action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1',
        titles: titles.slice(i, i + 45).join('|')
      });
      if (!Array.isArray(data.query?.pages)) throw Error('Missing team pages');
      const aliases = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])].map(({from,to}) => [from,to]));
      const pages = new Map(data.query.pages.map(page => [page.title, page.revisions?.[0]?.slots?.main?.content]));
      for (const title of titles.slice(i, i + 45)) {
        const normalized = aliases.get(title) || title;
        sources.set(title, pages.get(aliases.get(normalized) || normalized));
      }
    }
    return sources;
  },
  references: loadRlReference,
  onChange: () => realtimeService.refreshEnrichment()
});
const cnzsRoster = createCnzsRoster({
  read: () => readFile(cnzsRosterPath, 'utf8'),
  save: async text => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(cnzsRosterPath + '.tmp', text, 'utf8');
    await rename(cnzsRosterPath + '.tmp', cnzsRosterPath);
  },
  fetchHtml: () => queueLiquipediaParse(async () => {
    const url = new URL(liquipediaApiUrl);
    url.search = new URLSearchParams({ action: 'parse', page: 'CN_ZhongSheng', section: '2', prop: 'text', format: 'json', formatversion: '2' });
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': liquipediaUserAgent },
      signal: AbortSignal.timeout(25_000)
    });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.parse?.title !== 'CN ZhongSheng' || typeof payload.parse.text !== 'string') throw Error('Missing CNZS roster');
    return payload.parse.text;
  }, 2),
  onChange: () => realtimeService.refreshEnrichment()
});

async function loadPlayerTeams(ids, verifiedProfiles) {
  const references=await loadRlReference();
  const canonicalIds=ids.map(id=>references.get(String(id))?.canonicalProfileId).filter(Boolean);
  const verified=verifiedProfiles || await loadVerifiedPlayerProfiles([...ids,...canonicalIds]);
  const teams = await playerTeams.getTeams(ids,verified,references);
  await teamRosterSync.apply(teams, references, verified);
  return applyCnzsRoster(teams, references, verified, await cnzsRoster.get());
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
  // Keep the lobby implementation available, but do not expose or fetch it.
  lobbyStatsEnabled: false,
  WebSocket
});
const { localProfileDetails, fetchPersonalLeaderboardStats } = profileService;
const readProfileAccounts = createProfileAccountsReader({readCached:readAoE2RecsProfileCache,refresh:refreshAoE2RecsProfile,localProfileDetails,loadReferences:loadRlReference});

const matchesService = createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches });
const { fetchWorldsEdgeMatchesOnce, fetchLatestWorldsEdgeMatchOnce } = matchesService;
// Visible profile refreshes get queue priority and one bounded attempt; the
// realtime monitor retains its existing retry policy through matchesService.
const profileMatchesService = createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches, attempts:1, requestTimeoutMs:10_000, priority:5 });
const { fetchWorldsEdgeMatchesOnce:fetchProfileMatchesOnce, fetchLatestWorldsEdgeMatchOnce:fetchLatestProfileMatchOnce,
  fetchWorldsEdgeMatchByIdOnce:fetchProfileMatchByIdOnce } = profileMatchesService;

const realtimeService = createRealtimeService({
  loadVerifiedRealtimeNames: loadVerifiedPlayerProfiles,
  loadPlayerTeams,
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
        current = { savedAt: Number(disk.savedAt), matches: disk.matches, pages: Number(disk.pages) || 1, hasMore: disk.hasMore !== false,
          hasOlderUnfinished: typeof disk.hasOlderUnfinished === 'boolean' ? disk.hasOlderUnfinished : hasOlderUnfinishedMatches(disk.matches),
          unfinishedRepairs:disk.unfinishedRepairs && typeof disk.unfinishedRepairs === 'object' ? disk.unfinishedRepairs : {} };
        worldsEdgeMatchCache.set(key, current);
      }
    } catch {
      current = null;
    }
  }
  return current;
}

const unfinishedRepairDelays = [10 * 60_000, 60 * 60_000, 6 * 60 * 60_000];
const unfinishedRepairLifetime = 7 * 24 * 60 * 60_000;
async function repairOlderUnfinishedMatches(profileId, snapshot) {
  const key = String(profileId);
  if (!snapshot?.hasOlderUnfinished || worldsEdgeMatchRepairRefreshes.has(key)) return worldsEdgeMatchRepairRefreshes.get(key);
  const task = (async () => {
    const now = Date.now(), latestId = String(snapshot.matches?.[0]?.id || '');
    const repairs = { ...(snapshot.unfinishedRepairs || {}) };
    let metadataChanged = false;
    const due = [];
    for (const match of (snapshot.matches || []).slice(1)) {
      if (!Number(match?.started) || Number(match.finished) || match.abandoned === true) continue;
      const id = String(match.id || '');
      if (!/^[1-9]\d{0,15}$/.test(id)) continue;
      let state = repairs[id] && typeof repairs[id] === 'object' ? { ...repairs[id] } : {};
      if (state.latestId !== latestId) {
        state = state.stopped ? { latestId, attempts:0, firstAttemptAt:0, nextAttemptAt:0 } : { ...state, latestId, nextAttemptAt:0 };
        repairs[id] = state; metadataChanged = true;
      }
      if (state.firstAttemptAt && now - Number(state.firstAttemptAt) >= unfinishedRepairLifetime) {
        if (!state.stopped) { repairs[id] = { ...state, stopped:true, stoppedAt:now }; metadataChanged = true; }
        continue;
      }
      if (!state.stopped && now >= Number(state.nextAttemptAt || 0)) due.push({ id, state });
      if (due.length >= 5) break;
    }
    const replacements = new Map();
    let cursor = 0;
    async function worker() {
      while (cursor < due.length) {
        const { id, state } = due[cursor++];
        try {
          const fresh = await fetchProfileMatchByIdOnce(id);
          if (fresh && (Number(fresh.finished) > 0 || fresh.abandoned === true)) {
            replacements.set(id, fresh);
            delete repairs[id];
            metadataChanged = true;
            continue;
          }
        } catch (error) {
          console.warn(`[matches] unfinished repair ${id} failed:`, error.message);
        }
        const attempts = Number(state.attempts || 0) + 1;
        const firstAttemptAt = Number(state.firstAttemptAt || 0) || now;
        const expired = now - firstAttemptAt >= unfinishedRepairLifetime;
        const delay = unfinishedRepairDelays[Math.min(attempts - 1, unfinishedRepairDelays.length - 1)] || 24 * 60 * 60_000;
        repairs[id] = { latestId, attempts, firstAttemptAt, nextAttemptAt:expired ? 0 : now + (attempts >= 4 ? 24 * 60 * 60_000 : delay),
          ...(expired ? { stopped:true, stoppedAt:now } : {}) };
        metadataChanged = true;
      }
    }
    await Promise.all([worker(), worker()]);
    if (!metadataChanged && !replacements.size) return;
    const latest = worldsEdgeMatchCache.get(key) || snapshot;
    const matches = (latest.matches || []).map(match => replacements.get(String(match.id)) || match);
    const updated = { ...latest, matches, unfinishedRepairs:repairs, hasOlderUnfinished:hasOlderUnfinishedMatches(matches) };
    worldsEdgeMatchCache.set(key, updated);
    await mkdir(worldsEdgeMatchCacheDir, { recursive:true });
    const path = worldsEdgeMatchCachePath(key), tempPath = `${path}.tmp`;
    await writeFile(tempPath, JSON.stringify(updated), 'utf8');
    await rename(tempPath, path);
  })().finally(() => worldsEdgeMatchRepairRefreshes.delete(key));
  worldsEdgeMatchRepairRefreshes.set(key, task);
  return task;
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
  const path = aoe2RecsProfilePath(profileId);
  const cached = aoe2RecsProfileCache.get(profileId);
  let diskStat = null;
  if (cached) {
    try {
      diskStat = await stat(path);
      if (Number(cached.fileMtimeMs || 0) >= diskStat.mtimeMs) return cached;
    } catch (error) {
      if (error.code === 'ENOENT') return cached;
      throw error;
    }
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed?.savedAt && Array.isArray(parsed.profile?.accounts)) {
      diskStat ||= await stat(path);
      parsed.fileMtimeMs = diskStat.mtimeMs;
      aoe2RecsProfileCache.set(profileId, parsed);
      return parsed;
    }
  } catch {}
  return null;
}

function indexAoE2RecsProfile(profileId, profile) {
  if (!profile || profile.notFound) return;
  const playerId = String(profile.player?.id || profileId);
  const values = [];
  const add = (id, name, aliases = [], lastMatchTime = null) => {
    id = String(id || ''); name = String(name || '').trim();
    if (!/^\d+$/.test(id) || !name) return;
    values.push({ profileId:id, canonicalProfileId:playerId, name,
      lastMatchTime, aliases:[...new Set((aliases || []).map(value => String(value || '').trim()).filter(Boolean))] });
  };
  const primaryAccountMatch = (profile.accounts || []).find(account => String(account.id || '') === playerId)?.last;
  add(playerId, profile.player?.name || '', [], profile.player?.last_match || primaryAccountMatch);
  for (const account of profile.accounts || []) add(account.id, account.name || '', account.akas || [], account.last);
  aoe2RecsSearchEntries.set(String(profileId), values);
}

async function ensureAoE2RecsSearchIndex() {
  if (aoe2RecsSearchLoaded) return;
  if (!aoe2RecsSearchLoading) aoe2RecsSearchLoading = (async () => {
    let files = [];
    try { files = await readdir(aoe2RecsProfileCacheDir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const profileFiles = files.filter(file => /^\d+\.json$/.test(file));
    for (const file of profileFiles) {
      try {
        const profileId = file.slice(0, -5);
        const parsed = JSON.parse(await readFile(join(aoe2RecsProfileCacheDir, file), 'utf8'));
        indexAoE2RecsProfile(profileId, parsed?.profile);
      } catch {}
    }
    aoe2RecsSearchLoaded = true;
  })().finally(() => { aoe2RecsSearchLoading = null; });
  return aoe2RecsSearchLoading;
}

function aoe2RecsProfileInsights(profileId, profile) {
  const directHours = Array.isArray(profile?.hours) ? profile.hours : [];
  const directTeaming = Array.isArray(profile?.teaming) ? profile.teaming : [];
  const directOpps = Array.isArray(profile?.opps) ? profile.opps : [];
  if (!directHours.length && !directTeaming.length && !directOpps.length) return null;
  const activityHours = Array(24).fill(0);
  for (const item of directHours) {
    const utcHour = Number(item?.x), value = Number(item?.y);
    if (Number.isInteger(utcHour) && utcHour >= 0 && utcHour < 24 && Number.isFinite(value)) activityHours[(utcHour + 8) % 24] = value;
  }
  const directPeople = values => (Array.isArray(values) ? values : []).map(item => ({
    id:String(item?.id || ''), name:String(item?.name || '').trim() || `玩家 ${item?.id || ''}`, count:Number(item?.value) || 0
  })).filter(item => item.count > 0).sort((a,b) => b.count-a.count || a.name.localeCompare(b.name,'zh-CN')).slice(0,5);
  const directTeammates = directPeople(directTeaming), directOpponents = directPeople(directOpps);
  const peakHours = activityHours.map((count,hour)=>({hour,count})).filter(item=>item.count>0).sort((a,b)=>b.count-a.count || a.hour-b.hour).slice(0,3).map(item=>item.hour);
  return { source:'aoe2recs-summary', timezone:'Asia/Shanghai', activityHours, peakHours,
    teammates:directTeammates, opponents:directOpponents };
}

async function writeAoE2RecsProfileCache(profileId, profile) {
  const cached = { savedAt: Date.now(), profile };
  await mkdir(aoe2RecsProfileCacheDir, { recursive: true });
  const tempPath = `${aoe2RecsProfilePath(profileId)}.tmp`;
  await writeFile(tempPath, JSON.stringify(cached), 'utf8');
  const path = aoe2RecsProfilePath(profileId);
  await rename(tempPath, path);
  const fileMtimeMs = (await stat(path)).mtimeMs;
  aoe2RecsProfileCache.set(profileId, { ...cached, fileMtimeMs });
  indexAoE2RecsProfile(profileId, profile);
  return cached;
}

async function fetchAoE2RecsProfileTransport(profileId) {
  let raw;
  try {
    raw = await aoe2RecsBrowser.read(profileId);
    aoe2RecsVerificationNotified = false;
  } catch (error) {
    if (error?.code === 'AOE2RECS_VERIFICATION_REQUIRED' && !aoe2RecsVerificationNotified) {
      aoe2RecsVerificationNotified = true;
      try {
        realtimeChat.announceSystem({
          content:'AoE2Recs 真实浏览器需要人工验证，账号与曾用名等资料将暂时使用已有缓存。',
          key:'aoe2recs-verification-required',
          repeatMs:15 * 60_000
        });
      } catch (noticeError) {
        console.warn('[realtime-chat] AoE2Recs verification notice failed:', noticeError.message);
      }
    }
    throw error;
  }
  const data = raw?.person && typeof raw.person === 'object' ? raw.person : raw;
  if (data?.found === false) return { notFound:true, accounts:[], player:null, avatar:'', matches:[] };
  const profile = sanitizeAoE2RecsProfile(raw);
  if (!profile) throw Object.assign(new Error('AoE2Recs 未提供该账号的有效资料'), { code:'AOE2RECS_PROFILE_UNAVAILABLE' });
  return profile;
}

async function refreshAoE2RecsProfile(profileId) {
  if (aoe2RecsProfileRefreshes.has(profileId)) return aoe2RecsProfileRefreshes.get(profileId);
  const refresh = (async () => {
    const profile = await fetchAoE2RecsProfileOnce(profileId);
    return (await writeAoE2RecsProfileCache(profileId, profile)).profile;
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
async function searchProfiles(query, _leaderboardId, signal) {
  const normalized = query.trim();
  const queryLower = normalized.toLocaleLowerCase();
  const ratings = new Map();
  const oneVsOneRatings = new Map();
  // Player search is identity-oriented and must rank consistently regardless
  // of which leaderboard happens to be open in the UI.  Always use RM 1v1.
  const cached = leaderboardCache.get(3);
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
    if (profileId && Number.isFinite(rating)) oneVsOneRatings.set(profileId, rating);
  }
  const matchingProfiles = await profileSearchPool.query(join(dataDir, profileCache.filename), normalized, { signal });
  const candidates = new Map(matchingProfiles.map(player => [String(player.profileId), { ...player, aliases: [] }]));
  const profileById = profileDb.prepare('SELECT profile_id AS profileId, steam_id AS steamId, name, clan, country, last_match_time AS lastMatchTime FROM profiles WHERE profile_id = ?');
  await ensureAoE2RecsSearchIndex();
  for (const entries of aoe2RecsSearchEntries.values()) for (const entry of entries) {
    const names = [entry.name, ...entry.aliases];
    if (!names.some(value => value.toLocaleLowerCase().includes(queryLower))) continue;
    const id = entry.profileId;
    const player = candidates.get(id) || profileById.get(id) || localProfileDetails(id)?.player;
    if (!player) continue;
    const existingAliases = new Set(candidates.get(id)?.aliases || []);
    for (const value of names) if (value.toLocaleLowerCase() !== String(player.name || entry.name).toLocaleLowerCase()) existingAliases.add(value);
    candidates.set(id, { ...player, profileId:id, name:player.name || entry.name,
      lastMatchTime:entry.lastMatchTime || player.lastMatchTime || '', aliases:[...existingAliases] });
  }
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
  for (const [id, reference] of await loadRlReference()) {
    const alias = reference.name;
    if (id !== reference.canonicalProfileId || !alias.toLocaleLowerCase().includes(queryLower)) continue;
    const player = candidates.get(id) || profileById.get(id);
    if (!player) continue;
    const aliases = new Set(player.aliases || []);
    if (alias.toLocaleLowerCase() !== player.name.toLocaleLowerCase()) aliases.add(alias);
    candidates.set(id, { ...player, aliases: [...aliases] });
  }
  const results = [...candidates.values()].map(player => {
    const name = player.name.toLocaleLowerCase();
    const searchNameVariants = value => {
      const raw = String(value || '').trim().toLocaleLowerCase();
      const withoutTeamPrefix = raw.replace(/^(?:[_\[]?[a-z0-9]{2,12}[\]_.\s-]+)+/i, '');
      return withoutTeamPrefix && withoutTeamPrefix !== raw ? [raw, withoutTeamPrefix] : [raw];
    };
    const matchingNames = [player.name, ...(player.aliases || [])].flatMap(searchNameVariants);
    const positions = matchingNames.map(value => value.indexOf(queryLower)).filter(value => value >= 0);
    const position = positions.length ? Math.min(...positions) : 0;
    const exact = matchingNames.some(value => value === queryLower);
    const startsWith = position === 0;
    return {
      ...player,
      country: forceChinaCountry(player.profileId, player.country || ''),
      rating: oneVsOneRatings.get(String(player.profileId)) ?? ratings.get(String(player.profileId)) ?? null,
      matchQuality: exact ? 3 : startsWith ? 2 : position >= 0 ? 1 : 0,
      matchPosition: Math.max(0, position),
      matchLengthDifference: Math.min(...matchingNames.map(value => Math.abs([...value].length - [...normalized].length))),
      lastMatchTimestamp: profileLastMatchTimestamp(player.lastMatchTime)
    };
  });
  const activeCutoff = Date.now() - 30 * 86_400_000;
  const activeSearchProfile = player => player.rating != null || player.lastMatchTimestamp >= activeCutoff;
  results.sort((a, b) => Number(activeSearchProfile(b)) - Number(activeSearchProfile(a))
    || b.matchQuality - a.matchQuality
    || (b.rating ?? -1) - (a.rating ?? -1)
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
let liquipediaTournamentsCacheLoadPromise = null;
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

async function startGuessEligibilityScan() {
  const catalogPath = join(dataDir, 'guess-eligibility-catalog.json');
  const progressPath = join(dataDir, 'guess-eligibility-progress.json');
  let input;
  try { input = JSON.parse(await readFile(catalogPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const { scanGuessEligibility } = await import('./server/services/liquipedia-guess-eligibility.js');
  await scanGuessEligibility({
    ...input,
    readProgress: async () => {
      try { return JSON.parse(await readFile(progressPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
    },
    saveProgress: async progress => {
      await writeFile(progressPath + '.tmp', JSON.stringify(progress, null, 2), 'utf8');
      await rename(progressPath + '.tmp', progressPath);
    },
    fetchPages: titles => queueLiquipediaParse(async () => {
      const text = titles.map((title, index) => '<div id="guess-eligibility-' + index + '">\n{{:' + title + '}}\n</div>').join('\n');
      const body = new URLSearchParams({ action: 'parse', text, title: 'AOE2CN eligibility scan', prop: 'text', format: 'json', formatversion: '2' });
      const response = await fetch(liquipediaApiUrl, {
        method: 'POST', body, headers: { 'user-agent': liquipediaUserAgent, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(35_000)
      });
      if (!response.ok) throw Error('Liquipedia HTTP ' + response.status);
      const payload = await response.json();
      const html = payload.parse?.text;
      if (typeof html !== 'string') throw Error(payload.error?.code || 'missing placement tables');
      const markers = [...html.matchAll(/<div id="guess-eligibility-(\d+)">/g)];
      return new Map(markers.map((marker, index) => [
        titles[Number(marker[1])], html.slice(marker.index + marker[0].length, markers[index + 1]?.index)
      ]));
    }, 3)
  });
  console.log('[guess-eligibility] catalog scan complete');
}

function runGuessEligibilityScan() {
  startGuessEligibilityScan().catch(error => {
    console.warn('[guess-eligibility] retry in 10 minutes:', error.message);
    setTimeout(runGuessEligibilityScan, 10 * 60_000).unref();
  });
}

async function runGuessResultsBackfill() {
  const manifestPath = join(dataDir, 'guess-results-backfill-input.json');
  let titles;
  try { titles = JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const { backfillGuessResults } = await import('./server/services/liquipedia-guess-results.js');
  await backfillGuessResults({
    titles,
    progressPath: join(dataDir, 'guess-results-backfill-progress.json'),
    fetchHtml: text => queueLiquipediaParse(async () => {
      const body = new URLSearchParams({
        action: 'parse', text, title: 'Sitaux/Results', prop: 'text', format: 'json', formatversion: '2'
      });
      const response = await fetch(liquipediaApiUrl, {
        method: 'POST', body, headers: { 'user-agent': liquipediaUserAgent, 'accept-encoding': 'gzip' },
        signal: AbortSignal.timeout(45_000)
      });
      if (!response.ok) throw Error('Liquipedia HTTP ' + response.status);
      const data = await response.json();
      if (typeof data.parse?.text !== 'string') throw Error(data.error?.code || 'missing results HTML');
      return data.parse.text;
    }, 4)
  });
}

async function collectGuessTournamentSources() {
  const path = join(dataDir, 'guess-sa-tournament-sources.json');
  const results = await loadLiquipediaResultsCache();
  const events = new Map();
  for (const tier of ['s', 'a']) for (const row of results.categories[tier]?.rows || []) {
    if (!row.url) continue;
    const url = new URL(row.url);
    if (url.hostname !== 'liquipedia.net' || !url.pathname.startsWith('/ageofempires/')) continue;
    const title = decodeURIComponent(url.pathname.slice('/ageofempires/'.length)).replaceAll('_', ' ');
    if (title) events.set(title, { tier: tier.toUpperCase(), title, url: url.href, dates: row.dates });
  }
  if (!events.size) throw Error('no S/A tournament index');
  let saved = {};
  try { saved = JSON.parse(await readFile(path, 'utf8')).sources || {}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = [...events.values()].filter(event => !Object.hasOwn(saved, event.title));
  for (let i = 0; i < pending.length; i += 25) {
    const batch = pending.slice(i, i + 25);
    const data = await fetchLiquipediaTeamData({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1',
      titles: batch.map(event => event.title).join('|')
    }, 1);
    if (!Array.isArray(data.query?.pages)) throw Error('missing S/A event pages');
    const aliases = new Map([...(data.query.normalized || []), ...(data.query.redirects || [])].map(({from,to}) => [from,to]));
    const pages = new Map(data.query.pages.map(page => [page.title, page.revisions?.[0]?.slots?.main?.content]));
    for (const event of batch) {
      const title = aliases.get(event.title) || event.title;
      saved[event.title] = { ...event, source: pages.get(aliases.get(title) || title) || null };
    }
    await writeFile(path + '.tmp', JSON.stringify({ total: events.size, fetched: Object.keys(saved).length, sources: saved }), 'utf8');
    await rename(path + '.tmp', path);
    console.log('[guess-eligibility] tournament sources:', Object.keys(saved).length, '/', events.size);
  }
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

async function loadLiquipediaTournamentsCache() {
  if (liquipediaTournamentsCache) return liquipediaTournamentsCache;
  if (!liquipediaTournamentsCacheLoadPromise) liquipediaTournamentsCacheLoadPromise = (async () => {
    try {
      const cached = JSON.parse(await readFile(liquipediaTournamentsCachePath, 'utf8'));
      if (cached?.fetchedAt && Array.isArray(cached.tournaments)) liquipediaTournamentsCache = cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[events] tournament cache unavailable:', error.message);
    }
    return liquipediaTournamentsCache;
  })();
  return liquipediaTournamentsCacheLoadPromise;
}

function refreshLiquipediaTournaments() {
  if (liquipediaTournamentsRefreshPromise) return liquipediaTournamentsRefreshPromise;
  liquipediaTournamentsRefreshPromise = (async () => {
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

async function getLiquipediaTournamentsSnapshot() {
  const cached = await loadLiquipediaTournamentsCache();
  const fetchedAt = Date.parse(cached?.fetchedAt || 0);
  if (!cached || !Number.isFinite(fetchedAt) || Date.now() - fetchedAt >= liquipediaTournamentsRefreshInterval) {
    refreshLiquipediaTournaments().catch(error => console.warn('[events] tournament refresh failed:', error.message));
  }
  return cached;
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
    const fetchedRows=parseTournamentResultsHtml(payload?.parse?.text?.['*'] || '');
    if (!fetchedRows.length) throw new Error(`${configuration.label}赛事页面没有可用的表格`);
    const rows=appendNewTournamentResults(cache.categories[category]?.rows || [],fetchedRows);
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
    ...day,
    views: Math.max(0, Number(day.views) || 0) + 1,
    visitors: [...visitors],
    uniqueVisitors: visitors.size,
    updatedAt: new Date().toISOString()
  };
  await persistSiteTraffic();
  return { ...currentSiteStats(), counted: true };
}

async function guessPlayerStats(req) {
  await ensureSiteTrafficState();
  const date = chinaDayKey();
  const day = siteTrafficState.days[date] || {};
  const players = Array.isArray(day.guessPlayers) ? day.guessPlayers : [];
  if (req.method === 'POST') {
    const ip = requestClientIp(req);
    if (!excludeFromSiteTraffic(ip)) {
      const visitor = createHash('sha256').update(`aoe2cn-guess-player-v1:${ip}`).digest('hex');
      if (!players.includes(visitor)) {
        players.push(visitor);
        siteTrafficState.days[date] = { ...day, guessPlayers: players };
        await persistSiteTraffic();
      }
    }
  }
  return { date, players: players.length };
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
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.toUpperCase().match(/^([SAB])(?:[- ]?TIER)?$/);
  if (match) return match[1];
  if (/^showm(?:atch)?\.?$/i.test(raw)) return 'Showmatch';
  return raw;
}

function liquipediaMatchTierPage(match) {
  try {
    const url = new URL(match?.tournament?.url || '');
    if (url.hostname !== 'liquipedia.net') return '';
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/ageofempires/')) return '';
    return pathname.slice('/ageofempires/'.length).replace(/\/+$/, '');
  } catch { return ''; }
}

async function loadLiquipediaMatchTiersCache() {
  if (liquipediaMatchTiersCache) return liquipediaMatchTiersCache;
  if (!liquipediaMatchTiersCacheLoadPromise) liquipediaMatchTiersCacheLoadPromise = (async () => {
    try {
      const cached = JSON.parse(await readFile(liquipediaMatchTiersCachePath, 'utf8'));
      if (cached?.version === 1 && cached.pages && typeof cached.pages === 'object') liquipediaMatchTiersCache = cached;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[events] match tier cache unavailable:', error.message);
    }
    if (!liquipediaMatchTiersCache) liquipediaMatchTiersCache = { version: 1, pages: {} };
    return liquipediaMatchTiersCache;
  })();
  return liquipediaMatchTiersCacheLoadPromise;
}

function parseLiquipediaMatchTier(wikitext) {
  const field = name => String(wikitext || '').match(new RegExp(`^\\s*\\|\\s*${name}\\s*=\\s*([^\\r\\n|]+)`, 'im'))?.[1]?.trim() || '';
  const tier = normalizedTournamentTier(field('liquipediatier'));
  const tierType = field('liquipediatiertype');
  return { tier, tierType };
}

async function persistLiquipediaMatchTiersCache() {
  const cache = await loadLiquipediaMatchTiersCache();
  await mkdir(dataDir, { recursive: true });
  await writeFile(`${liquipediaMatchTiersCachePath}.tmp`, JSON.stringify(cache, null, 2), 'utf8');
  await rename(`${liquipediaMatchTiersCachePath}.tmp`, liquipediaMatchTiersCachePath);
}

async function runLiquipediaMatchTierQueue() {
  if (liquipediaMatchTierQueueRunning) return;
  liquipediaMatchTierQueueRunning = true;
  try {
    const cache = await loadLiquipediaMatchTiersCache();
    while (liquipediaMatchTierQueue.length) {
      const page = liquipediaMatchTierQueue.shift();
      try {
        const payload = await queueLiquipediaParse(async () => {
          const url = new URL(liquipediaApiUrl);
          url.search = new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json', formatversion: '2' });
          const response = await fetch(url, { headers: { 'user-agent': liquipediaUserAgent }, signal: AbortSignal.timeout(25_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json();
        }, 1);
        cache.pages[page] = { ...parseLiquipediaMatchTier(payload?.parse?.wikitext), fetchedAt: new Date().toISOString() };
        await persistLiquipediaMatchTiersCache();
        console.log(`[events] Liquipedia tier metadata cached for ${page}: ${cache.pages[page].tierType || cache.pages[page].tier || 'unknown'}`);
      } catch (error) {
        cache.pages[page] = { tier: '', tierType: '', fetchedAt: new Date().toISOString(), error: error.message };
        await persistLiquipediaMatchTiersCache().catch(() => {});
        console.warn(`[events] Liquipedia tier metadata failed for ${page}:`, error.message);
      } finally {
        liquipediaMatchTierQueued.delete(page);
      }
    }
  } finally {
    liquipediaMatchTierQueueRunning = false;
    if (liquipediaMatchTierQueue.length) void runLiquipediaMatchTierQueue();
  }
}

async function queueMissingLiquipediaMatchTiers(data) {
  const cache = await loadLiquipediaMatchTiersCache();
  const pages = new Set();
  for (const match of data.upcoming || []) {
    if (!qualifiesForSchedule(match) || match.tournament?.tier) continue;
    const page = liquipediaMatchTierPage(match);
    if (!page || page.includes(':')) continue;
    const fetchedAt = Date.parse(cache.pages[page]?.fetchedAt || 0);
    if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < 7 * 24 * 60 * 60_000) continue;
    pages.add(page);
  }
  for (const page of pages) {
    if (liquipediaMatchTierQueued.has(page) || liquipediaMatchTierQueue.length >= 24) continue;
    liquipediaMatchTierQueued.add(page);
    liquipediaMatchTierQueue.push(page);
  }
  if (liquipediaMatchTierQueue.length) console.log(`[events] Liquipedia tier metadata queued: ${liquipediaMatchTierQueue.length} pages`);
  if (liquipediaMatchTierQueue.length) void runLiquipediaMatchTierQueue();
}

const tournamentRoundCache = new Map();
async function addMatchRounds(parsed) {
  const groups = new Map();
  for (const match of parsed.upcoming || []) {
    if (!match.tournament?.tier) continue;
    try {
      const url = new URL(match.tournament.url);
      const page = decodeURIComponent(url.pathname.replace(/^\/ageofempires\//, ''));
      if (url.hostname !== 'liquipedia.net' || !page || page.includes(':')) continue;
      if (!groups.has(page)) groups.set(page, []);
      groups.get(page).push(match);
    } catch {}
  }
  for (const [page, matches] of [...groups].slice(0, 8)) {
    try {
      let cached = tournamentRoundCache.get(page);
      if (!cached || Date.now() - cached.at > 60 * 60_000) {
        const payload = await queueLiquipediaParse(async () => {
          const url = new URL(liquipediaApiUrl);
          url.search = new URLSearchParams({ action:'parse', page, prop:'wikitext', format:'json', formatversion:'2' });
          const response = await fetch(url, { headers:{'user-agent':liquipediaUserAgent}, signal:AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          if (typeof payload.parse?.wikitext !== 'string') throw new Error('missing wikitext');
          return payload;
        }, 0);
        cached = { at:Date.now(), rows:parseTournamentRounds(payload.parse.wikitext) };
        tournamentRoundCache.set(page, cached);
        if (tournamentRoundCache.size > 64) tournamentRoundCache.delete(tournamentRoundCache.keys().next().value);
      }
      for (const match of matches) {
        const row = findTournamentRound(match, cached.rows);
        if (row) { match.tournament.round = row.round; match.bestOf ||= row.bestOf; }
      }
    } catch (error) { console.warn(`[events] bracket round unavailable for ${page}: ${error.message}`); }
  }
  return parsed;
}
async function addMatchTiers(parsed, includeRounds = true) {
  let tournaments = [];
  try { tournaments = (await getLiquipediaTournamentsSnapshot())?.tournaments || []; } catch {}
  const tierCache = await loadLiquipediaMatchTiersCache();
  const apply = match => {
    const parent = resolveTournament(match.tournament, tournaments);
    const pageMetadata = tierCache.pages[liquipediaMatchTierPage(match)] || {};
    const tier = normalizedTournamentTier(parent?.tier || pageMetadata.tier || match.tournament?.tier);
    const tierType = String(parent?.tierType || pageMetadata.tierType || match.tournament?.tierType || '').trim();
    return { ...match, tournament: { ...match.tournament, mainName: parent?.name || match.tournament?.mainName || match.tournament?.name || '', tier, ...(tierType ? { tierType } : {}) } };
  };
  const result = { upcoming:parsed.upcoming.map(apply), completed:parsed.completed.map(apply) };
  return includeRounds ? addMatchRounds(result) : result;
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
      liquipediaMatchesCache = { ...cached, ...await addMatchTiers(cached, false) };
      rebuildLiquipediaLivePlayerCache(liquipediaMatchesCache);
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
    if (Number.isFinite(cachedAt) && Date.now() - cachedAt < liquipediaMatchesRefreshInterval) {
      const rounded = await addMatchRounds(liquipediaMatchesCache);
      return addTournamentEloTop32Qualification(await addMatchTiers(rounded, false));
    }
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
    const tiered = await addMatchTiers(parseLiquipediaMatches(html));
    const parsed = await addTournamentEloTop32Qualification(tiered);
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
  const target=Math.min(nextBeijingHour(6),nextBeijingHour(18));
  setTimeout(async()=>{
    try {
      const data=await refreshLiquipediaMatches();
      const start=Date.now(), end=start+24*60*60_000;
      const matches=(data?.upcoming || []).filter(match=>match.timestamp*1000>=start && match.timestamp*1000<end)
        .filter(qualifiesForSchedule).map(match=>({...match,tier:match.tournament?.tier || ''}));
      const scheduled = new Date(target);
      const hour = new Date(target+8*60*60_000).getUTCHours();
      realtimeChat.announceSchedule({day:`${chinaDayKey(scheduled)}:${hour}`,matches});
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

const profileRoutes = createProfileRoutes({
  localProfileDetails, loadRlReference, loadPlayerTeams, readAoE2RecsProfileCache,
  aoe2RecsProfileInsights, readProfileAccounts, fetchLatestProfileMatchOnce,
  readWorldsEdgeMatchesCache, getWorldsEdgeMatches, repairOlderUnfinishedMatches,
  fetchProfileMatchesOnce, worldsEdgeMatchCacheTtl, fetchPersonalLeaderboardStats
});

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
    return sendNoStoreJson(res, 200, { ok: true, uptime: process.uptime(), background: worker, profileBrowser:aoe2RecsBrowser.stats(), leaderboardAvatarWarmup, caches: { avatars: avatarCache.stats(), personalStats: personalStatsCache.stats(), livePlayerStats: livePlayerStatsCache.stats(), profiles: aoe2RecsProfileCache.stats(), matches: worldsEdgeMatchCache.stats() } });
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
  if (url.pathname === '/api/guess/players') {
    if (!['GET', 'POST'].includes(req.method)) return sendNoStoreJson(res, 405, { error: '不支持的请求方法' });
    try {
      return sendNoStoreJson(res, 200, await guessPlayerStats(req));
    } catch {
      return sendNoStoreJson(res, 500, { error: '游玩人数暂不可用' });
    }
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
    const tiered = await addMatchTiers(cached, false);
    const qualified = await addTournamentEloTop32Qualification(tiered);
    const data = { ...qualified, stale: Boolean(liquipediaMatchesLastError) };
    return sendVersionedJson(req, res, data, `events-${cached.fetchedAt}-${qualified.tournamentEloTop32UpdatedAt || 'top32-unavailable'}`, 60);
  }
  if (url.pathname === '/api/tournaments') {
    if (req.method !== 'GET') return sendNoStoreJson(res, 405, { error: '仅支持 GET 请求' });
    const data = await getLiquipediaTournamentsSnapshot();
    if (!data) return sendNoStoreJson(res, 202, { status: 'syncing', error: '赛事列表正在首次同步，请稍后重试' });
    const stale = Date.now() - Date.parse(data.fetchedAt || 0) >= liquipediaTournamentsRefreshInterval;
    return sendVersionedJson(req, res, { ...data, stale }, `tournaments-${data.fetchedAt}`, 60);
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    const cleanupAbort = () => { req.removeListener('aborted', abort); res.removeListener('close', abort); };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const leaderboardId = Number(url.searchParams.get('leaderboardId') || 3);
      const results = await searchProfiles(query, types[leaderboardId] ? leaderboardId : 3, controller.signal);
      cleanupAbort();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ query, results, updatedAt: profileCache?.updatedAt || null }));
    } catch (error) {
      cleanupAbort();
      if (error.name === 'AbortError' || res.destroyed) return;
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '查询玩家资料失败' }));
    }
  }
  const profileRoute = profileRoutes.get(url.pathname);
  if (profileRoute) return profileRoute(url, res);
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
    const headers = { 'content-type': `image/${match[2]}`, 'cache-control': 'public, max-age=1296000', etag, 'x-content-type-options': 'nosniff' };
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': entry.expires > Date.now() ? `private, max-age=${Math.max(0, Math.floor((entry.expires - Date.now()) / 1000))}` : 'no-cache' });
      return res.end(JSON.stringify({ avatar: `/api/avatar-image/${entry.hash}.${entry.type.split('/')[1]}`, expires: entry.expires }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '头像暂不可用' }));
    }
  }

  const relative = url.pathname === '/' || /^\/(?:leaderboard|profile(?:\/\d+)?|media(?:\/videos)?|replay-analysis|updates|realtime|events(?:\/results)?|feedback|civilizations|tech-tree|build-orders(?:\/[a-z0-9-]+)?)\/?$/i.test(url.pathname) ? 'index.html' : url.pathname.slice(1);
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
  scheduleDailyTournamentEloTop32Refresh();
  startLiquipediaMatchesLifecycle().catch(error => console.warn('[events] lifecycle startup failed:', error.message));
  collectGuessTournamentSources().catch(error => console.warn('[guess-eligibility] tournament sources failed:', error.message));
  runGuessResultsBackfill().catch(error => console.warn('[guess-results] backfill paused:', error.message));
  scheduleLiquipediaResultsRefresh().catch(error=>console.warn('[event-results] scheduler startup failed:',error.message));
  refreshMediaCache().catch(error => console.warn('[media] initial refresh failed:', error.message));
  startBilibiliUpdatesLifecycle().catch(error => console.warn('[updates] lifecycle startup failed:', error.message));
  leaderboardDumpSummary.start();
  startProfileCacheLifecycle().catch(error => console.error('启动玩家资料缓存失败:', error.message));
  ensureSiteTrafficState().then(() => scheduleSiteDailyArchive()).catch(error => console.warn('[stats] daily archive startup failed:', error.message));
  playerTeams.start();
  cnzsRoster.start();
  teamRosterSync.start();
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
