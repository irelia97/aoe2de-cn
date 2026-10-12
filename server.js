import http from 'node:http';
import { readFile, open, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { ProxyAgent, WebSocket, setGlobalDispatcher } from 'undici';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, '.cache');
const aoe2RecsProfileCacheDir = join(dataDir, 'aoe2recs-profiles');
const gameAssetCacheDir = join(dataDir, 'game-assets');
const profilePointerPath = join(dataDir, 'profile-index-current.json');
const profileDumpUrl = 'https://dump.cdn.aoe2companion.com/profile.csv';
const profileRefreshInterval = 25 * 60 * 60_000;
const port = Number(process.env.PORT || 3000);
const api = 'https://aoe-api.worldsedgelink.com/community/leaderboard/getLeaderBoard2';
const types = { 1: '1v1 死亡竞赛', 2: '团队死亡竞赛', 3: '1v1 随机地图', 4: '团队随机地图', 13: '1v1 帝国战争', 14: '团队帝国战争' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const avatarCache = new Map();
const leaderboardCache = new Map();
const leaderboardRefreshes = new Map();
const personalStatsCache = new Map();
const personalStatsCacheTtl = 10 * 60_000;
const aoe2InsightsSummaryCache = new Map();
const aoe2InsightsSummaryRefreshes = new Map();
const aoe2InsightsSummaryTtl = 6 * 60 * 60_000;
// Refresh cadence is defined per leaderboard. The two most frequently viewed
// ladders update every minute at fixed wall-clock marks; the other ladders are
// refreshed once every six hours and staggered by one hour to spread upstream
// requests across the six-hour cycle.
const leaderboardSchedules = {
  3: { period: 60_000, offset: 0 },
  4: { period: 60_000, offset: 30_000 },
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

async function fetchLeaderboard(id) {
  // The game service caps each response at 100 players, so collect twenty pages.
  const pages = await Promise.all(Array.from({ length: 20 }, async (_, page) => {
    const upstream = new URL(api);
    upstream.search = new URLSearchParams({ title: 'age2', leaderboard_id: String(id), sortBy: '1', start: String(page * 100 + 1), count: '100' });
    const response = await fetch(upstream, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`上游服务返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '游戏数据服务暂不可用');
    return payload;
  }));
  const groups = pages.flatMap(payload => payload.statGroups || []);
  const stats = new Map(pages.flatMap(payload => payload.leaderboardStats || []).map(row => [row.statgroup_id, row]));
  const rows = groups.flatMap(group => (group.members || []).map(member => {
    const stat = stats.get(group.id);
    const steamId = member.name?.match(/^\/steam\/(\d+)$/)?.[1] || '';
    return stat ? { rank: stat.rank, name: member.alias || member.name || '未知玩家', alias: member.alias || '', clan: member.clan || '', country: member.country || '', rating: stat.rating, highestRating: stat.highestrating ?? stat.rating, wins: stat.wins, losses: stat.losses, streak: stat.streak, lastMatchDate: stat.lastmatchdate ?? null, profileId: member.profile_id, steamId } : [];
  })).sort((a, b) => a.rank - b.rank).slice(0, 2000);
  return { leaderboardId: id, label: types[id], total: pages[0].rankTotal || rows.length, updatedAt: new Date().toISOString(), rows };
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
  const refresh = fetchLeaderboard(id).then(data => {
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
    // Warm an empty cache on first access; scheduled refreshes still follow the
    // fixed second marks below.
    await refreshLeaderboard(id);
    cached = leaderboardCache.get(id);
  }
  // Stale snapshots remain usable while the scheduled refresh is in progress.
  const now = Date.now();
  return { ...cached.data, cacheExpiresAt: cached.expiresAt > now ? cached.expiresAt : nextLeaderboardRefreshAt(id, now) };
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

async function downloadProfileCsv(tempPath) {
  const response = await fetch(profileDumpUrl, { headers: { accept: 'text/csv' }, signal: AbortSignal.timeout(60 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Profile dump 返回 HTTP ${response.status}`);
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
  profileRefreshState.stage = '下载 CSV Profile dump';
  profileRefreshState.downloadedBytes = 0;
  profileRefreshState.totalBytes = 0;
  profileRefreshState.processedRows = 0;
  profileRefreshState.startedAt = new Date().toISOString();
  profileRefreshState.error = null;
  const id = `${Date.now()}-${randomUUID()}`;
  const tempFilename = `profile-index-${id}.sqlite.tmp`;
  const finalFilename = `profile-index-${id}.sqlite`;
  const tempDumpFilename = `profile-dump-${id}.csv.tmp`;
  const dumpFilename = `profile-dump-${id}.csv`;
  const tempPath = join(dataDir, tempFilename);
  const finalPath = join(dataDir, finalFilename);
  const tempDumpPath = join(dataDir, tempDumpFilename);
  const dumpPath = join(dataDir, dumpFilename);
  let db;
  try {
    await downloadProfileCsv(tempDumpPath);
    await rename(tempDumpPath, dumpPath);
    profileRefreshState.stage = '建立玩家资料索引';
    db = new DatabaseSync(tempPath);
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE profiles(profile_id TEXT PRIMARY KEY, steam_id TEXT, name TEXT NOT NULL, clan TEXT, last_match_time TEXT, country TEXT); CREATE TABLE profile_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    await importProfileCsv(db, dumpPath);
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
    await writeFile(pointerTemp, JSON.stringify({ filename: finalFilename, updatedAt, format: 'csv' }), 'utf8');
    await rename(pointerTemp, profilePointerPath);
    const previousDb = profileDb;
    const previousFilename = profileCache?.filename;
    profileDb = nextDb;
    profileCache = { filename: finalFilename, updatedAt, format: 'csv' };
    previousDb?.close();
    if (previousFilename && previousFilename !== finalFilename) await rm(join(dataDir, previousFilename), { force: true });
    await cleanupOldProfileIndexes(finalFilename);
    await cleanupProfileDumpArtifacts(finalFilename);
    await rm(dumpPath, { force: true });
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

async function startProfileCacheLifecycle() {
  await loadProfileCache();
  const age = profileCache?.updatedAt ? Date.now() - Date.parse(profileCache.updatedAt) : Infinity;
  // Respect the dump timestamp for CSV indexes so a freshly imported index
  // does not trigger an immediate replacement on the next restart.
  const delay = Number.isFinite(age) && age < profileRefreshInterval ? profileRefreshInterval - age : 0;
  profileRefreshTimer = setTimeout(async function refreshAtInterval() {
    try { await refreshProfileCache(); }
    catch (error) { console.error('玩家资料 dump 更新失败:', error.message); }
    profileRefreshTimer = setTimeout(refreshAtInterval, profileRefreshState.error ? 60 * 60_000 : profileRefreshInterval);
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
    const leaderboardValue = String(match.leaderboard || '').toLowerCase();
    const leaderboard = leaderboardValue === 'rm_1v1' ? 'RM 1v1' : leaderboardValue === 'rm_team' ? 'RM TG' : leaderboardValue === 'ew_1v1' ? 'EW 1v1' : leaderboardValue === 'ew_team' ? 'EW TG' : '';
    const players = [];
    const teams = (Array.isArray(match.teams) ? match.teams : []).map(team => {
      const members = [];
      for (const source of Array.isArray(team.players) ? team.players : []) {
        const player = {
          id: String(source.profileId), number: players.length, name: source.name || `玩家 ${source.profileId}`,
          civilization: source.civName || source.civ || '未知民族', color_hex: source.colorHex || '#84928a',
          rating: Number.isFinite(Number(source.rating)) ? Number(source.rating) : null,
          ratingDelta: Number.isFinite(Number(source.ratingDiff)) ? Number(source.ratingDiff) : null,
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
      type: leaderboard.includes('TG') ? 'TG' : leaderboard.includes('1v1') ? '1v1' : '',
      diplomacy: leaderboard.includes('1v1') ? '1v1' : leaderboard.includes('TG') ? 'TG' : '',
      rms: match.mapName || match.map || '未知地图',
      started,
      finished,
      abandoned: match.abandoned === true,
      live: Boolean(started && !finished && !match.abandoned),
      duration: started && finished && finished >= started ? finished - started : 0,
      players,
      teams
    };
  }).sort((a, b) => Number(b.started) - Number(a.started));
}

async function fetchWorldsEdgeMatchesOnce(profileId, page = 1, perPage = 100) {
  const endpoint = new URL('https://data.aoe2companion.com/api/matches');
  endpoint.searchParams.set('profile_ids', String(profileId));
  endpoint.searchParams.set('use_enums', 'true');
  endpoint.searchParams.set('page', String(page));
  endpoint.searchParams.set('per_page', String(Math.min(100, Math.max(1, perPage))));
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`AoE2 Companion 请求失败（HTTP ${response.status}）`);
      const payload = await response.json();
      const matches = normalizeCompanionMatches(payload);
      return { matches, hasMore: matches.length >= Math.min(100, Math.max(1, perPage)) };
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (attempt + 1), 4000)));
    }
  }
  throw lastError || new Error('AoE2 Companion 请求失败');
}

async function fetchLatestWorldsEdgeMatchOnce(profileId) {
  const endpoint = new URL('https://data.aoe2companion.com/api/matches');
  endpoint.searchParams.set('profile_ids', String(profileId));
  endpoint.searchParams.set('use_enums', 'true');
  endpoint.searchParams.set('page', '1');
  endpoint.searchParams.set('per_page', '1');
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', accept: 'application/json' },
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) throw new Error(`AoE2 Companion 请求失败（HTTP ${response.status}）`);
      const payload = await response.json();
      const matches = normalizeCompanionMatches(payload);
      return matches[0] || null;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (attempt + 1), 4000)));
    }
  }
  throw lastError || new Error('AoE2 Companion 请求失败');
}

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
  const response = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
      return res.end(JSON.stringify({ ...profile, cached: true, stale: false, source: 'profile-dump' }));
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': result.stale ? 'no-cache' : 'public, max-age=300' });
      return res.end(JSON.stringify({ accounts: result.profile.accounts || [], avatar: result.profile.avatar || '', cached: result.cached, stale: result.stale, source: 'aoe2recs' }));
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
      const data = await getLeaderboard(id);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '获取天梯数据失败' }));
    }
  }

  if (url.pathname === '/api/avatar') {
    let steamId = url.searchParams.get('steamId') || '';
    const profileId = url.searchParams.get('profileId') || '';
    if (!/^\d{17}$/.test(steamId) && /^\d+$/.test(profileId) && profileDb) {
      steamId = String(profileDb.prepare('SELECT steam_id AS steamId FROM profiles WHERE profile_id = ?').get(profileId)?.steamId || '');
    }
    if (!/^\d{17}$/.test(steamId)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '无效的 Steam ID' }));
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(cached));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message || '头像暂不可用' }));
    }
  }

  const relative = url.pathname === '/' || /^\/profile(?:\/\d+)?\/?$/.test(url.pathname) ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const path = normalize(join(root, 'public', relative));
  if (!path.startsWith(join(root, 'public'))) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const data = await readFile(path);
    res.writeHead(200, { 'content-type': mime[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, () => {
  console.log(`AoE2DE Ladder running at http://localhost:${port}`);
  startProfileCacheLifecycle().catch(error => console.error('启动玩家资料缓存失败:', error.message));
});







