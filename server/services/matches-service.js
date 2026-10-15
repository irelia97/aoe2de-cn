export function createMatchesService({ fetchUpstreamWithRateLimit, normalizeCompanionMatches }) {
  async function fetchWorldsEdgeMatchesOnce(profileId, page = 1, perPage = 100) {
    const endpoint = new URL('https://data.aoe2companion.com/api/matches');
    endpoint.searchParams.set('profile_ids', String(profileId));
    endpoint.searchParams.set('use_enums', 'true');
    endpoint.searchParams.set('page', String(page));
    endpoint.searchParams.set('per_page', String(Math.min(100, Math.max(1, perPage))));
    let lastError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const response = await fetchUpstreamWithRateLimit(endpoint, {
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', accept: 'application/json' },
          signal: AbortSignal.timeout(30_000)
        });
        if (!response.ok) throw new Error(`AoE2 Companion 请求失败（HTTP ${response.status}）`);
        const payload = await response.json();
        const matches = normalizeCompanionMatches(payload);
        return { matches, hasMore: matches.length >= Math.min(100, Math.max(1, perPage)) };
      } catch (error) {
        lastError = error;
        if (error.rateLimited) throw error;
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (attempt + 1), 4000)));
      }
    }
    throw lastError || new Error('AoE2 Companion 请求失败');
  }

  async function fetchLatestWorldsEdgeMatchOnce(profileId) {
    const result = await fetchWorldsEdgeMatchesOnce(profileId, 1, 1);
    return result.matches[0] || null;
  }

  return { fetchWorldsEdgeMatchesOnce, fetchLatestWorldsEdgeMatchOnce };
}
