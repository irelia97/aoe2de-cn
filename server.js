import http from 'node:http';
import { readFile, open, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { ProxyAgent, WebSocket, setGlobalDispatcher } from 'undici';
import { chromium } from 'playwright';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { mediaSources, mediaVideoWhitelist } from './config/media.js';
import { createRealtimeService } from './server/services/realtime-service.js';
import { createMatchesService } from './server/services/matches-service.js';
import { leaderboardRowsFromPayloads, mergeLeaderboardData } from './server/services/leaderboard-format.js';
const execFileAsync = promisify(execFile);

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, '.cache');
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
const types = { 1: '1v1 死亡竞赛', 2: '团队死亡竞赛', 3: '1v1 随机地图', 4: '团队随机地图', 13: '1v1 帝国战争', 14: '团队帝国战争' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const avatarCache = new Map();
const leaderboardCache = new Map();
const leaderboardRefreshes = new Map();
const personalStatsCache = new Map();
const personalStatsCacheTtl = 10 * 60_000;
const livePlayerStatsCache = new Map();
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
const aoe2InsightsSummaryCache = new Map();
const aoe2InsightsSummaryRefreshes = new Map();
const aoe2InsightsSummaryTtl = 6 * 60 * 60_000;
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
  14: { period: 6 * 60 * 60_000, offset: 4 * 60 * 60_000 }
};
const ladderOrder = Object.keys(leaderboardSchedules).map(Number);
const cacheWaiters = new Map();
const aoe2RecsProfileCache = new Map();
const aoe2RecsProfileRefreshes = new Map();
const gameAssetRefreshes = new Map();
const aoe2RecsProfileCacheTtl = 48 * 60 * 60_000;
const worldsEdgeMatchCacheDir = join(dataDir, 'worldsedge-matches');
const worldsEdgeMatchCacheTtl = 10 * 60_000;
const worldsEdgeMatchCache = new Map();
const worldsEdgeMatchRefreshes = new Map();
let profileDb = null;
let profileCache = null;
let profileRefreshPromise = null;
let profileRefreshTimer = null;
const profileRefreshState = { refreshing: false, stage: '等待启动', downloadedBytes: 0, totalBytes: 0, processedRows: 0, startedAt: null, error: null };
const mediaVideoActiveRefreshMin = 30 * 60_000;
const mediaVideoActiveRefreshMax = 60 * 60_000;
const mediaVideoRequestGapMin = 5 * 60_000;
const mediaVideoRequestGapMax = 5 * 60_000;
const mediaVideoCycleDelay = 3 * 60 * 60_000;
const mediaVideoCircuitBaseDelay = 2 * 60 * 60_000;
const mediaVideoCircuitMaxDelay = 6 * 60 * 60_000;
const mediaLiveRefreshInterval = 2 * 60_000;
const bilibiliCookiePath = join(dataDir, 'bilibili-cookie.txt');
const bilibiliCookie = process.env.BILIBILI_COOKIE || process.env.BILI_COOKIE || (() => {
  try { return readFileSync(bilibiliCookiePath, 'utf8').trim(); } catch { return ''; }
})();
console.log(`[media] bilibili browser cookie loaded: ${bilibiliCookie.length > 0 ? 'yes' : 'no'} (${bilibiliCookie.length} chars)`);
let bilibiliWbiKeys = null;
let bilibiliWbiKeyDay = 0;
let bilibiliWbiKeyPromise = null;
let bilibiliBrowserPromise = null;
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
const bilibiliVideoTagsCache = new Map();
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
let mediaVideoRateLimitStrikes = 0;
const mediaVideoSourceStates = new Map();
const mediaVideoCycleSeen = new Set();
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

function mediaXmlTag(block, tag) {
  const match = String(block || '').match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? mediaText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : '';
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

function hasBilibiliSoftRisk(value, depth = 0) {
  if (depth > 7 || value == null) return false;
  if (typeof value === 'string') return value.includes('v_voucher');
  if (Array.isArray(value)) return value.some(item => hasBilibiliSoftRisk(item, depth + 1));
  if (typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => key.includes('v_voucher') || hasBilibiliSoftRisk(item, depth + 1));
}

const wbiMixinKeyTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

async function loadBilibiliWbiKeys() {
  const today = Math.floor(Date.now() / 86_400_000);
  if (bilibiliWbiKeys && bilibiliWbiKeyDay === today) return bilibiliWbiKeys;
  if (bilibiliWbiKeyPromise) return bilibiliWbiKeyPromise;
  bilibiliWbiKeyPromise = (async () => {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: bilibiliHeaders(), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`B站 WBI 导航接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    const imgUrl = payload?.data?.wbi_img?.img_url || '';
    const subUrl = payload?.data?.wbi_img?.sub_url || '';
    const imgKey = imgUrl.split('/').pop()?.split('.')[0] || '';
    const subKey = subUrl.split('/').pop()?.split('.')[0] || '';
    if (!imgKey || !subKey) throw new Error('B站 WBI 密钥为空');
    bilibiliWbiKeys = { imgKey, subKey, mixinKey: wbiMixinKeyTable.map(index => `${imgKey}${subKey}`[index] || '').join('').slice(0, 32) };
    bilibiliWbiKeyDay = today;
    return bilibiliWbiKeys;
  })().finally(() => { bilibiliWbiKeyPromise = null; });
  return bilibiliWbiKeyPromise;
}

async function bilibiliWbiUrl(baseUrl, params) {
  const keys = await loadBilibiliWbiKeys();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  query.set('wts', String(Math.floor(Date.now() / 1000)));
  const unsigned = [...query.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`).join('&');
  query.set('w_rid', createHash('md5').update(unsigned + keys.mixinKey).digest('hex'));
  const url = new URL(baseUrl);
  url.search = query.toString();
  return url;
}

async function fetchMediaJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: bilibiliHeaders(options.headers || {}), signal: options.signal || AbortSignal.timeout(15_000) });
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
  if (/(?:^|\.)bilibili\.com$/i.test(hostname) && hasBilibiliSoftRisk(payload)) {
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
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
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

function extractBalancedDiv(html, marker) {
  const opening = String(html || '').indexOf(marker);
  if (opening < 0) return '';
  const start = String(html).lastIndexOf('<div', opening);
  if (start < 0) return '';
  const source = String(html);
  const token = /<div\b[^>]*>|<\/div\s*>/gi;
  token.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = token.exec(source))) {
    if (/^<div\b/i.test(match[0])) depth += 1;
    else depth -= 1;
    if (depth === 0) return source.slice(start, token.lastIndex);
  }
  return source.slice(start);
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

function parseBilibiliArticlePage(html, fallback = {}) {
  const source = String(html || '');
  const body = sanitizeBilibiliArticleHtml(extractBalancedDiv(source, 'opus-module-content opus-paragraph-children'));
  const stateMatch = source.match(/__INITIAL_STATE__=([\s\S]*?)<\/script>/i);
  let state = null;
  if (stateMatch) {
    try { state = JSON.parse(stateMatch[1].replace(/;\s*$/, '')); } catch {}
  }
  const detail = state?.detail;
  const basic = detail?.basic || {};
  const authorModule = Array.isArray(detail?.modules) ? detail.modules.find(module => module.module_type === 'MODULE_TYPE_AUTHOR')?.module_author : null;
  const title = basic.title ? String(basic.title).replace(/\s+-\s+哔哩哔哩\s*$/, '') : String(fallback.title || '');
  return {
    id: String(fallback.id || basic.comment_id_str || basic.rid_str || ''),
    title,
    author: authorModule?.name || fallback.author || '',
    authorUid: String(authorModule?.mid || fallback.author_uid || ''),
    publishedAt: fallback.publish_time ? new Date(Number(fallback.publish_time) * 1000).toISOString() : (authorModule?.pub_time || ''),
    sourceUrl: `https://www.bilibili.com/read/cv${String(fallback.id || basic.comment_id_str || basic.rid_str || '')}`,
    contentHtml: body
  };
}

async function fetchBilibiliArticlePageViaBrowser(id) {
  const articleUrl = `https://www.bilibili.com/read/cv${encodeURIComponent(id)}`;
  try {
    const headers = {
      'user-agent': bilibiliUserAgent,
      referer: bilibiliUpdatesReadlistUrl,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    if (bilibiliCookie) headers.cookie = bilibiliCookie;
    const response = await fetch(articleUrl, { headers, signal: AbortSignal.timeout(60_000) });
    if (response.ok) {
      const html = await response.text();
      if (html.includes('opus-module-content')) return html;
    }
  } catch {}
  // Keep the PowerShell path as a Windows-only fallback for existing installations.
  if (process.platform === 'win32') {
    try {
      const command = `$ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing -Uri '${articleUrl}' -Headers @{ 'User-Agent'='Mozilla/5.0'; Referer='${bilibiliUpdatesReadlistUrl}' }).Content`;
      const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024, windowsHide: true });
      if (result.stdout && result.stdout.includes('opus-module-content')) return result.stdout;
    } catch {}
  }
  const browser = await getBilibiliBrowser();
  const context = await browser.newContext({
    userAgent: bilibiliUserAgent,
    extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', referer: 'https://www.bilibili.com/' }
  });
  if (bilibiliCookie) {
    await context.addCookies(bilibiliCookie.split(';').map(pair => {
      const separator = pair.indexOf('=');
      return separator > 0 ? { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(), domain: '.bilibili.com', path: '/', secure: true } : null;
    }).filter(Boolean));
  }
  const page = await context.newPage();
  try {
    await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    return await page.content();
  } finally {
    await context.close().catch(() => {});
  }
}

async function fetchBilibiliArticleApi(id, fallback = {}) {
  const response = await fetch(`https://api.bilibili.com/x/article/view?id=${encodeURIComponent(id)}`, { headers: bilibiliHeaders(), signal: AbortSignal.timeout(30_000) });
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
    const response = await fetch(bilibiliUpdatesListApi, { headers: bilibiliHeaders(), signal: AbortSignal.timeout(30_000) });
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

async function fetchBilibiliVideo(source) {
  const payload = await fetchMediaJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(source.bvid)}`);
  const item = payload?.data;
  if (!item?.bvid) throw new Error('B站视频资料为空');
  return mediaVideoItem(source, {
    id: item.bvid,
    title: item.title,
    url: `https://www.bilibili.com/video/${item.bvid}`,
    thumbnail: item.pic,
    channel: item.owner?.name || '',
    publishedAt: item.pubdate ? new Date(Number(item.pubdate) * 1000).toISOString() : null
  });
}

async function fetchBilibiliVideoTags(bvid) {
  const key = String(bvid || '').trim();
  if (!key) return [];
  if (bilibiliVideoTagsCache.has(key)) return bilibiliVideoTagsCache.get(key);
  const payload = await fetchMediaJson(`https://api.bilibili.com/x/web-interface/view/detail/tag?bvid=${encodeURIComponent(key)}`);
  const tags = Array.isArray(payload?.data) ? payload.data : Object.values(payload?.data || {});
  const names = tags.map(tag => String(tag?.tag_name || tag?.name || '').trim()).filter(Boolean);
  bilibiliVideoTagsCache.set(key, names);
  return names;
}

function bilibiliTagMatchesEmpire2(tags) {
  return tags.some(tag => {
    const value = String(tag || '').replace(/\s+/g, '').toUpperCase();
    return /帝国时代(?:2|２|二|贰|貳|II|Ⅱ)(?![0-9０-９IVXLCDMⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])/u.test(value);
  });
}

async function fetchBilibiliVideos(source) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchBilibiliVideosViaApi(source);
    } catch (error) {
      lastError = error;
      const retryable = Number(error?.status) === 412
        || [-412, -352, -403, -509].includes(Number(error?.bilibiliCode));
      if (!retryable || attempt >= 2) break;
      const delay = attempt === 0 ? 5_000 : 10_000;
      console.warn(`[media] B站视频接口触发风控，${delay / 1000}s 后重试: ${source.name || source.id}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function bilibiliChromePath() {
  const candidates = [
    process.env.BILIBILI_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) || undefined;
}

async function getBilibiliBrowser() {
  if (bilibiliBrowserPromise) return bilibiliBrowserPromise;
  bilibiliBrowserPromise = chromium.launch({
    headless: true,
    executablePath: bilibiliChromePath(),
    proxy: proxyUrl ? { server: proxyUrl } : undefined,
    args: ['--disable-blink-features=AutomationControlled']
  }).catch(error => { bilibiliBrowserPromise = null; throw error; });
  return bilibiliBrowserPromise;
}

async function fetchBilibiliVideosInBrowser(source) {
  const browser = await getBilibiliBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }
  });
  if (bilibiliCookie) {
    await context.addCookies(bilibiliCookie.split(';').map(pair => {
      const separator = pair.indexOf('=');
      return separator > 0 ? { name: pair.slice(0, separator).trim(), value: pair.slice(separator + 1).trim(), domain: '.bilibili.com', path: '/', secure: true } : null;
    }).filter(Boolean));
  }
  const page = await context.newPage();
  try {
    const responsePromise = page.waitForResponse(response => response.url().includes('/x/space/wbi/arc/search'), { timeout: 30_000 });
    await page.goto(`https://space.bilibili.com/${encodeURIComponent(source.id)}/video`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const response = await responsePromise;
    const payload = await response.json();
    if (Number(payload?.code) !== 0) {
      const error = new Error(`B站浏览器接口返回业务码 ${payload?.code}${payload?.message ? `：${payload.message}` : ''}`);
      error.bilibiliCode = Number(payload?.code);
      throw error;
    }
    const list = payload?.data?.list?.vlist || [];
    console.log(`[media] browser video source checked: ${source.name || source.id}; items ${list.length}`);
    return list.map(item => mediaVideoItem(source, {
      id: item.bvid || item.aid,
      title: item.title,
      url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : `https://space.bilibili.com/${source.id}`,
      thumbnail: item.pic,
      publishedAt: item.created ? new Date(Number(item.created) * 1000).toISOString() : null
    }));
  } finally {
    await context.close().catch(() => {});
  }
}

async function fetchBilibiliVideosViaApi(source) {
  const url = await bilibiliWbiUrl('https://api.bilibili.com/x/space/wbi/arc/search', { mid: source.id, ps: 12, pn: 1, order: 'pubdate' });
  const payload = await fetchMediaJson(url);
  const list = payload?.data?.list?.vlist || [];
  return list.map(item => mediaVideoItem(source, {
    id: item.bvid || item.aid,
    title: item.title,
    url: item.bvid ? `https://www.bilibili.com/video/${item.bvid}` : `https://space.bilibili.com/${source.id}`,
    thumbnail: item.pic,
    publishedAt: item.created ? new Date(Number(item.created) * 1000).toISOString() : null
  }));
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
  if (source.platform === 'bilibili' && source.bvid) results = [await fetchBilibiliVideo(source)];
  else if (source.platform === 'bilibili') results = await fetchBilibiliVideos(source);
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
      if (!matches && source.platform === 'bilibili' && /^BV[0-9A-Za-z]{10}$/i.test(String(item.id || ''))) {
        try {
          const tags = await fetchBilibiliVideoTags(item.id);
          matches = bilibiliTagMatchesEmpire2(tags);
        } catch (error) {
          console.warn(`[media] B站视频标签获取失败: ${item.id}`, error.message);
        }
      }
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
    mediaVideoRateLimitStrikes = Math.max(0, Number(saved.rateLimitStrikes) || 0);
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
  } catch {
    // The scheduler state is optional and will be created after the first check.
  }
}

function ensureMediaVideoSourceStates() {
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
    rateLimitStrikes: mediaVideoRateLimitStrikes,
    cycleSeen: [...mediaVideoCycleSeen],
    sources
  }, null, 2), 'utf8');
}

function mediaVideoSuccessDelay(idleSuccesses) {
  if (idleSuccesses <= 1) return randomMediaDelay(mediaVideoActiveRefreshMin, mediaVideoActiveRefreshMax);
  if (idleSuccesses === 2) return randomMediaDelay(60 * 60_000, 90 * 60_000);
  if (idleSuccesses === 3) return randomMediaDelay(90 * 60_000, 180 * 60_000);
  return randomMediaDelay(180 * 60_000, 360 * 60_000);
}

function isBilibiliRateLimit(error) {
  return Number(error?.status) === 412 || [-412, -352, -403].includes(Number(error?.bilibiliCode));
}

function mediaVideoNextDueAt() {
  const sources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
  if (!sources.length) return 0;
  const due = sources.map(source => {
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
  const liveVideoId = html.match(/"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,7000}?"style":"LIVE"/i)?.[1]
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
  const online = !/"status"\s*:\s*"LIVE_STREAM_OFFLINE"/i.test(html)
    && ( /"isLiveNow"\s*:\s*true|<meta itemprop=["']isLiveBroadcast["'] content=["']True|liveStreamabilityRenderer"\s*:\s*\{[^}]*"videoId"/i.test(html) || Boolean(liveVideoId) || channelLiveBadge );
  const title = mediaText(html.match(/<meta property=["']og:title["'] content=["']([^"']+)/i)?.[1] || '');
  const viewers = Number(html.match(/(?:concurrentViewers|viewCount|viewerCount)[^\d]{0,20}(\d+)/i)?.[1] || 0);
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

  const refresh = (async () => {
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
  })().catch(error => {
    if (cached) return cached.data;
    throw error;
  }).finally(() => livePlayerStatsRefreshes.delete(key));
  livePlayerStatsRefreshes.set(key, refresh);
  return refresh;
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
        let item;
        if (source.platform === 'bilibili') {
          const roomId = source.url.match(/live\.bilibili\.com\/(\d+)/i)?.[1];
          item = await fetchBilibiliLive({ ...source, roomId, url: source.url });
        } else if (source.platform === 'youtube_live' || source.platform === 'youtube') {
          item = await fetchYoutubeLive({ ...source, liveUrl: source.url, url: source.url, platform: 'youtube', isCN: source.isCN });
        } else if (source.platform === 'twitch') {
          item = await fetchTwitchLive(source);
        } else if (source.platform === 'douyu') {
          item = await fetchDouyuLive(source);
        } else if (source.platform === 'douyin') {
          item = await fetchDouyinLive(source);
        } else {
          item = await fetchGenericLive(source);
        }
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

    const candidates = (Array.isArray(mediaSources.videos) ? mediaSources.videos : [])
      .map(source => ({ source, state: mediaVideoSourceStates.get(mediaVideoSourceKey(source)) }))
      .filter(({ source, state }) => state && state.nextCheckAt <= now && (source.platform !== 'bilibili' || now >= mediaVideoBlockedUntil))
      .sort((a, b) => a.state.nextCheckAt - b.state.nextCheckAt || a.state.lastAttemptAt - b.state.lastAttemptAt);
    const candidate = candidates[0];
    if (!candidate) {
      updateMediaVideoNextRefreshAt();
      return mediaCache.data;
    }

    const { source, state } = candidate;
    const key = mediaVideoSourceKey(source);
    state.lastAttemptAt = now;
    mediaVideoNextRequestAt = now + mediaVideoRequestGapMin;
    try {
      const videos = await fetchMediaVideoSource(source);
      const cachedIds = new Set(mediaCache.data.videos.map(item => String(item?.id || '')).filter(Boolean));
      const hasNewVideo = videos.some(item => item?.id && !cachedIds.has(String(item.id)));
      state.lastSuccessAt = Date.now();
      state.failureCount = 0;
      state.idleSuccesses = hasNewVideo ? 0 : Math.min(4, state.idleSuccesses + 1);
      state.nextCheckAt = Date.now() + mediaVideoCycleDelay;
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
        const backoff = Math.min(mediaVideoCircuitMaxDelay, mediaVideoCircuitBaseDelay * (2 ** (mediaVideoRateLimitStrikes - 1)));
        mediaVideoBlockedUntil = Date.now() + Math.max(backoff, Number(error.retryAfterMs) || 0);
        state.nextCheckAt = mediaVideoBlockedUntil;
        console.warn(`[media] B站触发风控，暂停视频检测至 ${new Date(mediaVideoBlockedUntil).toISOString()}: ${source.name || key}`);
      } else {
        state.nextCheckAt = Date.now() + mediaVideoCycleDelay;
        console.warn(`[media] video source failed: ${source.name || key}`, error.message);
      }
    }
    mediaVideoCycleSeen.add(key);
    const videoSources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
    const cycleComplete = videoSources.length > 0 && videoSources.every(videoSource => mediaVideoCycleSeen.has(mediaVideoSourceKey(videoSource)));
    if (cycleComplete) {
      const cycleNextAt = Date.now() + mediaVideoCycleDelay;
      for (const videoSource of videoSources) {
        const videoState = mediaVideoSourceStates.get(mediaVideoSourceKey(videoSource));
        if (videoState) videoState.nextCheckAt = cycleNextAt;
      }
      mediaVideoCycleSeen.clear();
      mediaVideoNextRequestAt = cycleNextAt;
      console.log(`[media] video cycle complete; next cycle ${new Date(cycleNextAt).toISOString()}`);
    } else {
      mediaVideoNextRequestAt = Date.now() + mediaVideoRequestGapMin;
    }
    updateMediaVideoNextRefreshAt();
    await savePersistentMediaVideoState();
    return mediaCache.data;
  })().finally(() => { mediaVideosRefreshPromise = null; });
  return mediaVideosRefreshPromise;
}

function refreshMediaLive() {
  if (mediaLiveRefreshPromise) return mediaLiveRefreshPromise;
  mediaLiveRefreshPromise = loadPersistentMediaLive().then(() => fetchMediaLive()).then(async live => {
    const failedSourceKeys = live.failedSourceKeys || new Set();
    const merged = [...live];
    const mergedKeys = new Set(merged.map(item => `${item.platform || ''}|${item.url || ''}`));
    for (const previous of Array.isArray(mediaCache.data.live) ? mediaCache.data.live : []) {
      const key = `${previous.platform || ''}|${previous.url || ''}`;
      if (failedSourceKeys.has(key) && !mergedKeys.has(key)) {
        merged.push(previous);
        mergedKeys.add(key);
      }
    }
    merged.sort((a, b) => {
      if (a.isCN && b.isCN) return Number(a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sourceOrder ?? Number.MAX_SAFE_INTEGER);
      if (!a.isCN && !b.isCN) return Number(b.viewers || 0) - Number(a.viewers || 0);
      return a.isCN ? -1 : 1;
    });
    const now = Date.now();
    mediaCache.data.live = merged;
    mediaCache.data.liveUpdatedAt = new Date(now).toISOString();
    mediaCache.data.nextLiveRefreshAt = new Date(now + mediaLiveRefreshInterval).toISOString();
    mediaCache.data.updatedAt = new Date(now).toISOString();
    mediaCache.data.nextRefreshAt = new Date(Math.min(
      Date.parse(mediaCache.data.nextVideosRefreshAt || mediaCache.data.nextLiveRefreshAt),
      Date.parse(mediaCache.data.nextLiveRefreshAt)
    )).toISOString();
    mediaCache.liveSavedAt = now;
    await writeFile(mediaLiveCachePath, JSON.stringify({ savedAt: new Date(now).toISOString(), live: merged }, null, 2), 'utf8');
    return mediaCache.data;
  }).finally(() => { mediaLiveRefreshPromise = null; });
  return mediaLiveRefreshPromise;
}

async function startMediaVideoScheduler() {
  await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState()]);
  ensureMediaVideoSourceStates();
  if (process.env.MEDIA_VIDEO_RESET === '1') {
    const resetAt = Date.now();
    mediaVideoNextRequestAt = 0;
    mediaVideoBlockedUntil = 0;
    mediaVideoRateLimitStrikes = 0;
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

function gameAssetPath(kind, slug) {
  return join(gameAssetCacheDir, kind, `${slug}.png`);
}

async function getGameAsset(kind, slug) {
  const target = gameAssetPath(kind, slug);
  try {
    return await readFile(target);
  } catch {
    // Continue to the upstream fetch when this asset has not been cached yet.
  }
  const key = `${kind}/${slug}`;
  if (!gameAssetRefreshes.has(key)) {
    const refresh = (async () => {
      const compactSlug = slug.replaceAll('_', '');
      const candidates = kind === 'map'
        ? [`maps/rm_${slug}.png`, `maps/${slug}.png`, `maps/rm_${compactSlug}.png`, `maps/${compactSlug}.png`]
        : [`civilizations/${slug}.png`, ...(slug === 'inca' ? ['civilizations/incas.png'] : []), ...(slug === 'maya' ? ['civilizations/mayans.png'] : [])];
      let response = null;
      for (const upstreamPath of candidates) {
        const candidate = await fetch(`https://backend.cdn.aoe2companion.com/public/aoe2/de/${upstreamPath}`, { signal: AbortSignal.timeout(15000) });
        if (candidate.ok) { response = candidate; break; }
      }
      if (!response) throw new Error('游戏资源不存在');
      const data = Buffer.from(await response.arrayBuffer());
      await mkdir(join(gameAssetCacheDir, kind), { recursive: true });
      await writeFile(target, data);
      return data;
    })().finally(() => gameAssetRefreshes.delete(key));
    gameAssetRefreshes.set(key, refresh);
  }
  return gameAssetRefreshes.get(key);
}

async function fetchLeaderboardPage(id, page) {
  const upstream = new URL(api);
  upstream.search = new URLSearchParams({ title: 'age2', leaderboard_id: String(id), sortBy: '1', start: String((page - 1) * 100 + 1), count: '100' });
  const response = await fetchUpstreamWithRateLimit(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`上游服务返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '游戏数据服务暂不可用');
  return payload;
}

async function fetchLeaderboard(id, pageCount = 3, startPage = 1) {
  const pages = [];
  for (let page = startPage; page < startPage + pageCount; page += 1) {
    if (pages.length) await new Promise(resolve => setTimeout(resolve, 250));
    pages.push(await fetchLeaderboardPage(id, page));
  }
  const rows = leaderboardRowsFromPayloads(pages);
  const total = Math.min(maxLeaderboardRows, Number(pages[0]?.rankTotal || 0) || rows.length);
  return {
    leaderboardId: id,
    label: types[id],
    total,
    pageSize: 100,
    pageCount: Math.min(Math.ceil(maxLeaderboardRows / 100), Math.max(1, Math.ceil(total / 100))),
    loadedPages: Array.from({ length: pageCount }, (_, index) => startPage + index),
    updatedAt: new Date().toISOString(),
    rows: rows.slice(0, Math.min(pageCount * 100, total, maxLeaderboardRows))
  };
}

function parseInsightsCard(html, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`<span class="card-title">\\s*${escaped}\\s*</span>\\s*<span class="card-value">\\s*([^<]+?)\\s*</span>`, 'i'));
  return match ? match[1].replace(/&nbsp;/g, ' ').trim() : null;
}

async function fetchInsightsSummaryPage(leaderboardId, country = '') {
  const url = new URL(`https://www.aoe2insights.com/leaderboard/${leaderboardId}/`);
  if (country) url.searchParams.set('country', country.toLowerCase());
  else url.searchParams.set('page', '1');
  const response = await fetch(url, { headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`AoE2Insights 请求失败（HTTP ${response.status}）`);
  return response.text();
}

async function fetchAoE2InsightsSummary(leaderboardId, country) {
  const key = `${leaderboardId}:${country || 'all'}`;
  const cached = aoe2InsightsSummaryCache.get(key);
  if (cached && Date.now() - cached.savedAt < aoe2InsightsSummaryTtl) return cached.data;
  if (aoe2InsightsSummaryRefreshes.has(key)) return aoe2InsightsSummaryRefreshes.get(key);
  const refresh = (async () => {
    let globalHtml = null;
    let fallbackBoard = null;
    try { globalHtml = await fetchInsightsSummaryPage(leaderboardId); } catch { fallbackBoard = await getLeaderboard(leaderboardId); }
    const fallbackRatings = fallbackBoard?.rows?.map(row => Number(row.rating)).filter(Number.isFinite) || [];
    const averageRating = globalHtml
      ? Number(String(parseInsightsCard(globalHtml, 'Average Elo') || '').replace(/,/g, '')) || null
      : (fallbackRatings.length ? fallbackRatings.reduce((sum, value) => sum + value, 0) / fallbackRatings.length : null);
    const totalPlayers = globalHtml
      ? Number(String(parseInsightsCard(globalHtml, 'Players') || '').replace(/,/g, '')) || 0
      : Number(fallbackBoard?.total || fallbackRatings.length);
    if (!country || country === 'all') return { averageRating, countryPlayers: totalPlayers, totalPlayers, top100Country: Math.min(100, totalPlayers) };
    const codes = country === 'CN' ? ['cn', 'hk', 'mo'] : [country.toLowerCase()];
    const pages = await Promise.all(codes.map(code => fetchInsightsSummaryPage(leaderboardId, code)));
    const countryStats = pages.map(html => ({
      players: Number(String(parseInsightsCard(html, 'Players') || '').replace(/,/g, '')) || 0,
      average: Number(String(parseInsightsCard(html, 'Average Elo') || '').replace(/,/g, '')) || 0,
      top100: Number(String(parseInsightsCard(html, 'Players in Top 100') || '').replace(/,/g, '')) || 0
    }));
    const countryPlayers = countryStats.reduce((sum, stat) => sum + stat.players, 0);
    const top100Country = countryStats.reduce((sum, stat) => sum + stat.top100, 0);
    const weightedPlayers = countryStats.reduce((sum, stat) => sum + stat.average * stat.players, 0);
    return { averageRating: countryPlayers ? weightedPlayers / countryPlayers : null, countryPlayers, totalPlayers, top100Country };
  })().then(data => { aoe2InsightsSummaryCache.set(key, { savedAt: Date.now(), data }); return data; }).finally(() => aoe2InsightsSummaryRefreshes.delete(key));
  aoe2InsightsSummaryRefreshes.set(key, refresh);
  return refresh;
}

function settleCacheWaiters(id, error) {
  const waiters = cacheWaiters.get(id) || [];
  cacheWaiters.delete(id);
  for (const waiter of waiters) error ? waiter.reject(error) : waiter.resolve();
}

function refreshLeaderboard(id) {
  if (leaderboardRefreshes.has(id)) return leaderboardRefreshes.get(id);
  const refresh = fetchLeaderboard(id, 3, 1).then(data => {
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

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const character = line[i];
    if (character === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { fields.push(value); value = ''; }
    else value += character;
  }
  fields.push(value);
  return fields;
}

async function importProfileCsv(db, csvPath) {
  profileRefreshState.stage = '读取 CSV 并整理玩家资料';
  const insert = db.prepare('INSERT OR REPLACE INTO profiles(profile_id, steam_id, name, clan, last_match_time, country) VALUES (?, ?, ?, ?, ?, ?)');
  let batchRows = 0;
  let headerMap = null;
  db.exec('BEGIN');
  const input = createReadStream(csvPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!headerMap) {
      const headers = parseCsvLine(line).map(value => value.replace(/^\uFEFF/, '').trim());
      headerMap = Object.fromEntries(headers.map((header, index) => [header, index]));
      if (headerMap.profile_id == null || headerMap.name == null) throw new Error('Profile CSV 缺少必要字段');
      continue;
    }
    const fields = parseCsvLine(line);
    const profileId = String(fields[headerMap.profile_id] || '').trim();
    const name = String(fields[headerMap.name] || '').trim();
    if (!/^\d+$/.test(profileId) || !name) continue;
    insert.run(profileId, String(fields[headerMap.steam_id] || '').trim(), name, String(fields[headerMap.clan] || '').trim(), String(fields[headerMap.last_match_time] || '').trim(), String(fields[headerMap.country] || '').trim());
    profileRefreshState.processedRows += 1;
    batchRows += 1;
    if (batchRows >= 20_000) { db.exec('COMMIT; BEGIN'); batchRows = 0; }
  }
  db.exec('COMMIT');
  if (!profileRefreshState.processedRows) throw new Error('Profile CSV 中没有读取到玩家资料');
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
    try {
      const localDump = await stat(profileLocalDumpPath);
      if (!localDump.isFile() || localDump.size <= 0) throw new Error('本地 Profile dump 为空');
      sourceDumpPath = profileLocalDumpPath;
      profileRefreshState.stage = '读取本地 Parquet Profile dump';
      profileRefreshState.downloadedBytes = localDump.size;
      profileRefreshState.totalBytes = localDump.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await downloadProfileParquet(tempDumpPath);
      await rename(tempDumpPath, dumpPath);
    }
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
  profileRefreshTimer = setTimeout(async function refreshAtInterval() {
    try { await refreshProfileCache(); }
    catch (error) { console.error('玩家资料 dump 更新失败:', error.message); }
    const nextDelay = profileRefreshState.error ? profileRefreshRetryInterval : Math.max(1_000, nextProfileRefreshAt() - Date.now());
    profileRefreshTimer = setTimeout(refreshAtInterval, nextDelay);
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

const worldsEdgeMatchTypes = new Map([
  [2, 'DM 1v1'], [3, 'DM TG'], [4, 'DM TG'], [5, 'DM TG'],
  [6, 'RM 1v1'], [7, 'RM TG'], [8, 'RM TG'], [9, 'RM TG'],
  [10, 'RM FFA'], [26, 'EW 1v1'], [27, 'EW TG'], [28, 'EW TG'], [29, 'EW TG'],
  [66, 'RM 1v1'], [67, 'RM TG'], [68, 'RM TG'], [69, 'RM TG']
]);
const worldsEdgeCivilizations = ['亚美尼亚', '阿兹特克', '孟加拉', '柏柏尔', '波希米亚', '不列颠', '保加利亚', '勃艮第', '缅甸', '拜占庭', '凯尔特', '中国', '库曼', '达罗毗荼', '埃塞俄比亚', '法兰克', '格鲁吉亚', '哥特', '瞿折罗', '匈奴', '印加', '印度斯坦', '意大利', '日本', '高棉', '朝鲜', '立陶宛', '马扎尔', '马来', '马里', '玛雅', '蒙古', '波斯', '波兰', '葡萄牙', '罗马', '撒拉逊', '西西里', '斯拉夫', '西班牙', '鞑靼', '条顿', '土耳其', '越南', '维京', '阿契美尼德', '雅典', '斯巴达', '蜀', '吴', '魏', '女真', '契丹'];

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
      live: Boolean(started && !finished && !match.abandoned),
      duration: started && finished && finished >= started ? finished - started : 0,
      server: match.server || '',
      players,
      teams
    };
  }).sort((a, b) => Number(b.started) - Number(a.started));
}

const matchesService = createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches });
const { fetchWorldsEdgeMatchesOnce, fetchLatestWorldsEdgeMatchOnce } = matchesService;

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
  worldsEdgeMatchCachePath
});

async function getWorldsEdgeMatches(profileId, page = 1) {
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
        latestMatch = await fetchLatestWorldsEdgeMatchOnce(profileId);
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
              for (const requestedCount of [10, 20, 40, 80, 100]) {
                freshPage = await fetchWorldsEdgeMatchesOnce(profileId, 1, requestedCount);
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
        if (stale.matches.length && stale.pages >= page) return stale;
        throw error;
      }
    }
    if (latestChanged && latestMatch && current && page === 1) {
      // Expand cumulative upstream windows until the cached latest match is found.
      // This uses the cached match ID as a watermark and avoids estimating the
      // number of new matches from elapsed time.
      const anchorId = String(current.matches[0].id);
      let collected = [];
      let anchorIndex = -1;
      let pageCount = 0;
      for (const requestedCount of [10, 20, 40, 80, 100]) {
        // Request cumulative windows so each step is 10 -> 20 -> 40 -> 80 -> 100.
        // Always use page 1 because the page size changes between attempts.
        const result = await fetchWorldsEdgeMatchesOnce(profileId, 1, requestedCount);
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
        result = await fetchWorldsEdgeMatchesOnce(profileId, nextPage);
      } catch (error) {
        if (stale?.matches?.length && stale.pages >= page) return stale;
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

function localProfileDetails(profileId) {
  if (!profileDb) return null;
  const row = profileDb.prepare('SELECT profile_id AS profileId, steam_id AS steamId, name, clan, last_match_time AS lastMatchTime, country FROM profiles WHERE profile_id = ?').get(String(profileId));
  if (!row) return null;
  const leaderboardRow = [...leaderboardCache.values()]
    .flatMap(cache => cache.data?.rows || [])
    .find(item => String(item.profileId) === String(profileId));
  const inferredClan = String(row.name || '').match(/^([A-Z0-9]{2,})[_\s.]/i)?.[1] || '';
  const clan = row.clan || leaderboardRow?.clan || inferredClan;
  return {
    avatar: '',
    player: { id: row.profileId, name: row.name || `玩家 ${row.profileId}`, country_code: row.country || leaderboardRow?.country || '', team: clan, steamId: row.steamId || '', lastMatchTime: row.lastMatchTime || '' },
    accounts: [],
    live: null,
    matches: [],
    leaderboards: profileLeaderboardSummary(profileId)
  };
}

function profileLeaderboardSummary(profileId) {
  return ladderOrder.map(id => {
    const cached = leaderboardCache.get(id);
    const row = cached?.data.rows.find(item => String(item.profileId) === String(profileId));
    return row ? { id, label: types[id], rank: row.rank, rating: row.rating, highestRating: row.highestRating, wins: row.wins, losses: row.losses, streak: row.streak } : { id, label: types[id], rank: null };
  });
}

async function fetchPersonalLeaderboardStats(profileId) {
  const key = String(profileId);
  const cached = personalStatsCache.get(key);
  if (cached && Date.now() - cached.savedAt < personalStatsCacheTtl) return cached.data;
  const endpoint = new URL('https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat');
  endpoint.search = new URLSearchParams({ title: 'age2', profile_ids: JSON.stringify([Number(profileId)]) });
  let response;
  try {
    response = await fetchUpstreamWithRateLimit(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    if (error.rateLimited && cached) return cached.data;
    throw error;
  }
  if (!response.ok) throw new Error(`个人天梯接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '个人天梯接口返回失败');
  const stats = new Map((payload.leaderboardStats || []).map(stat => [Number(stat.leaderboard_id), stat]));
  const data = ladderOrder.map(id => {
    const stat = stats.get(id);
    if (!stat) return { id, label: types[id], hasData: false, active: false, rank: null };
    const active = Number(stat.rank) > 0;
    return { id, label: types[id], hasData: true, active, rank: active ? Number(stat.rank) : null, rating: stat.rating ?? null, highestRating: Number(stat.highestrating) > 0 ? stat.highestrating : (stat.rating ?? null), wins: stat.wins ?? null, losses: stat.losses ?? null, streak: stat.streak ?? null, lastMatchDate: stat.lastmatchdate ?? null, rankTotal: stat.ranktotal ?? null };
  });
  personalStatsCache.set(key, { savedAt: Date.now(), data });
  return data;
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

function searchProfiles(query, leaderboardId) {
  const normalized = query.trim();
  const resultLimit = 500;
  const normalizedLower = normalized.toLocaleLowerCase();
  const prefix = `${normalizedLower}%`;
  const statement = [...normalized].length >= 3
    ? profileDb.prepare("SELECT p.profile_id AS profileId, p.steam_id AS steamId, p.name, p.clan, p.country, p.last_match_time AS lastMatchTime FROM profile_search f JOIN profiles p ON p.rowid = f.rowid WHERE profile_search MATCH ? ORDER BY CASE WHEN trim(coalesce(p.clan, '')) <> '' THEN 0 ELSE 1 END, CASE WHEN lower(p.name) = lower(?) THEN 0 WHEN lower(p.name) LIKE ? THEN 1 ELSE 2 END, p.name COLLATE NOCASE LIMIT ?")
    : profileDb.prepare("SELECT profile_id AS profileId, steam_id AS steamId, name, clan, country, last_match_time AS lastMatchTime FROM profiles WHERE instr(lower(name), lower(?)) > 0 ORDER BY CASE WHEN trim(coalesce(clan, '')) <> '' THEN 0 ELSE 1 END, CASE WHEN lower(name) = lower(?) THEN 0 WHEN lower(name) LIKE ? THEN 1 ELSE 2 END, name COLLATE NOCASE LIMIT ?");
  const match = [...normalized].length >= 3 ? `"${normalized.replaceAll('"', '""')}"` : normalized;
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
  const candidates = new Map(statement.all(match, normalized, prefix, resultLimit).map(player => [String(player.profileId), { ...player, aliases: [] }]));
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/api/realtime') {
    let profileIds = [];
    try { const requested = url.searchParams.get('profile_ids'); if (requested) profileIds = JSON.parse(requested); else { const pool = JSON.parse(await readFile(join(dataDir, 'realtime-profile-pool.json'), 'utf8')); profileIds = Array.isArray(pool.ids) && pool.ids.length ? pool.ids : [506898,8793414,212721,3025516,1966276]; } } catch { profileIds = [506898,8793414,212721,3025516,1966276]; }
    const ids = [...new Set(profileIds.map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    // This endpoint is cache-only. The scheduled server task is the only code
    // path that calls the upstream match API; browser reads never trigger refresh.
    const cachedPayload = await realtimeService.getCachedPayload(ids);
    if (cachedPayload) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
      const results = searchProfiles(query, types[leaderboardId] ? leaderboardId : 3);
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
        const latest = await fetchLatestWorldsEdgeMatchOnce(profileId);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ matches: latest ? [latest] : [], latest: true }));
      } catch {
        try {
          const fallback = await getWorldsEdgeMatches(profileId, 1);
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
        let initial;
        try {
          initial = await fetchWorldsEdgeMatchesOnce(profileId, 1, 20);
        } catch {
          // If the lightweight request fails, let the regular cached path
          // provide stale data instead of leaving the profile empty.
          const fallback = await getWorldsEdgeMatches(profileId, 1);
          initial = { matches: fallback.matches.slice(0, 20), hasMore: false };
        }
        // Continue the cache refresh in the background. The first 20 matches
        // are already available to the client and can be rendered immediately.
        getWorldsEdgeMatches(profileId, 1).catch(error => console.error(`选手 ${profileId} 对局缓存更新失败:`, error.message));
        const page = initial.matches.slice(0, 20);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ matches: page, offset: 0, total: page.length, hasMore: true, progressive: true }));
      }
      const pageNumber = Math.floor(offset / 100) + 1;
      const cached = await getWorldsEdgeMatches(profileId, pageNumber);
      const matches = cached.matches;
      const page = matches.slice(offset, offset + limit);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
      return res.end(JSON.stringify({ matches: page, offset, total: matches.length, hasMore: offset + page.length < matches.length || cached.hasMore }));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: error.message || '获取近期对局失败' }));
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
      const endpoint = `https://api.ageofempires.com/api/GameStats/AgeII/GetMatchReplay/?matchId=${matchId}&profileId=${profileId}`;
      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' },
        signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`录像接口请求失败（HTTP ${response.status}）`);
      const data = Buffer.from(await response.arrayBuffer());
      res.writeHead(200, {
        'content-type': response.headers.get('content-type') || 'application/octet-stream',
        'content-length': String(data.length),
        'content-disposition': response.headers.get('content-disposition') || `attachment; filename="aoe2-match-${matchId}.zip"`,
        'cache-control': 'no-store'
      });
      return res.end(data);
    } catch (error) {
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
      const leaderboards = await fetchPersonalLeaderboardStats(profileId);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=600' });
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
      const summary = await fetchAoE2InsightsSummary(leaderboardId, country);
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
      const maxAgeSeconds = Math.max(1, Math.ceil((Number(data.cacheExpiresAt || 0) - Date.now()) / 1000));
      return sendVersionedJson(req, res, data, `leaderboard-${id}-${data.updatedAt || data.cacheExpiresAt || 'snapshot'}`, maxAgeSeconds);
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
      const data = await getMediaCache();
      const maxAgeSeconds = Math.max(1, Math.ceil((Date.parse(data.nextRefreshAt || '') - Date.now()) / 1000));
      return sendVersionedJson(req, res, data, `media-${data.updatedAt || 'snapshot'}`, maxAgeSeconds);
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

  if (url.pathname === '/api/avatar') {
    let steamId = url.searchParams.get('steamId') || '';
    const profileId = url.searchParams.get('profileId') || '';
    const validProfileId = /^\d+$/.test(profileId);
    const fetchAoE2RecsAvatar = async () => {
      if (!validProfileId) return '';
      const fallback = await getAoE2RecsProfile(profileId);
      const avatar = fallback?.profile?.avatar || '';
      const parsed = avatar ? new URL(avatar) : null;
      return parsed?.protocol === 'https:' && parsed.hostname.endsWith('.steamstatic.com') ? avatar : '';
    };
    if (!/^\d{17}$/.test(steamId) && validProfileId && profileDb) {
      steamId = String(profileDb.prepare('SELECT steam_id AS steamId FROM profiles WHERE profile_id = ?').get(profileId)?.steamId || '');
    }
    if (!/^\d{17}$/.test(steamId)) {
      if (validProfileId) {
        try {
          const profileCacheKey = `profile:${profileId}`;
          const cachedAvatar = avatarCache.get(profileCacheKey);
          if (cachedAvatar?.expires > Date.now()) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, stale-while-revalidate=3600' });
            return res.end(JSON.stringify(cachedAvatar));
          }
          const avatar = await fetchAoE2RecsAvatar();
          if (avatar) {
            const cached = { avatar, expires: Date.now() + 24 * 60 * 60_000 };
            avatarCache.set(profileCacheKey, cached);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, stale-while-revalidate=3600' });
            return res.end(JSON.stringify(cached));
          }
        } catch {}
      }
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '找不到可用头像' }));
    }
    try {
      let cached = avatarCache.get(steamId);
      if (!cached || cached.expires <= Date.now()) {
        const profile = await fetch(`https://steamcommunity.com/profiles/${steamId}?xml=1`, { signal: AbortSignal.timeout(10000) });
        if (!profile.ok) throw new Error(`Steam 返回 HTTP ${profile.status}`);
        const xml = await profile.text();
        const avatar = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/)?.[1] || xml.match(/<avatarFull>(.*?)<\/avatarFull>/)?.[1] || '';
        const parsed = avatar ? new URL(avatar) : null;
        const safeAvatar = parsed?.protocol === 'https:' && parsed.hostname.endsWith('.steamstatic.com') ? avatar : '';
        cached = { avatar: safeAvatar, expires: Date.now() + 24 * 60 * 60_000 };
        avatarCache.set(steamId, cached);
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, stale-while-revalidate=3600' });
      return res.end(JSON.stringify(cached));
    } catch (error) {
      if (validProfileId) {
        try {
          const avatar = await fetchAoE2RecsAvatar();
          if (avatar) {
            const cached = { avatar, expires: Date.now() + 24 * 60 * 60_000 };
            avatarCache.set(steamId, cached);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=86400, stale-while-revalidate=3600' });
            return res.end(JSON.stringify(cached));
          }
        } catch {}
      }
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '头像暂不可用' }));
    }
  }

  const relative = url.pathname === '/' || /^\/(?:profile(?:\/\d+)?|media(?:\/videos)?|updates|realtime|build-orders(?:\/[a-z0-9-]+)?)\/?$/i.test(url.pathname) ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(root, 'public', relative));
  if (!path.startsWith(join(root, 'public'))) {
    res.writeHead(403); return res.end('Forbidden');
  }
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
}).listen(port, () => {
  console.log(`AoE2DE Ladder running at http://localhost:${port}`);
  refreshMediaCache().catch(error => console.warn('[media] initial refresh failed:', error.message));
  startBilibiliUpdatesLifecycle().catch(error => console.warn('[updates] lifecycle startup failed:', error.message));
  startProfileCacheLifecycle().catch(error => console.error('启动玩家资料缓存失败:', error.message));
  const refreshRealtimeOnServer = async () => {
    try {
      const pool = JSON.parse(await readFile(join(dataDir, 'realtime-profile-pool.json'), 'utf8'));
      const ids = Array.isArray(pool.ids) && pool.ids.length ? pool.ids : [506898,8793414,212721,3025516,1966276];
      await realtimeService.refreshRealtimePayload(ids);
    } catch (error) { console.warn('[realtime] scheduled refresh failed:', error.message); }
  };
  setTimeout(refreshRealtimeOnServer, 1000).unref();
  setInterval(refreshRealtimeOnServer, 60 * 1000).unref();
});







