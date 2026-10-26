import { Worker } from 'node:worker_threads';
import { stat } from 'node:fs/promises';

export function parseCivilizationFilters(params) {
  const mode = params.get('mode') || 'rm_1v1';
  if (!['rm_1v1', 'rm_team'].includes(mode)) throw Object.assign(new Error('比赛类型无效'), { statusCode: 400 });
  const integer = (name, minimum, maximum) => {
    const raw = params.get(name);
    if (raw == null || raw === '' || raw === 'all') return null;
    if (!/^-?\d+$/.test(raw) || Number(raw) < minimum || Number(raw) > maximum) {
      throw Object.assign(new Error('筛选条件无效'), { statusCode: 400 });
    }
    return Number(raw);
  };
  const civ = params.get('civ') || '';
  if (civ && !/^[a-z0-9_-]{1,40}$/.test(civ)) throw Object.assign(new Error('民族筛选无效'), { statusCode: 400 });
  return { mode, map: integer('map', 1, 10000), elo: integer('elo', 0, mode === 'rm_team' ? 4 : 6), duration: integer('duration', 1, 4), civ };
}

export function createCivilizationStats({ path, now = Date.now }) {
  let worker, nextId = 0;
  const pending = new Map(), cache = new Map();
  function start() {
    const current = new Worker(new URL('./civilization-stats-worker.js', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    worker = current;
    current.on('message', ({ id, data, error, statusCode }) => {
      const job = pending.get(id); if (!job) return;
      pending.delete(id); clearTimeout(job.timer);
      if (!pending.size) current.unref();
      if (error) job.reject(Object.assign(new Error(error), { statusCode })); else job.resolve(data);
    });
    const fail = error => {
      if (worker === current) worker = null;
      for (const [id, job] of pending) {
        if (job.worker !== current) continue;
        pending.delete(id); clearTimeout(job.timer); job.reject(error);
      }
    };
    current.on('error', fail);
    current.on('exit', () => fail(new Error('统计查询已中断，请稍后重试')));
    current.unref(); return current;
  }
  async function query(kind, filters = {}) {
    let stamp;
    try { stamp = (await stat(path)).mtimeMs; }
    catch { throw Object.assign(new Error('民族数据正在准备，请稍后重试'), { statusCode: 503 }); }
    const key = JSON.stringify([stamp, kind, filters]);
    const cached = cache.get(key);
    if (cached && (cached.pending || cached.expires > now())) return cached.promise;
    if (pending.size >= 8) throw Object.assign(new Error('统计查询繁忙，请稍后重试'), { statusCode: 429 });
    const current = worker || start(), id = ++nextId;
    const promise = new Promise((resolve, reject) => {
      current.ref();
      const timer = setTimeout(() => current.terminate(), 8000);
      pending.set(id, { resolve, reject, timer, worker: current });
      current.postMessage({ id, path, stamp, kind, filters });
    });
    const entry = { promise, pending: true, expires: 0 }; cache.set(key, entry);
    promise.then(() => { entry.pending = false; entry.expires = now() + 5 * 60000; }, () => cache.delete(key));
    for (const [key, item] of cache) if (!item.pending && (cache.size > 128 || item.expires <= now())) cache.delete(key);
    return promise;
  }
  return { query, close: async () => { await worker?.terminate(); cache.clear(); } };
}
