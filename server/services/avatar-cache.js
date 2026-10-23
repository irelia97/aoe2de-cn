import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const AVATAR_TTL = 24 * 60 * 60_000;

export function createAvatarCache({ directory, resolveUrl, fetchImage = fetch, now = Date.now }) {
  const entries = new Map();
  const pending = new Map();
  const retryAt = new Map();
  const ready = (async () => {
    await mkdir(directory, { recursive: true });
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const entry = JSON.parse(await readFile(join(directory, name), 'utf8'));
        if (/^(steam|profile):\d+$/.test(entry.key) && /^[a-f0-9]{64}$/.test(entry.hash)
          && Number.isFinite(entry.updatedAt) && Number.isFinite(entry.expires)) {
          await readFile(join(directory, entry.hash));
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
        entries.set(key, entry);
        retryAt.delete(key);
        return entry;
      } catch (error) {
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
    if (entry?.expires > now() || (entry && retryAt.get(key) > now())) return entry;
    return refresh(key);
  }
  async function refreshDue() {
    await ready;
    // Spread upstream requests rather than fetching every cached player at once.
    for (const [key, entry] of entries) {
      if (entry.expires <= now() && !(retryAt.get(key) > now())) await refresh(key).catch(() => {});
    }
  }
  const timer = setInterval(() => { refreshDue().catch(() => {}); }, 60_000);
  timer.unref();
  return {
    get, refreshDue, ready, close: () => clearInterval(timer),
    async image(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      await ready;
      try { return await readFile(join(directory, hash)); } catch { return null; }
    }
  };
}
