import { mkdir, readFile, readdir, rename, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const AVATAR_TTL = 24 * 60 * 60_000;

export function createAvatarCache({ directory, resolveUrl, fetchImage = fetch, now = Date.now }) {
  const entries = new Map();
  const pending = new Map();
  const retryAt = new Map();
  const counters = { hits: 0, misses: 0, staleHits: 0, refreshes: 0, failures: 0, evictions: 0, diskBytes: 0 };
  let maintenance = null;
  const ready = (async () => {
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (/^(steam|profile):\d+$/.test(entry.key) && /^[a-f0-9]{64}$/.test(entry.hash)
          && Number.isFinite(entry.updatedAt) && Number.isFinite(entry.expires)) {
          await stat(join(directory, entry.hash));
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
      if (!(retryAt.get(key) > now())) refresh(key).catch(() => {});
      return entry;
    }
    if (retryAt.get(key) > now()) throw new Error('头像暂时不可用，请稍后重试');
    counters.misses++;
    return refresh(key);
  }
  async function refreshDue() {
    if (maintenance) return maintenance;
    maintenance = (async () => {
      await ready;
      // Spread upstream requests rather than fetching every cached player at once.
      for (const [key, entry] of entries) {
        if (entry.expires <= now() && !(retryAt.get(key) > now())) await refresh(key).catch(() => {});
      }
      // A full day of grace keeps existing browser references valid after a refresh.
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
    get, refreshDue, ready, close: () => clearInterval(timer),
    stats: () => ({ ...counters, entries: entries.size, pending: pending.size, ttlHours: 24 }),
    async image(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      await ready;
      try { return await readFile(join(directory, hash)); } catch { return null; }
    }
  };
}
