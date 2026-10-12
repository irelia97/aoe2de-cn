import http from 'node:http';
import { readFile, open, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(root, '.cache');
const profilePointerPath = join(dataDir, 'profile-index-current.json');
const profileDumpUrl = 'https://dump.cdn.aoe2companion.com/profile.parquet';
const profileRefreshInterval = 25 * 60 * 60_000;
const port = Number(process.env.PORT || 3000);
const api = 'https://aoe-api.worldsedgelink.com/community/leaderboard/getLeaderBoard2';
const types = { 1: '1v1 死亡竞赛', 2: '团队死亡竞赛', 3: '1v1 随机地图', 4: '团队随机地图', 13: '1v1 帝国战争', 14: '团队帝国战争' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const avatarCache = new Map();
const leaderboardCache = new Map();
const leaderboardRefreshes = new Map();
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
let profileDb = null;
let profileCache = null;
let profileRefreshPromise = null;
let profileRefreshTimer = null;
const profileRefreshState = { refreshing: false, stage: '等待启动', downloadedBytes: 0, totalBytes: 0, processedRows: 0, startedAt: null, error: null };

async function fetchLeaderboard(id) {
  // The game service caps each response at 100 players, so collect ten pages.
  const pages = await Promise.all(Array.from({ length: 10 }, async (_, page) => {
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
  })).sort((a, b) => a.rank - b.rank).slice(0, 1000);
  return { leaderboardId: id, label: types[id], total: pages[0].rankTotal || rows.length, updatedAt: new Date().toISOString(), rows };
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

async function downloadProfileParquet(tempPath) {
  const response = await fetch(profileDumpUrl, { headers: { accept: 'application/vnd.apache.parquet' }, signal: AbortSignal.timeout(30 * 60_000) });
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

async function importProfileParquet(db, parquetPath) {
  profileRefreshState.stage = '读取 Parquet 并整理玩家资料';
  const file = await asyncBufferFromFile(parquetPath);
  const metadata = await parquetMetadataAsync(file);
  const availableColumns = parquetSchema(metadata).children.map(child => child.element.name);
  const aliases = {
    profile_id: ['profile_id', 'profileId'],
    steam_id: ['steam_id', 'steamId'],
    name: ['name', 'alias'],
    clan: ['clan'],
    last_match_time: ['last_match_time', 'lastMatchTime', 'last_match_date'],
    country: ['country']
  };
  const columnMap = Object.fromEntries(Object.entries(aliases).map(([target, names]) => [target, names.find(name => availableColumns.includes(name))]));
  const requiredColumns = ['profile_id', 'name'];
  const missing = requiredColumns.filter(name => !columnMap[name]);
  if (missing.length) throw new Error(`Profile Parquet 缺少必要字段：${missing.join(', ')}`);
  const selectedColumns = [...new Set(Object.values(columnMap).filter(Boolean))];
  const requiredTargets = Object.keys(columnMap).filter(target => columnMap[target]);
  const insert = db.prepare('INSERT OR REPLACE INTO profiles(profile_id, steam_id, name, clan, last_match_time, country) VALUES (?, ?, ?, ?, ?, ?)');
  const pendingRows = new Map();
  let batchRows = 0;
  let parseError = null;
  db.exec('BEGIN');
  const readRange = async (rowStart, rowEnd) => parquetRead({ file, metadata, columns: selectedColumns, compressors, rowStart, rowEnd, onChunk: ({ columnName, columnData, rowStart: chunkStart }) => {
    if (parseError) return;
    const target = Object.keys(columnMap).find(key => columnMap[key] === columnName);
    if (!target) return;
    try {
      for (let i = 0; i < columnData.length; i += 1) {
        const index = chunkStart + i;
        let row = pendingRows.get(index);
        if (!row) { row = Object.create(null); pendingRows.set(index, row); }
        row[target] = columnData[i];
        if (requiredTargets.every(key => Object.hasOwn(row, key))) {
          const profileId = row.profile_id == null ? '' : String(row.profile_id);
          const name = row.name == null ? '' : String(row.name);
          if (/^\d+$/.test(profileId) && name) {
            insert.run(profileId, row.steam_id == null ? '' : String(row.steam_id), name, row.clan == null ? '' : String(row.clan), row.last_match_time == null ? '' : String(row.last_match_time), row.country == null ? '' : String(row.country));
            profileRefreshState.processedRows += 1;
            batchRows += 1;
            if (batchRows >= 20_000) { db.exec('COMMIT; BEGIN'); batchRows = 0; }
          }
          pendingRows.delete(index);
        }
      }
    } catch (error) { parseError = error; }
  } });
  let rowStart = 0;
  for (const rowGroup of metadata.row_groups || []) {
    const rowEnd = rowStart + Number(rowGroup.num_rows || 0);
    await readRange(rowStart, rowEnd);
    if (parseError) break;
    if (pendingRows.size) throw new Error(`Parquet 字段未能对齐：剩余 ${pendingRows.size} 条记录`);
    rowStart = rowEnd;
  }
  if (parseError) throw parseError;
  if (pendingRows.size) throw new Error(`Parquet 字段未能对齐：剩余 ${pendingRows.size} 条记录`);
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
    profileRefreshState.stage = '资料索引已就绪';
    await cleanupOldProfileIndexes(filename);
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
  let db;
  try {
    await downloadProfileParquet(tempDumpPath);
    await rename(tempDumpPath, dumpPath);
    profileRefreshState.stage = '建立玩家资料索引';
    db = new DatabaseSync(tempPath);
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE profiles(profile_id TEXT PRIMARY KEY, steam_id TEXT, name TEXT NOT NULL, clan TEXT, last_match_time TEXT, country TEXT); CREATE TABLE profile_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    await importProfileParquet(db, dumpPath);
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
    await cleanupOldProfileIndexes(finalFilename);
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
  const delay = profileCache?.format === 'parquet' && age < profileRefreshInterval ? profileRefreshInterval - age : 0;
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
  results.sort((a, b) => Number(Boolean(b.clan?.trim())) - Number(Boolean(a.clan?.trim()))
    || (b.rating ?? -1) - (a.rating ?? -1)
    || b.matchQuality - a.matchQuality
    || a.matchPosition - b.matchPosition
    || a.matchLengthDifference - b.matchLengthDifference
    || b.lastMatchTimestamp - a.lastMatchTimestamp
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
    const steamId = url.searchParams.get('steamId') || '';
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
