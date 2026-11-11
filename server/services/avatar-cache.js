import { mkdir, readFile, readdir, rename, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const AVATAR_TTL = 15 * 24 * 60 * 60_000;

export function createAvatarCache({ directory, resolveUrl, fetchImage = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const entries = new Map();
  const pending = new Map();
  const retryAt = new Map();
  const attemptedDay = new Map();
  const counters = { hits: 0, misses: 0, staleHits: 0, refreshes: 0, failures: 0, evictions: 0, diskBytes: 0 };
  let maintenance = null;
  const dayKey = () => new Date(now() + 8 * 60 * 60_000).toISOString().slice(0,10);
  const ready = (async () => {
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (/^(steam|profile):\d+$/.test(entry.key) && /^[a-f0-9]{64}$/.test(entry.hash)
          && Number.isFinite(entry.updatedAt) && Number.isFinite(entry.expires)) {
          await stat(join(directory, entry.hash));
          entry.expires = entry.updatedAt + AVATAR_TTL;
          entries.set(entry.key, entry);
        }
      } catch {}
    }
  })();
  async function refresh(key) {
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const source = new URL(await resolveUrl(key));
        if (source.protocol !== 'https:' || !source.hostname.endsWith('.steamstatic.com')) throw new Error('头像地址不可用');
        const response = await fetchImage(source.href, { signal: AbortSignal.timeout(15000), redirect: 'error' });
        if (!response.ok) throw new Error(`头像返回 HTTP ${response.status}`);
        const type = response.headers.get('content-type')?.split(';')[0];
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) throw new Error('头像格式不可用');
        if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('头像文件过大');
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('头像文件过大'); }
          chunks.push(value);
        }
        if (!size) throw new Error('头像文件为空');
        const bytes = Buffer.concat(chunks);
        const hash = createHash('sha256').update(bytes).digest('hex');
        const updatedAt = now();
        const entry = { key, hash, type, updatedAt, expires: updatedAt + AVATAR_TTL };
        await writeFile(join(directory, hash), bytes);
        const metadata = join(directory, `${key.replace(':', '-')}.json`);
        await writeFile(`${metadata}.tmp`, JSON.stringify(entry));
        await rename(`${metadata}.tmp`, metadata);
        const previous = entries.get(key);
        if (previous && previous.hash !== hash) await utimes(join(directory, previous.hash), new Date(now()), new Date(now())).catch(() => {});
        entries.set(key, entry);
        counters.refreshes++;
        retryAt.delete(key);
        return entry;
      } catch (error) {
        counters.failures++;
        retryAt.set(key, now() + 5 * 60_000);
        if (entries.has(key)) return entries.get(key);
        throw error;
      } finally { pending.delete(key); }
    })();
    pending.set(key, task);
    return task;
  }
  async function get(key) {
    await ready;
    const entry = entries.get(key);
    if (entry?.expires > now()) { counters.hits++; return entry; }
    if (entry) {
      counters.staleHits++;
      return entry;
    }
    if (pending.has(key)) return pending.get(key);
    if (attemptedDay.get(key) === dayKey() || retryAt.get(key) > now()) throw new Error('头像今日暂不可用，明日统一更新时重试');
    counters.misses++;
    attemptedDay.set(key, dayKey());
    return refresh(key);
  }
  async function peek(key) {
    await ready;
    return entries.get(key) || null;
  }
  async function prewarm(keys, gapMs = 1000, concurrency = 1) {
    await ready;
    const today = dayKey();
    let refreshed = 0, skipped = 0, failed = 0;
    const queue = [];
    for (const key of [...new Set(keys)].filter(value => /^(steam|profile):\d+$/.test(value))) {
      const entry = entries.get(key);
      const updatedDay = entry ? new Date(entry.updatedAt + 8 * 60 * 60_000).toISOString().slice(0,10) : '';
      if (updatedDay === today || attemptedDay.get(key) === today) { skipped++; continue; }
      queue.push(key);
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const key = queue[cursor++];
        attemptedDay.set(key, today);
        try { await refresh(key); refreshed++; } catch { failed++; }
        if (gapMs > 0) await sleep(gapMs);
      }
    };
    await Promise.all(Array.from({ length:Math.min(Math.max(1, Number(concurrency) || 1), queue.length || 1) }, worker));
    return { total:new Set(keys).size, refreshed, skipped, failed, day:today };
  }
  async function refreshDue() {
    if (maintenance) return maintenance;
    maintenance = (async () => {
      await ready;
      // Leaderboard avatars are refreshed by the daily prewarm job. Maintenance
      // only cleans files so it cannot create a second upstream request that day.
      // A full cache lifetime of grace keeps existing browser references valid after a refresh.
      const referenced = new Set([...entries.values()].map(entry => entry.hash));
      let bytes = 0;
      for (const name of await readdir(directory)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue;
        const path = join(directory, name), info = await stat(path).catch(() => null);
        if (!info) continue;
        if (!referenced.has(name) && !pending.size && now() - info.mtimeMs > AVATAR_TTL) {
          await rm(path, { force: true }); counters.evictions++;
        } else bytes += info.size;
      }
      counters.diskBytes = bytes;
      for (const [key, at] of retryAt) if (at <= now()) retryAt.delete(key);
    })();
    try { await maintenance; } finally { maintenance = null; }
  }
  const timer = setInterval(() => { refreshDue().catch(() => {}); }, 60_000);
  timer.unref();
  return {
    get, peek, prewarm, refreshDue, ready, close: () => clearInterval(timer),
    stats: () => ({ ...counters, entries: entries.size, pending: pending.size, ttlHours: AVATAR_TTL / (60 * 60_000) }),
    async image(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      await ready;
      try { return await readFile(join(directory, hash)); } catch { return null; }
    }
  };
}
