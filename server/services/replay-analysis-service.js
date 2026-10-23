import { mkdir, readFile, writeFile, rename, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

export const replayCacheTtl = 30 * 60 * 1000;
const maxDownloadSize = 64 * 1024 * 1024;

export async function downloadReplayWithFallback(download, profileId, loadPlayers) {
  try { return await download(String(profileId)); }
  catch (error) {
    if (error.status !== 404) throw error;
    const ids = await loadPlayers().catch(() => []);
    for (const id of [...new Set(ids.map(String))].filter(id => /^[1-9]\d{0,15}$/.test(id) && id !== String(profileId)).slice(0, 7)) {
      try { return await download(id); }
      catch (fallbackError) { if (fallbackError.status !== 404) throw fallbackError; }
    }
    throw new Error('录像下载失败（HTTP 404）：当前可查询玩家的录像均不可用，可能尚未上传、未保存或已过期');
  }
}

export function createReplayAnalysisService({ cacheDir, assetsDir, fetchImpl = fetch, now = Date.now }) {
  const pending = new Map();
  const matchInfoCache = new Map();
  const pendingMatchInfo = new Map();
  let lastCleanup = 0;

  async function cleanup() {
    if (now() - lastCleanup < 60000) return;
    lastCleanup = now();
    const entries = await readdir(cacheDir);
    const files = await Promise.all(entries.filter(name => /^v[123456]-\d+-\d+\.json\.gz$/.test(name)).map(async name => ({ name, info: await stat(join(cacheDir, name)).catch(() => null) })));
    files.sort((a, b) => (b.info?.mtimeMs || 0) - (a.info?.mtimeMs || 0));
    await Promise.all(files.filter((file, index) => file.info && (now() - file.info.mtimeMs >= replayCacheTtl || index >= 128)).map(file => rm(join(cacheDir, file.name), { force: true })));
  }

  async function getMatchInfo(matchId) {
    if (!/^[1-9]\d{0,15}$/.test(String(matchId))) throw new Error('无效的比赛 ID');
    const key = String(matchId);
    const cached = matchInfoCache.get(key);
    if (cached && now() - cached.savedAt < replayCacheTtl) return cached.data;
    if (pendingMatchInfo.has(key)) return pendingMatchInfo.get(key);
    if (pendingMatchInfo.size >= 8) throw new Error('对局信息查询繁忙，请稍后重试');
    const task = (async () => {
      const response = await fetchImpl(`https://data.aoe2companion.com/api/matches/${key}`, {
        headers: { 'user-agent': 'AOE2DE-CN/1.0', accept: 'application/json' }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('暂时无法读取对局信息');
      const payload = await response.json();
      if (String(payload.matchId) !== key) throw new Error('对局信息不匹配');
      const started = Date.parse(payload.started);
      const players = (Array.isArray(payload.teams) ? payload.teams : []).flatMap(team => Array.isArray(team.players) ? team.players : []);
      const results = payload.finished && players.some(player => player.won === true)
        ? players.filter(player => player.profileId != null && typeof player.won === 'boolean').map(player => ({ profileId: String(player.profileId), won: player.won }))
        : [];
      const data = { matchId: key, started: Number.isFinite(started) ? Math.floor(started / 1000) : null, profileIds: players.filter(p => p.profileId != null).map(p => String(p.profileId)), server: typeof payload.server === 'string' ? payload.server : '', results };
      matchInfoCache.delete(key);
      matchInfoCache.set(key, { data, savedAt: now() });
      if (matchInfoCache.size > 128) matchInfoCache.delete(matchInfoCache.keys().next().value);
      return data;
    })();
    pendingMatchInfo.set(key, task);
    try { return await task; } finally { pendingMatchInfo.delete(key); }
  }

  async function downloadOne(matchId, profileId) {
    const response = await fetchImpl(`https://api.ageofempires.com/api/GameStats/AgeII/GetMatchReplay/?matchId=${matchId}&profileId=${profileId}`, {
      headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' }, signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(`录像下载失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    if (Number(response.headers.get('content-length')) > maxDownloadSize) {
      await response.body?.cancel();
      throw new Error('录像文件过大');
    }
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      if (size > maxDownloadSize) throw new Error('录像文件过大');
      parts.push(part);
    }
    if (size < 16) throw new Error('录像接口未返回有效文件，录像可能已过期');
    return Buffer.concat(parts, size);
  }

  function download(matchId, profileId) {
    return downloadReplayWithFallback(id => downloadOne(matchId, id), profileId,
      async () => (await getMatchInfo(matchId)).profileIds || []);
  }

  function analyze(bytes, metadata) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./replay-analysis-worker.js', import.meta.url), {
        workerData: { bytes, metadata, assetsDir }, resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('录像解析超时，请稍后重试')); }, 90000);
      worker.once('message', message => {
        clearTimeout(timeout);
        if (message.error) reject(new Error(`录像解析失败：${message.error}`));
        else resolve(Buffer.from(message.data));
        worker.terminate();
      });
      worker.once('error', error => { clearTimeout(timeout); reject(error); });
      worker.once('exit', code => { clearTimeout(timeout); if (code !== 0) reject(new Error('录像解析进程退出，请稍后重试')); });
    });
  }

  async function get(matchId, profileId) {
    if (!/^[1-9]\d{0,15}$/.test(String(matchId)) || !/^[1-9]\d{0,15}$/.test(String(profileId))) throw new Error('无效的比赛或玩家 ID');
    const key = `v6-${matchId}-${profileId}`;
    await mkdir(cacheDir, { recursive: true });
    const path = join(cacheDir, `${key}.json.gz`);
    try {
      const info = await stat(path);
      if (now() - info.mtimeMs < replayCacheTtl) return { data: await readFile(path), cached: true };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pending.has(key)) return pending.get(key);
    if (pending.size >= 2) throw new Error('录像分析繁忙，请稍后重试');
    const task = (async () => {
      await cleanup();
      const [bytes, matchInfo] = await Promise.all([download(matchId, profileId), getMatchInfo(matchId).catch(() => null)]);
      const generatedAt = now();
      const data = await analyze(bytes, { matchId: String(matchId), profileId: String(profileId), matchInfo, generatedAt, expiresAt: generatedAt + replayCacheTtl });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, data);
      await rename(temporary, path);
      return { data, cached: false };
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }

  return { get, getMatchInfo };
}
