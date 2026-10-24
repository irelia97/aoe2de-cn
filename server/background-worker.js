import http from 'node:http';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { createUpstreamGateway } from './services/upstream-gateway.js';
import { safeHttpHandler } from './services/http-safety.js';
import { streamResponse } from './services/response-stream.js';
import { createReplayAnalysisService, createReplayCacheState } from './services/replay-analysis-service.js';
import { createReplayJobs } from './services/replay-jobs.js';
import { createDirectDanmakuClient } from './services/direct-danmaku-client.js';
import { createRealtimeDanmakuNotifier } from './services/realtime-danmaku-notifier.js';
import { createReplayEndedNotifier } from './services/replay-ended-notifier.js';
import { queueDanmakuMatch } from './services/danmaku-outbox.js';

const root = fileURLToPath(new URL('../', import.meta.url)), cacheDir = join(root, '.cache');
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
const gateway = createUpstreamGateway();
const replayOptions = { cacheDir: join(cacheDir, 'replay-analysis'), assetsDir: join(root, 'public/assets/aoe2rec'), shared: createReplayCacheState() };
const replay = createReplayAnalysisService({ ...replayOptions, fetchImpl: gateway.fetch });
const automaticReplay = createReplayAnalysisService({ ...replayOptions, fetchImpl: (url, options) => gateway.fetch(url, { ...options, priority: 10 }) });
const jobs = createReplayJobs({ replayService: replay });
const direct = createDirectDanmakuClient({ pythonExecutable: process.platform === 'win32'
  ? join(root, '.venv-danmaku/Scripts/python.exe') : join(root, '.venv-danmaku/bin/python'),
  scriptPath: join(root, 'tools/douyu_auto_send.py'), room: '753676', statePath: join(cacheDir, 'danmaku/douyu_storage_state.json') });
const notifier = createRealtimeDanmakuNotifier({ residentSender: direct,
  statePath: join(cacheDir, 'danmaku/realtime-match-added.json'), readFile, writeFile, renameFile: rename,
  watchers: [{ profileId: '197964', platform: 'douyu', room: '753676' }] });
const ended = createReplayEndedNotifier({ statePath: join(cacheDir, 'danmaku/replay-ended.json'), profileIds: ['197964'],
  replayService: automaticReplay, prepare: notifier.prepareMatchEnded, cancelPreparation: notifier.cancelPreparedEnd,
  send: notifier.handleMatchEnded, fetchImpl: (url, options) => gateway.fetch(url, { ...options, priority: 10 }) });
const outbox = join(cacheDir, 'danmaku/events');
let scanning = false;
async function scanOutbox() {
  if (scanning) return;
  scanning = true;
  try {
    await mkdir(outbox, { recursive: true, mode: 0o700 });
    for (const file of (await readdir(outbox)).filter(name => /^\d+\.json$/.test(name))) {
      const path = join(outbox, file);
      const match = JSON.parse(await readFile(path, 'utf8'));
      await ended.observe(match);
      // Skip delayed openings after downtime, but keep watching their endings.
      if (Date.now() / 1000 - Number(match.started) < 120) await notifier.handleMatchAdded(match);
      await rm(path, { force: true });
    }
  } catch (error) { console.error('[background] outbox:', error.message); }
  finally { scanning = false; }
}

const server = http.createServer(safeHttpHandler(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:3001');
  const json = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  if (url.pathname === '/health') return json(200, { ok: true, uptime: process.uptime(), jobs: jobs.stats(), replayCache: replay.stats(), upstream: gateway.stats() });
  if (url.pathname === '/notifications' && req.method === 'POST') {
    let text = '';
    for await (const chunk of req) { text += chunk; if (text.length > 256 * 1024) return json(413, { error: '消息过大' }); }
    await queueDanmakuMatch(outbox, JSON.parse(text));
    scanOutbox().catch(error => console.error('[background]', error.message)); return json(202, { queued: true });
  }
  if (url.pathname === '/upstream') {
    const disconnected = new AbortController();
    res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
    const response = await gateway.fetch(url.searchParams.get('url'), { signal: AbortSignal.any([AbortSignal.timeout(65000), disconnected.signal]),
      priority: Number(req.headers['x-upstream-priority']) || 0,
      headers: { 'user-agent': req.headers['x-upstream-user-agent'] || 'AOE2DE-CN/1.0', accept: req.headers['x-upstream-accept'] || 'application/json' } });
    return streamResponse(response, res);
  }
  if (url.pathname === '/replay/info') return json(200, await replay.getMatchInfo(url.searchParams.get('matchId')));
  if (url.pathname === '/replay/jobs' && req.method === 'POST') return json(202, jobs.submit(url.searchParams.get('matchId'), url.searchParams.get('profileId')));
  if (url.pathname.startsWith('/replay/jobs/')) {
    const job = jobs.get(url.pathname.slice('/replay/jobs/'.length));
    if (!job) return json(404, { error: '分析任务不存在，请重新分析' });
    if (job.state === 'failed') return json(502, { error: job.error });
    if (job.state === 'running') return json(202, { jobId: job.id, state: job.state });
    const [matchId, profileId] = job.key.split(':');
    const result = await replay.readCached(matchId, profileId);
    if (!result) return json(410, { error: '分析缓存已过期，请重新分析' });
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'cache-control': 'no-store', 'x-replay-cache': job.cached ? 'HIT' : 'MISS' });
    return res.end(result.data);
  }
  if (url.pathname === '/replay/download') {
    const matchId = url.searchParams.get('matchId'), profileId = url.searchParams.get('profileId');
    if (!/^[1-9]\d{0,15}$/.test(matchId) || !/^[1-9]\d{0,15}$/.test(profileId)) return json(400, { error: '无效的比赛或玩家 ID' });
    const response = await gateway.fetch(`https://api.ageofempires.com/api/GameStats/AgeII/GetMatchReplay/?matchId=${matchId}&profileId=${profileId}`,
      { signal: AbortSignal.timeout(60000), headers: { accept: '*/*' } });
    return streamResponse(response, res, { headers: { 'content-disposition': `attachment; filename="aoe2-match-${matchId}.zip"` } });
  }
  return json(404, { error: 'Not found' });
}));
server.requestTimeout = 30000; server.headersTimeout = 15000;
server.listen(Number(process.env.BACKGROUND_PORT || 3001), '127.0.0.1', () => console.log('[background] ready on loopback'));
const scanTimer = setInterval(() => scanOutbox(), 1000);
const cacheTimer = setInterval(() => replay.cleanup().catch(error => console.warn('[replay-cache]', error.message)), 60000);
cacheTimer.unref();
mkdir(replayOptions.cacheDir, { recursive: true }).then(() => replay.cleanup()).catch(error => console.warn('[replay-cache]', error.message));
scanTimer.unref();
process.on('SIGTERM', () => { ended.stop(); clearInterval(scanTimer); clearInterval(cacheTimer); server.close(); });
scanOutbox();
