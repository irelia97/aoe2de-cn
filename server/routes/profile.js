export function createProfileRoutes({
  localProfileDetails, loadRlReference, loadPlayerTeams, readAoE2RecsProfileCache,
  aoe2RecsProfileInsights, readProfileAccounts, fetchLatestProfileMatchOnce,
  readWorldsEdgeMatchesCache, getWorldsEdgeMatches, repairOlderUnfinishedMatches,
  fetchProfileMatchesOnce, worldsEdgeMatchCacheTtl, fetchPersonalLeaderboardStats
}) {
  return new Map([
    ['/api/profile-details', async (url, res) => {
      const profileId = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(profileId)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '无效的选手 ID' }));
      }
      try {
        const profile = localProfileDetails(profileId);
        if (!profile) throw new Error('本地资料库中没有该选手');
        const rlReference = (await loadRlReference()).get(String(profileId)) || null;
        const teams=await loadPlayerTeams([profileId]);
        profile.player={...profile.player,team:teams.get(profileId) || ''};
        const recsCached = await readAoE2RecsProfileCache(profileId);
        const insights = aoe2RecsProfileInsights(profileId, recsCached?.profile);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' });
        return res.end(JSON.stringify({ ...profile, rlReference, insights, cached: true, stale: false, source: 'profile-dump' }));
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: error.message || '获取选手资料失败' }));
      }
    }],
    ['/api/profile-accounts', async (url, res) => {
      const profileId = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(profileId)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '无效的选手 ID' }));
      }
      try {
        const result = await readProfileAccounts(profileId);
        let recsCached = await readAoE2RecsProfileCache(profileId);
        if (!recsCached?.profile) for (const account of result.accounts || []) {
          recsCached = await readAoE2RecsProfileCache(String(account.id || ''));
          if (recsCached?.profile) break;
        }
        const insights = aoe2RecsProfileInsights(profileId, recsCached?.profile);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': result.stale ? 'no-cache' : 'public, max-age=300' });
        return res.end(JSON.stringify({ ...result, insights }));
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: error.message || '获取账号与曾用名失败' }));
      }
    }],
    ['/api/profile-matches', async (url, res) => {
      const profileId = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(profileId)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '无效的选手 ID' }));
      }
      if (url.searchParams.get('latest') === '1') {
        try {
          const latest = await fetchLatestProfileMatchOnce(profileId);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ matches: latest ? [latest] : [], latest: true }));
        } catch {
          try {
            const fallback = await readWorldsEdgeMatchesCache(profileId);
            if (!fallback?.matches?.length) throw new Error('查询失败，暂无可用对局缓存');
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify({ matches: fallback.matches?.[0] ? [fallback.matches[0]] : [], latest: true, stale: true }));
          } catch (error) {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(JSON.stringify({ error: error.message || '获取最新对局失败' }));
          }
        }
      }
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const limit = Math.min(100, Math.max(20, Number(url.searchParams.get('limit') || 100)));
      const progressive = url.searchParams.get('progressive') === '1' && offset === 0;
      try {
        if (url.searchParams.get('snapshot') === '1' && offset === 0) {
          // Return the whole stored window before making any latest-match query.
          // A cold profile needs one full history request, never a 20-match prefetch.
          const cached = await readWorldsEdgeMatchesCache(profileId);
          const snapshot = cached?.matches?.length ? cached : await getWorldsEdgeMatches(profileId, 1);
          repairOlderUnfinishedMatches(profileId, snapshot).catch(error => console.warn(`选手 ${profileId} 旧对局校正失败:`, error.message));
          res.writeHead(200, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });
          return res.end(JSON.stringify({ matches:snapshot.matches.slice(0,100), hasMore:false,
            cached:Boolean(cached?.matches?.length), stale:Boolean(snapshot.stale), savedAt:snapshot.savedAt }));
        }
        if (progressive) {
          let initial = await readWorldsEdgeMatchesCache(profileId);
          const cachedFirst = Boolean(initial?.matches?.length);
          if (!cachedFirst) try {
            initial = await fetchProfileMatchesOnce(profileId, 1, 20);
          } catch {
            // If the initial lookup fails, use an existing snapshot without
            // starting another series of upstream retries.
            const fallback = await readWorldsEdgeMatchesCache(profileId);
            if (!fallback?.matches?.length) throw new Error('查询失败，暂无可用对局缓存');
            initial = { matches: fallback.matches.slice(0, 20), hasMore: false };
          }
          // Continue the cache refresh in the background. The first 20 matches
          // are already available to the client and can be rendered immediately.
          getWorldsEdgeMatches(profileId, 1).catch(error => console.error(`选手 ${profileId} 对局缓存更新失败:`, error.message));
          const page = initial.matches.slice(0, 20);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(JSON.stringify({ matches: page, offset: 0, total: page.length, hasMore: true, progressive: true, cached:cachedFirst,
            stale:cachedFirst && Date.now()-initial.savedAt >= worldsEdgeMatchCacheTtl }));
        }
        const pageNumber = Math.floor(offset / 100) + 1;
        const cached = await getWorldsEdgeMatches(profileId, pageNumber);
        const matches = cached.matches;
        const page = matches.slice(offset, offset + limit);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cached.stale ? 'no-store' : 'public, max-age=60' });
        return res.end(JSON.stringify({ matches: page, offset, total: matches.length, hasMore: offset + page.length < matches.length || cached.hasMore, stale:Boolean(cached.stale) }));
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: error.message || '获取近期对局失败' }));
      }
    }],
    ['/api/profile-leaderboards', async (url, res) => {
      const profileId = url.searchParams.get('id') || '';
      if (!/^\d+$/.test(profileId)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '无效的选手 ID' }));
      }
      try {
        const leaderboards = await fetchPersonalLeaderboardStats(profileId, { rankedOnly:url.searchParams.get('progressive') === '1' });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': leaderboards.some(row => row.pending || row.stale) ? 'no-store' : 'public, max-age=600' });
        return res.end(JSON.stringify({ leaderboards, source: 'getPersonalStat' }));
      } catch (error) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ error: error.message || '获取个人天梯数据失败' }));
      }
    }],
  ]);
}
