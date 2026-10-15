export function createProfileService(deps) {
  const { getProfileDb, leaderboardCache, ladderOrder, types, personalStatsCache, personalStatsCacheTtl, fetchUpstreamWithRateLimit } = deps;
  const fetch = globalThis.fetch;
  function localProfileDetails(profileId) {
    const profileDb = getProfileDb();
    if (!profileDb) return null;
    const row = profileDb.prepare('SELECT profile_id AS profileId, steam_id AS steamId, name, clan, last_match_time AS lastMatchTime, country FROM profiles WHERE profile_id = ?').get(String(profileId));
    if (!row) return null;
    const leaderboardRow = [...leaderboardCache.values()]
      .flatMap(cache => cache.data?.rows || [])
      .find(item => String(item.profileId) === String(profileId));
    const inferredClan = String(row.name || '').match(/^([A-Z0-9]{2,})[_\s.]/i)?.[1] || '';
    const clan = row.clan || leaderboardRow?.clan || inferredClan;
    return {
      avatar: '',
      player: { id: row.profileId, name: row.name || `玩家 ${row.profileId}`, country_code: row.country || leaderboardRow?.country || '', team: clan, steamId: row.steamId || '', lastMatchTime: row.lastMatchTime || '' },
      accounts: [],
      live: null,
      matches: [],
      leaderboards: profileLeaderboardSummary(profileId)
    };
  }

  function profileLeaderboardSummary(profileId) {
    return ladderOrder.map(id => {
      const cached = leaderboardCache.get(id);
      const row = cached?.data.rows.find(item => String(item.profileId) === String(profileId));
      return row ? { id, label: types[id], rank: row.rank, rating: row.rating, highestRating: row.highestRating, wins: row.wins, losses: row.losses, streak: row.streak } : { id, label: types[id], rank: null };
    });
  }

  async function fetchPersonalLeaderboardStats(profileId) {
    const key = String(profileId);
    const cached = personalStatsCache.get(key);
    if (cached && Date.now() - cached.savedAt < personalStatsCacheTtl) return cached.data;
    const endpoint = new URL('https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat');
    endpoint.search = new URLSearchParams({ title: 'age2', profile_ids: JSON.stringify([Number(profileId)]) });
    let response;
    try {
      response = await fetchUpstreamWithRateLimit(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (error.rateLimited && cached) return cached.data;
      throw error;
    }
    if (!response.ok) throw new Error(`个人天梯接口返回 HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.result?.code !== 0) throw new Error(payload?.result?.message || '个人天梯接口返回失败');
    const stats = new Map((payload.leaderboardStats || []).map(stat => [Number(stat.leaderboard_id), stat]));
    const data = ladderOrder.map(id => {
      const stat = stats.get(id);
      if (!stat) return { id, label: types[id], hasData: false, active: false, rank: null };
      const active = Number(stat.rank) > 0;
      return { id, label: types[id], hasData: true, active, rank: active ? Number(stat.rank) : null, rating: stat.rating ?? null, highestRating: Number(stat.highestrating) > 0 ? stat.highestrating : (stat.rating ?? null), wins: stat.wins ?? null, losses: stat.losses ?? null, streak: stat.streak ?? null, lastMatchDate: stat.lastmatchdate ?? null, rankTotal: stat.ranktotal ?? null };
    });
    personalStatsCache.set(key, { savedAt: Date.now(), data });
    return data;
  }


  return { localProfileDetails, profileLeaderboardSummary, fetchPersonalLeaderboardStats };
}
