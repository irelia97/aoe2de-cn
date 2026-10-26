import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const replayPaths = new Set(['/api/replay-analysis', '/api/replay-analysis/status', '/api/replay-match-info', '/api/match-replay']);
const profilePaths = new Set(['/api/feedback/like', '/api/profile-matches', '/api/profile-details', '/api/profile-accounts', '/api/profile-leaderboards', '/api/avatar', '/api/civilization-stats', '/api/civilization-stats/meta']);
const automatedAgent = /bot\b|crawler|spider|slurp|bingpreview|headlesschrome|python-requests|python-urllib|curl\//i;

export function createApiProtection({ now = Date.now, maxEntries = 10000, statePath = null } = {}) {
  const visitors = new Map();
  const activeIps = new Map();
  let activeHeavy = 0, activeAnalysis = 0, nextCleanup = 0;
  const stats = { bot: 0, source: 0, rate: 0, concurrency: 0 };
  let saving = Promise.resolve(), saveTimer;
  if (statePath) {
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8'));
      for (const [key, entry] of saved.slice(0, maxEntries)) {
        if (typeof key === 'string' && entry && ['minuteStart', 'minuteCount', 'hourStart', 'hourCount'].every(field => Number.isFinite(entry[field]) && entry[field] >= 0)
          && now() - entry.hourStart < 3600000) visitors.set(key, entry);
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('[api-protection] cannot restore quota:', error.message); }
  }
  function persist() {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; flush().catch(error => console.error('[api-protection] save:', error.message)); }, 200);
    saveTimer.unref?.();
  }
  function flush() {
    if (!statePath) return Promise.resolve();
    const data = JSON.stringify([...visitors]);
    saving = saving.catch(() => {}).then(async () => {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(`${statePath}.tmp`, data, { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
    });
    return saving;
  }
  function deny(res, status, reason, message, retryAfter = 0) {
    stats[reason]++;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      ...(retryAfter ? { 'retry-after': String(retryAfter) } : {}) });
    res.end(JSON.stringify({ error: message }));
    return false;
  }
  function sameOrigin(req, value) {
    try { return new URL(value).host === req.headers.host; } catch { return false; }
  }
  return {
    flush,
    stats: () => ({ ...stats, activeHeavy, activeAnalysis, trackedClients: visitors.size }),
    allow(req, res, pathname, ip, internal = false) {
      if (!pathname.startsWith('/api/')) return true;
      res.setHeader('x-robots-tag', 'noindex, nofollow');
      if (internal || (!replayPaths.has(pathname) && !profilePaths.has(pathname))) return true;
      if (automatedAgent.test(String(req.headers['user-agent'] || ''))) {
        return deny(res, 403, 'bot', '自动抓取不可访问此接口');
      }
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      if ((site && site !== 'same-origin') || (origin && !sameOrigin(req, origin))) {
        return deny(res, 403, 'source', '请从本站页面访问');
      }
      if (replayPaths.has(pathname)) {
        const validSource = pathname === '/api/match-replay'
          ? sameOrigin(req, req.headers.referer)
          : req.headers['x-aoe2-client'] === 'web';
        if (!validSource) return deny(res, 403, 'source', '请刷新本站页面后重试');
        if (pathname === '/api/replay-analysis' && req.method === 'POST'
          && (!sameOrigin(req, req.headers.origin) || !sameOrigin(req, req.headers.referer))) {
          return deny(res, 403, 'source', '请从本站录像页面开始分析');
        }
      }
      const timestamp = now();
      if (timestamp >= nextCleanup) {
        for (const [key, entry] of visitors) if (timestamp - entry.hourStart >= 3600000) visitors.delete(key);
        nextCleanup = timestamp + 60000;
      }
      const bucket = pathname === '/api/replay-analysis' && req.method === 'GET' ? 'cache'
        : pathname === '/api/replay-analysis/status' ? 'poll'
        : pathname === '/api/replay-match-info' ? 'metadata' : replayPaths.has(pathname) ? 'replay' : 'profile';
      const key = `${createHash('sha256').update(ip).digest('hex')}:${bucket}`;
      let entry = visitors.get(key);
      if (!entry) {
        if (visitors.size >= maxEntries) return deny(res, 429, 'rate', '访问繁忙，请稍后重试', 60);
        entry = { minuteStart: timestamp, minuteCount: 0, hourStart: timestamp, hourCount: 0 };
        visitors.set(key, entry);
      }
      if (timestamp - entry.minuteStart >= 60000) { entry.minuteStart = timestamp; entry.minuteCount = 0; }
      if (timestamp - entry.hourStart >= 3600000) { entry.hourStart = timestamp; entry.hourCount = 0; }
      const limits = bucket === 'replay' ? [2, 10] : ['metadata','cache'].includes(bucket) ? [30, 120] : bucket === 'poll' ? [120, 3600] : [120, 600];
      const wait = entry.minuteCount >= limits[0] ? entry.minuteStart + 60000 - timestamp
        : entry.hourCount >= limits[1] ? entry.hourStart + 3600000 - timestamp : 0;
      if (wait > 0) {
        const seconds = Math.ceil(wait / 1000);
        const message = bucket === 'replay'
          ? `录像分析/下载请求过于频繁（每分钟最多2次、每小时最多10次），请${seconds}秒后重试`
          : `访问过于频繁，请${seconds}秒后重试`;
        return deny(res, 429, 'rate', message, seconds);
      }
      entry.minuteCount++; entry.hourCount++;
      if (bucket === 'replay') {
        let global = visitors.get('global:replay');
        if (!global) { global = { minuteStart: timestamp, hourStart: timestamp, minuteCount: 0, hourCount: 0 }; visitors.set('global:replay', global); }
        if (timestamp - global.minuteStart >= 60000) { global.minuteStart = timestamp; global.minuteCount = 0; }
        if (timestamp - global.hourStart >= 3600000) { global.hourStart = timestamp; global.hourCount = 0; }
        if (global.minuteCount >= 12 || global.hourCount >= 120) {
          persist();
          return deny(res, 429, 'rate', '全站录像请求较多，请60秒后重试', 60);
        }
        global.minuteCount++; global.hourCount++;
      }
      persist();
      const heavy = (pathname === '/api/replay-analysis' && req.method !== 'GET') || pathname === '/api/match-replay';
      if (heavy) {
        const analysis = pathname === '/api/replay-analysis';
        // Keep one of the replay service's two worker slots for automatic summaries.
        if ((activeIps.get(ip) || 0) >= 1 || activeHeavy >= 2 || (analysis && activeAnalysis >= 1)) {
          return deny(res, 429, 'concurrency', '录像处理繁忙，请稍后重试', 5);
        }
        activeIps.set(ip, (activeIps.get(ip) || 0) + 1);
        activeHeavy++; if (analysis) activeAnalysis++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          activeIps.delete(ip); activeHeavy--; if (analysis) activeAnalysis--;
        };
        res.releaseApiProtection = release;
        res.once('finish', release);
        // A disconnected client may leave its upstream download running. Hold
        // the slot until the handler ends its response, rather than close alone.
        const end = res.end;
        res.end = function (...args) {
          try { return end.apply(this, args); } finally { release(); }
        };
      }
      return true;
    }
  };
}
