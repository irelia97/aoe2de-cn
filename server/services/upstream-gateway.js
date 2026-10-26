const jsonHosts = new Set(['data.aoe2companion.com', 'aoe-api.worldsedgelink.com']);
export const managedHosts = new Set([...jsonHosts, 'api.ageofempires.com', 'steamcommunity.com']);

export function upstreamCacheTtl(url, data) {
  if (url.hostname !== 'data.aoe2companion.com') return 10000;
  // Only complete results with known winners are safe to keep longer.
  if (/^\/api\/matches\/\d+\/?$/.test(url.pathname)) {
    try {
      const match = JSON.parse(data.toString());
      const players = (match.teams || []).flatMap(team => team.players || []);
      if (match.finished && players.length && players.every(p => typeof p.won === 'boolean')) return 60 * 60000;
    } catch {}
    return 10000;
  }
  if (/^\/api\/profiles\/\d+\/?$/.test(url.pathname)) return 60000;
  return 10000;
}

export function createUpstreamGateway({ fetchImpl = fetch, now = Date.now, gapMs = 3000, maxQueue = 64, requestTimeoutMs = 45000 } = {}) {
  const hosts = new Map(), pending = new Map(), cache = new Map();
  let cacheBytes = 0;
  function state(host) {
    if (!hosts.has(host)) hosts.set(host, { queue: [], active: 0, nextAt: 0, blockedUntil: 0, timer: null,
      requests: 0, cacheHits: 0, merged: 0, limited: 0, failed: 0, timedOut: 0, current: null, lastFailure: null });
    return hosts.get(host);
  }
  const limited = seconds => new Response(JSON.stringify({ error: '上游暂时限流，请稍后重试' }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(Math.max(1, seconds)) }
  });
  function retryMs(response) {
    const raw = response.headers.get('retry-after');
    const value = Number(raw);
    return raw && Number.isFinite(value) ? Math.max(1000, value * 1000)
      : raw && Number.isFinite(Date.parse(raw)) ? Math.max(1000, Date.parse(raw) - now()) : 60000;
  }
  function joinRequest(record, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      record.users++;
      let finished = false;
      const finish = (error, response) => {
        if (finished) return;
        finished = true; signal?.removeEventListener('abort', abort); record.users--;
        if (error) reject(error); else resolve(response.clone());
        if (!record.users && !record.settled) record.controller.abort(new Error('所有请求方均已取消'));
      };
      const abort = () => finish(signal.reason || new Error('请求已取消'));
      signal?.addEventListener('abort', abort, { once: true });
      record.task.then(response => finish(null, response), error => finish(error));
    });
  }
  function pump(host) {
    const item = state(host);
    if (item.timer || item.active || !item.queue.length) return;
    if (item.blockedUntil > now()) {
      for (const job of item.queue.splice(0)) { job.cleanup?.(); job.resolve(limited(Math.ceil((item.blockedUntil - now()) / 1000))); }
      return;
    }
    const wait = item.nextAt - now();
    if (wait > 0) { item.timer = setTimeout(() => { item.timer = null; pump(host); }, wait); return; }
    item.queue.sort((a, b) => b.priority - a.priority || a.enqueued - b.enqueued);
    const job = item.queue.shift();
    job.cleanup?.();
    if (job.signal?.aborted || now() - job.enqueued > 20000) {
      job.reject(job.signal?.reason || new Error('上游请求排队超时')); pump(host); return;
    }
    item.active = 1; item.requests++;
    item.nextAt = now() + (host === 'data.aoe2companion.com' ? gapMs : 300);
    let released = false, reader, streamController, deadline;
    const current = { path: new URL(job.url).pathname, startedAt: now(), phase: 'headers' };
    item.current = current;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(job.signal ? [job.signal] : [])]);
    const release = () => {
      if (released) return;
      released = true; clearTimeout(deadline); signal.removeEventListener('abort', onAbort);
      item.active = 0; item.current = null; pump(host);
    };
    // Cancellation itself can stall. Never wait for it before releasing a host slot.
    const cancel = reason => { try { Promise.resolve(reader?.cancel(reason)).catch(() => {}); } catch {} };
    const fail = error => {
      if (released) return;
      item.failed++;
      item.lastFailure = { path: current.path, phase: current.phase, at: now(), error: String(error.message || error).slice(0,160) };
      try { streamController?.error(error); } catch {}
      job.reject(error); cancel(error); release();
    };
    let rejectInterrupted;
    const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
    interrupted.catch(() => {});
    const onAbort = () => { const error = signal.reason || new Error('上游请求已取消'); fail(error); rejectInterrupted(error); };
    signal.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => {
      item.timedOut++;
      controller.abort(new Error('上游请求超过硬性时限'));
    }, requestTimeoutMs);
    if (signal.aborted) onAbort();
    const guarded = operation => Promise.race([operation, interrupted]);
    (async () => {
      try {
        if (released) return;
        const fetching = Promise.resolve(fetchImpl(job.url, { ...job.options, signal, redirect: 'error' }));
        fetching.then(response => { if (released) { try { response.body?.cancel().catch(() => {}); } catch {} } }, () => {});
        const response = await guarded(fetching);
        current.phase = 'body';
        if (response.status === 429) {
          item.limited++; item.blockedUntil = now() + retryMs(response);
          try { response.body?.cancel().catch(() => {}); } catch {}
          job.resolve(limited(Math.ceil((item.blockedUntil - now()) / 1000))); release(); return;
        }
        if (jsonHosts.has(host)) {
          const chunks = []; let size = 0;
          reader = response.body?.getReader();
          while (reader) {
            const { value: chunk, done } = await guarded(reader.read());
            if (released) return;
            if (done) break;
            size += chunk.length;
            if (size > 8 * 1024 * 1024) throw new Error('上游数据过大');
            chunks.push(chunk);
          }
          const data = Buffer.concat(chunks);
          const result = { data, status: response.status, headers: Object.fromEntries(response.headers) };
          // fetch already decoded compressed bodies; never forward their old encoding/length.
          delete result.headers['content-encoding']; delete result.headers['content-length'];
          if (response.ok) {
            const previous = cache.get(job.key); if (previous) cacheBytes -= previous.data.length;
            cache.delete(job.key); cache.set(job.key, { ...result, expires: now() + upstreamCacheTtl(new URL(job.url), data) }); cacheBytes += data.length;
            while (cache.size > 256 || cacheBytes > 32 * 1024 * 1024) {
              const key = cache.keys().next().value; cacheBytes -= cache.get(key).data.length; cache.delete(key);
            }
          }
          job.resolve(new Response(data, result)); release();
        } else {
          if (!response.body) { job.resolve(response); release(); return; }
          reader = response.body.getReader();
          const body = new ReadableStream({
            start(controller) { streamController = controller; },
            async pull(controller) {
              try { const result = await guarded(reader.read()); if (released) return; if (result.done) { controller.close(); release(); } else controller.enqueue(result.value); }
              catch (error) { fail(error); }
            },
            cancel(reason) { cancel(reason); release(); }
          });
          job.resolve(new Response(body, { status: response.status, headers: response.headers }));
        }
      } catch (error) { fail(error); }
    })();
  }
  return {
    stats: () => Object.fromEntries([...hosts].map(([host, item]) => [host, { requests: item.requests,
      cacheEntries: [...cache.keys()].filter(key => new URL(key).hostname === host).length,
      cacheBytes: [...cache].reduce((sum, [key, value]) => sum + (new URL(key).hostname === host ? value.data.length : 0), 0),
      cacheHits: item.cacheHits, merged: item.merged, limited: item.limited, failed: item.failed,
      queued: item.queue.length, active: item.active, blockedUntil: item.blockedUntil,
      timedOut: item.timedOut, current: item.current ? { ...item.current, ageMs: now()-item.current.startedAt } : null,
      lastFailure: item.lastFailure }])),
    fetch(input, options = {}) {
      if (options.signal?.aborted) return Promise.reject(options.signal.reason || new Error('请求已取消'));
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || !managedHosts.has(url.hostname) || url.port || url.username || url.password
        || (options.method && options.method !== 'GET')) return Promise.reject(new Error('不允许的上游地址'));
      url.searchParams.sort();
      const key = url.href, item = state(url.hostname);
      const cached = cache.get(key);
      if (cached?.expires > now()) { cache.delete(key); cache.set(key, cached); item.cacheHits++; return Promise.resolve(new Response(cached.data, cached)); }
      if (cached) { cache.delete(key); cacheBytes -= cached.data.length; }
      if (item.blockedUntil > now()) return Promise.resolve(limited(Math.ceil((item.blockedUntil - now()) / 1000)));
      if (jsonHosts.has(url.hostname) && pending.has(key)) {
        item.merged++;
        const queued = item.queue.find(job => job.key === key);
        if (queued) queued.priority = Math.max(queued.priority, Number(options.priority) || 0);
        return joinRequest(pending.get(key), options.signal);
      }
      const capacity = Number(options.priority) > 0 ? maxQueue : Math.max(1, maxQueue - 8);
      if (item.queue.length >= capacity) return Promise.reject(new Error('上游请求队列已满'));
      const record = jsonHosts.has(url.hostname) ? { users: 0, settled: false, controller: new AbortController() } : null;
      const actualOptions = record ? { ...options, signal: AbortSignal.any([record.controller.signal, AbortSignal.timeout(65000)]) } : options;
      const task = new Promise((resolve, reject) => {
        const job = { url: key, key, options: actualOptions, signal: actualOptions.signal, priority: Number(options.priority) || 0, enqueued: now(), resolve, reject };
        const cancelled = () => {
          const index = item.queue.indexOf(job);
          if (index >= 0) { item.queue.splice(index, 1); reject(actualOptions.signal.reason || new Error('请求已取消')); }
        };
        job.cleanup = () => actualOptions.signal?.removeEventListener('abort', cancelled);
        actualOptions.signal?.addEventListener('abort', cancelled, { once: true });
        item.queue.push(job);
        pump(url.hostname);
      });
      if (!jsonHosts.has(url.hostname)) return task;
      record.task = task;
      pending.set(key, record);
      const settled = () => { record.settled = true; pending.delete(key); };
      task.then(settled, settled);
      return joinRequest(record, options.signal);
    }
  };
}
