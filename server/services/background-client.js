import { managedHosts } from './upstream-gateway.js';

export function createBackgroundClient({ baseUrl = 'http://127.0.0.1:3001', fetchImpl = fetch } = {}) {
  async function call(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...options, signal: options.signal || AbortSignal.timeout(25000) });
    return response;
  }
  async function json(path, options) {
    const response = await call(path, options);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || '后台服务暂不可用'), { statusCode: response.status, retryAfterMs: Number(response.headers.get('retry-after') || 1) * 1000 });
    return data;
  }
  return {
    health: () => json('/health'),
    matchAdded: match => json('/notifications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(match) }),
    getMatchInfo: matchId => json(`/replay/info?matchId=${encodeURIComponent(matchId)}`),
    submit: (matchId, profileId) => json(`/replay/jobs?matchId=${encodeURIComponent(matchId)}&profileId=${encodeURIComponent(profileId)}`, { method: 'POST' }),
    cached: (matchId, profileId) => call(`/replay/cached?matchId=${encodeURIComponent(matchId)}&profileId=${encodeURIComponent(profileId)}`),
    poll: jobId => call(`/replay/jobs/${encodeURIComponent(jobId)}`),
    download: (matchId, profileId, signal) => call(`/replay/download?matchId=${encodeURIComponent(matchId)}&profileId=${encodeURIComponent(profileId)}`, { signal: signal || AbortSignal.timeout(65000) }),
    fetch(input, options = {}) {
      const url = new URL(String(input));
      if (!managedHosts.has(url.hostname)) return fetchImpl(input, options);
      const headers = new Headers(options.headers);
      const forwarded = { 'x-upstream-user-agent': headers.get('user-agent') || 'AOE2DE-CN/1.0',
        'x-upstream-accept': headers.get('accept') || 'application/json', 'x-upstream-priority': String(options.priority || 0) };
      return call(`/upstream?url=${encodeURIComponent(url.href)}`, { headers: forwarded, signal: options.signal });
    }
  };
}
