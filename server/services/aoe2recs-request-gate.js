// Shared by every AoE2Recs consumer in the website process.
export function createAoE2RecsRequestGate({ request, readState = async () => null, saveState = async () => {}, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), intervalMs = 3_000,
  baseCooldownMs = 15 * 60_000, maxCooldownMs = 6 * 60 * 60_000, maxPending = 32 }) {
  let failures = 0, blockedUntil = 0, pausedUntil = 0, nextAt = 0, running = false;
  const pending = new Map(), queue = [];
  const ready = Promise.resolve().then(readState).then(state => {
    pausedUntil = Math.max(0, Number(state?.pausedUntil) || 0);
    failures = Math.min(16, Math.max(0, Number(state?.failures) || 0));
    blockedUntil = Math.min(now() + maxCooldownMs, Number(state?.blockedUntil) || 0);
    nextAt = Math.min(now() + intervalMs, Number(state?.nextAt) || 0);
  }).catch(error => console.warn('[aoe2recs] cooldown state read failed:', error.message));
  const unavailable = () => Object.assign(new Error('AoE2Recs 暂停请求，稍后重试'), { retryAt: Math.max(blockedUntil, pausedUntil) });
  async function persist() {
    try { await saveState({ failures, blockedUntil, pausedUntil, nextAt }); }
    catch (error) { console.warn('[aoe2recs] cooldown state save failed:', error.message); }
  }
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (now() < Math.max(blockedUntil, pausedUntil)) {
          for (const job of queue.splice(0)) { pending.delete(job.id); job.reject(unavailable()); }
          break;
        }
        await sleep(Math.max(0, nextAt - now()));
        const job = queue.shift();
        try {
          const result = await request(job.id);
          failures = 0;
          blockedUntil = 0;
          nextAt = now() + intervalMs;
          await persist();
          pending.delete(job.id);
          job.resolve(result);
        } catch (error) {
          if (error.code === 'AOE2RECS_PROFILE_UNAVAILABLE') {
            // A response about one account is not a service/connection failure.
            failures = 0;
            blockedUntil = 0;
            nextAt = now() + intervalMs;
            await persist();
            pending.delete(job.id);
            job.reject(error);
            continue;
          }
          failures = Math.min(16, failures + 1);
          blockedUntil = now() + Math.min(maxCooldownMs, baseCooldownMs * 2 ** (failures - 1));
          nextAt = blockedUntil;
          await persist();
          pending.delete(job.id);
          job.reject(error);
          // Discard the backlog on failure; it must not become a retry storm.
          for (const waiting of queue.splice(0)) { pending.delete(waiting.id); waiting.reject(unavailable()); }
          console.warn(`[aoe2recs] request failed; paused until ${new Date(blockedUntil).toISOString()}`);
        }
      }
    } finally { running = false; }
  }
  return async function fetchProfile(id) {
    await ready;
    id = String(id);
    if (now() < Math.max(blockedUntil, pausedUntil)) throw unavailable();
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= maxPending) throw new Error('AoE2Recs 请求队列已满，保留已有资料');
    const result = new Promise((resolve, reject) => queue.push({ id, resolve, reject }));
    pending.set(id, result);
    void drain();
    return result;
  };
}
