export function createProfileService(deps) {
  const { getProfileDb, leaderboardCache, ladderOrder, types, personalStatsCache, personalStatsCacheTtl, fetchUpstreamWithRateLimit, forceChinaCountry } = deps;
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
      player: { id: row.profileId, name: row.name || `玩家 ${row.profileId}`, country_code: forceChinaCountry(row.profileId, row.country || leaderboardRow?.country || ''), team: clan, steamId: row.steamId || '', lastMatchTime: row.lastMatchTime || '' },
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

  const refreshes = new Map();
  async function fetchPersonalLeaderboardStats(profileId, { rankedOnly = false } = {}) {
    const key = String(profileId);
    const cached = personalStatsCache.get(key);
    if (cached && Date.now() - cached.savedAt < personalStatsCacheTtl && (rankedOnly || !cached.lobbyPending)) return cached.data;
    const running = refreshes.get(key);
    if (running) return rankedOnly ? running.ranked : running.full;
    let ready, failed;
    const ranked = new Promise((resolve,reject) => { ready=resolve; failed=reject; });
    ranked.catch(() => {});
    const task = { ranked, full:null };
    task.full = Promise.resolve().then(async () => {
      try {
        const endpoint = new URL('https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat');
        endpoint.search = new URLSearchParams({ title: 'age2', profile_ids: JSON.stringify([Number(profileId)]) });
        let response;
        try {
          response = await fetchUpstreamWithRateLimit(endpoint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        } catch (error) {
          if (error.rateLimited && cached) { ready(cached.data); return cached.data; }
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
        const savedAt = Date.now();
        const previousLobby = cached?.data?.find(row => Number(row.id) === 0);
        const initial = data.concat(previousLobby ? [{ ...previousLobby, stale:true }] : [{ id:0, label:'大厅局', hasData:true, active:true, pending:true, rank:null }]);
        personalStatsCache.set(key, { savedAt, data:initial, lobbyPending:true });
        ready(initial);
        try {
          const response = await fetchUpstreamWithRateLimit('https://data.aoe2companion.com/api/profiles/' + encodeURIComponent(key), { headers: { accept: 'application/json', 'user-agent': 'https://aoe2cn.cc' }, signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error('Companion 玩家接口 HTTP ' + response.status);
          const profile = await response.json();
          const lobby = (Array.isArray(profile.leaderboards) ? profile.leaderboards : []).find(row => row.leaderboardId === 'unranked');
          if (lobby) {
            const number = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
            const time = Date.parse(lobby.lastMatchTime);
            data.push({ id: 0, label: '大厅局', hasData: true, active: Number.isFinite(time) && Date.now() - time <= 30 * 24 * 60 * 60_000, rank: null, rating: null, highestRating: null, wins: number(lobby.wins), losses: number(lobby.losses), games: number(lobby.games), lastMatchDate: Number.isFinite(time) ? Math.floor(time / 1000) : null, source: 'aoe2companion-unranked' });
          } else data.push({ id: 0, label: '大厅局', hasData: false, active: false, rank: null });
        } catch (error) {
          const previous = cached?.data?.find(row => Number(row.id) === 0);
          if (previous) data.push({ ...previous, stale: true });
          console.warn('[profile] lobby statistics unavailable:', error.message);
        }
        personalStatsCache.set(key, { savedAt, data, lobbyPending:false });
        return data;
      } catch (error) { failed(error); throw error; }
      finally { refreshes.delete(key); }
    });
    task.full.catch(() => {});
    refreshes.set(key,task);
    return rankedOnly ? task.ranked : task.full;
  }


  return { localProfileDetails, profileLeaderboardSummary, fetchPersonalLeaderboardStats };
}
