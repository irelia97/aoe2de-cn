export function createRealtimeService(deps) {
  const {
    realtimePayloadPath,
    readFile,
    writeFile,
    fetchLatestWorldsEdgeMatchOnce,
    localProfileDetails,
    getLeaderboard,
    getMediaCache,
    loadRlReference,
    fetchPersonalLeaderboardStats,
    worldsEdgeMatchCache,
    worldsEdgeMatchCachePath
  } = deps;

  function normalizeRealtimeLatestMatch(match, profileId) {
    if (!match || typeof match !== 'object') return { profileId: String(profileId), status: 'offline', match: null };
    const started = Number(match.started || 0);
    const finished = Number(match.finished || 0);
    const abandoned = match.abandoned === true;
    const now = Math.floor(Date.now() / 1000);
    // An unfinished record can be left behind by a disconnected or abandoned
    // lobby. Keep only plausible current matches in the realtime monitor.
    const activeAge = started > 0 && started <= now + 300 && now - started <= 3 * 60 * 60;
    const inProgress = Boolean(!abandoned && activeAge && (match.live || !finished));
    const status = inProgress ? (String(match.leaderboard || '').trim() ? 'game' : 'lobby') : 'offline';
    return {
      profileId: String(profileId),
      status,
      match: {
        id: match.id ?? null,
        map: match.rms || '',
        leaderboard: match.leaderboard || '',
        lobby: match.lobby || '',
        server: match.server || '',
        started,
        finished,
        abandoned,
        players: Array.isArray(match.players) ? match.players.map(player => {
          const playerId = player.id ?? null;
          const local = playerId != null ? localProfileDetails(playerId)?.player : null;
          return {
            profileId: playerId,
            name: player.name || local?.name || '',
            team: player.team ?? null,
            civilization: player.civilization || '',
            civilizationId: player.civilization_id || '',
            colorHex: player.color_hex || '#6d7884',
            country: player.country || local?.country_code || '',
            rating: player.rating ?? null,
            color: player.color ?? null
          };
        }) : [],
        teams: Array.isArray(match.teams) ? match.teams : []
      }
    };
  }

  let realtimePayloadCache = null;
  let realtimeRefreshPromise = null;

  async function buildRealtimePayload(profileIds) {
    const states = await fetchRealtimeStates(profileIds);
    const ratingMap = new Map();
    try { const board = await getLeaderboard(3); for (const row of board.rows || []) ratingMap.set(String(row.profileId), Number(row.rating)); } catch {}
    const liveByProfile = new Map();
    try {
      const media = await getMediaCache();
      for (const item of Array.isArray(media.live) ? media.live : []) {
        if (!item?.live) continue;
        const live = { title: item.title || '正在直播', url: item.url || '', platform: item.platform || '' };
        for (const profileId of Array.isArray(item.profileIds) ? item.profileIds : []) liveByProfile.set(String(profileId), live);
      }
    } catch {}
    const realtimeReferences = await loadRlReference();
    const enrichedStates = states.map(state => {
      const profile = localProfileDetails(state.profileId)?.player || {};
      const own = state.match?.players?.find(player => String(player.profileId) === String(state.profileId)) || {};
      const reference = realtimeReferences.get(String(state.profileId));
      return { ...state, identity: reference?.canonicalProfileId || String(state.profileId), live: liveByProfile.get(String(state.profileId)) || null, player: { profileId: String(state.profileId), name: profile.name || own.name || `玩家 ${state.profileId}`, team: profile.team || "", country: profile.country_code || own.country || "", rating: ratingMap.get(String(state.profileId)) ?? own.rating ?? null } };
    });
    return { source: 'aoe2companion-latest', checkedAt: new Date().toISOString(), states: enrichedStates };
  }

  async function refreshRealtimePayload(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    if (realtimeRefreshPromise) return realtimeRefreshPromise;
    realtimeRefreshPromise = (async () => {
      const payload = await buildRealtimePayload(ids);
      realtimePayloadCache = { key, payload };
      await writeFile(realtimePayloadPath, JSON.stringify({ key, payload }), 'utf8');
      console.log(`[realtime] cache refreshed: ${payload.states.length} states`);
      return payload;
    })();
    try { return await realtimeRefreshPromise; } finally { realtimeRefreshPromise = null; }
  }

  async function readCachedRealtimeLatestMatch(profileId) {
    const key = String(profileId);
    let current = worldsEdgeMatchCache.get(key);
    if (!current) {
      try {
        const disk = JSON.parse(await readFile(worldsEdgeMatchCachePath(key), 'utf8'));
        if (disk && Array.isArray(disk.matches)) {
          current = disk;
          worldsEdgeMatchCache.set(key, current);
        }
      } catch {}
    }
    return current?.matches?.[0] || null;
  }

  async function fetchRealtimeStates(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    // Each player is checked once per polling round using the one-row query.
    // Requests run together so the page can render the round promptly.
    const states = [];
    const batchSize = 5;
    const batchIntervalMs = 2000;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize);
      const batchStates = await Promise.all(batch.map(async profileId => {
        try {
          const latest = await fetchLatestWorldsEdgeMatchOnce(profileId);
          return normalizeRealtimeLatestMatch(latest, profileId);
        } catch (error) {
          if (error.rateLimited) {
            const cached = await readCachedRealtimeLatestMatch(profileId);
            if (cached) {
              const fallback = normalizeRealtimeLatestMatch(cached, profileId);
              return { ...fallback, stale: true, rateLimited: true };
            }
          }
          return { profileId, status: 'error', error: error.message || '查询失败', match: null };
        }
      }));
      states.push(...batchStates);
      if (offset + batchSize < ids.length) await new Promise(resolve => setTimeout(resolve, batchIntervalMs));
    }
    const activeIds = [...new Set(states.filter(state => (state.status === 'game' || state.status === 'lobby') && state.match).flatMap(state => Array.isArray(state.match.players) ? state.match.players.map(player => player.profileId) : []).map(value => String(value || '').trim()).filter(value => /^[0-9]+$/.test(value)))];
    const ratings = new Map();
    await Promise.all(activeIds.map(async profileId => {
      try {
        const rows = await fetchPersonalLeaderboardStats(profileId);
        const row = Array.isArray(rows) ? rows.find(item => Number(item.id) === 3) : null;
        if (row && Number.isFinite(Number(row.rating))) ratings.set(String(profileId), Number(row.rating));
      } catch {}
    }));
    return states.map(state => ({
      ...state,
      match: state.match ? { ...state.match, players: state.match.players.map(player => ({ ...player, rating: ratings.get(String(player.profileId)) ?? null })) } : null
    }));
  }


  async function getCachedPayload(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    if (!realtimePayloadCache) {
      try {
        const disk = JSON.parse(await readFile(realtimePayloadPath, 'utf8'));
        if (disk?.key === key && disk.payload?.states) realtimePayloadCache = disk;
      } catch {}
    }
    return realtimePayloadCache?.key === key ? realtimePayloadCache.payload : null;
  }

  return { normalizeRealtimeLatestMatch, refreshRealtimePayload, readCachedRealtimeLatestMatch, fetchRealtimeStates, getCachedPayload };
}
