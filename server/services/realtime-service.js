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
    worldsEdgeMatchCachePath,
    forceChinaCountry,
    getLiveTournamentForPlayer = () => '',
    WebSocket,
    onMatchAdded = () => {}
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
        tournament: match.tournament || match.event || match.eventName || '',
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
            country: forceChinaCountry(playerId, player.country || local?.country_code || ''),
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

  async function resolveUnknownMaps(states) {
    const missingCivilization = player => {
      const value = String(player?.civilizationId || player?.civilization || '').trim().toLowerCase();
      return !value || value === 'unknown' || value === '未知' || value === '未知文明';
    };
    const unknownMatches = new Map();
    for (const state of Array.isArray(states) ? states : []) {
      const map = String(state?.match?.map || '').trim().toLowerCase();
      const matchId = String(state?.match?.id || '').trim();
      const hasMissingCivilization = (state?.match?.players || []).some(missingCivilization);
      if ((map === 'unknown' || !map || hasMissingCivilization) && matchId && !unknownMatches.has(matchId)) unknownMatches.set(matchId, state);
    }
    if (!unknownMatches.size) return states;
    const resolved = new Map();
    await Promise.all([...unknownMatches.entries()].map(async ([matchId, state]) => {
      try {
        const latest = await fetchLatestWorldsEdgeMatchOnce(state.profileId);
        const latestId = String(latest?.id ?? latest?.matchId ?? '').trim();
        const latestMap = String(latest?.rms || latest?.map || latest?.mapName || '').trim();
        if (latestId && latestId !== matchId) return;
        const civilizationByKey = new Map();
        for (const player of Array.isArray(latest?.players) ? latest.players : []) {
          const civilization = String(player?.civilization || player?.civ || '').trim();
          const civilizationId = String(player?.civilization_id || player?.civilizationId || player?.civ || '').trim();
          if (!civilization && !civilizationId) continue;
          for (const key of [player?.id, player?.profileId, player?.name]) {
            const normalized = String(key || '').trim().toLowerCase();
            if (normalized) civilizationByKey.set(normalized, { civilization, civilizationId });
          }
        }
        if ((latestMap && latestMap.toLowerCase() !== 'unknown') || civilizationByKey.size) resolved.set(matchId, { map: latestMap, civilizationByKey });
      } catch {}
    }));
    if (!resolved.size) return states;
    return states.map(state => {
      const matchId = String(state?.match?.id || '').trim();
      const result = resolved.get(matchId);
      if (!result) return state;
      const players = (state.match.players || []).map(player => {
        if (!missingCivilization(player)) return player;
        const keys = [player?.profileId, player?.id, player?.name].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
        const civ = keys.map(key => result.civilizationByKey.get(key)).find(Boolean);
        return civ ? { ...player, civilization: civ.civilization || player.civilization, civilizationId: civ.civilizationId || player.civilizationId } : player;
      });
      return { ...state, match: { ...state.match, ...(result.map && result.map.toLowerCase() !== 'unknown' ? { map: result.map } : {}), players } };
    });
  }

  async function buildEnrichedPayload(profileIds, states, source = 'aoe2companion-latest') {
    states = await resolveUnknownMaps(states);
    const ratingMap = new Map();
    try { const board = await getLeaderboard(3); for (const row of board.rows || []) ratingMap.set(String(row.profileId), Number(row.rating)); } catch {}
    // WebSocket match payloads carry the rating for the current match mode,
    // which can be a team-game rating. Always overlay each player with their
    // 1v1 random-map rating before the realtime page renders the card.
    const matchPlayerIds = [...new Set((Array.isArray(states) ? states : [])
      .flatMap(state => Array.isArray(state?.match?.players) ? state.match.players : [])
      .map(player => String(player?.profileId ?? player?.id ?? '').trim())
      .filter(id => /^\d+$/.test(id)))];
    await Promise.all(matchPlayerIds.map(async profileId => {
      try {
        const rows = await fetchPersonalLeaderboardStats(profileId);
        const row = Array.isArray(rows) ? rows.find(item => Number(item.id) === 3) : null;
        if (row && Number.isFinite(Number(row.rating))) ratingMap.set(profileId, Number(row.rating));
      } catch {}
    }));
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
      const matchTournamentUrl = typeof state.match?.tournament === 'object' ? state.match.tournament?.url : state.match?.tournamentUrl;
      const liveTournament = state.match && (!state.match.tournament || !matchTournamentUrl)
        ? (state.match.players || []).map(matchPlayer => getLiveTournamentForPlayer(matchPlayer.name)).find(Boolean) || null
        : null;
      const enrichedMatch = state.match ? { ...state.match, tournament: state.match.tournament || liveTournament?.name || '', tournamentUrl: state.match.tournamentUrl || matchTournamentUrl || liveTournament?.url || '', bestOf: state.match.bestOf || liveTournament?.bestOf || null, score: Array.isArray(state.match.score) && state.match.score.length >= 2 ? state.match.score : (liveTournament?.score || ['', '']), players: (state.match.players || []).map(matchPlayer => ({ ...matchPlayer, rating: ratingMap.get(String(matchPlayer.profileId ?? matchPlayer.id)) ?? matchPlayer.rating ?? null })) } : null;
      return { ...state, match: enrichedMatch, identity: reference?.canonicalProfileId || String(state.profileId), live: liveByProfile.get(String(state.profileId)) || null, player: { profileId: String(state.profileId), name: profile.name || own.name || `玩家 ${state.profileId}`, team: profile.team || '', country: profile.country_code || own.country || '', rating: ratingMap.get(String(state.profileId)) ?? own.rating ?? null } };
    });
    return { source, checkedAt: new Date().toISOString(), states: enrichedStates };
  }

  async function buildRealtimePayload(profileIds) {
    return buildEnrichedPayload(profileIds, await fetchRealtimeStates(profileIds));
  }

  const realtimeWebSocketBatchSize = 50;
  const realtimeSocketGroups = new Map();
  let realtimeSocketGeneration = 0;
  let realtimeSocketProfileIds = [];
  let realtimeSocketPublishTimer = null;
  let realtimeValidationTimer = null;
  const realtimeValidatedMatches = new Map();

  function socketMatchId(match) { return String(match?.matchId ?? match?.id ?? ''); }
  function socketMatchPlayerIds(match) {
    return new Set((Array.isArray(match?.players) ? match.players : []).map(player => String(player?.id ?? player?.profileId ?? player?.profile_id ?? '').trim()).filter(id => /^\d+$/.test(id)));
  }
  function removeRealtimeMatch(matchId) {
    const id = String(matchId || '');
    if (!id) return false;
    let changed = false;
    for (const group of realtimeSocketGroups.values()) {
      if (group.matches.delete(id)) changed = true;
      if (group.lobbies.delete(id)) changed = true;
    }
    if (changed) scheduleRealtimeSocketPublish();
    return changed;
  }
  function upsertRealtimeMatch(group, rawMatch) {
    const id = socketMatchId(rawMatch);
    const match = normalizeSocketMatch(rawMatch);
    if (!id || !match) return false;
    const playerIds = socketMatchPlayerIds(rawMatch);
    let changed = false;
    if (playerIds.size) {
      for (const otherGroup of realtimeSocketGroups.values()) {
        for (const [otherId, otherMatch] of otherGroup.matches.entries()) {
          if (otherId !== id && [...socketMatchPlayerIds(otherMatch)].some(playerId => playerIds.has(playerId))) {
            otherGroup.matches.delete(otherId);
            changed = true;
          }
        }
      }
    }
    const previous = group.matches.get(id);
    group.matches.set(id, match);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(match)) changed = true;
    return changed;
  }
  function validateRealtimeMatchHourly(match) {
    if (!WebSocket || !match) return;
    const matchId = socketMatchId(match);
    const profileIds = [...socketMatchPlayerIds(match)];
    if (!matchId || !profileIds.length) return;
    const url = 'wss://socket.aoe2companion.com/listen?handler=ongoing-matches&profile_ids=' + profileIds.join(',');
    let socket;
    let settled = false;
    let timeout;
    const finish = active => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket?.close(); } catch {}
      if (!active) removeRealtimeMatch(matchId);
      else console.log('[realtime] hourly validation kept match ' + matchId);
    };
    timeout = setTimeout(() => finish(false), 7000);
    timeout.unref?.();
    try {
      socket = new WebSocket(url);
      socket.addEventListener('message', event => {
        let messages;
        try { messages = JSON.parse(String(event.data)); } catch { return; }
        if (!Array.isArray(messages)) messages = [messages];
        const current = messages.find(message => {
          const type = String(message?.type || '');
          const data = message?.data || {};
          const id = socketMatchId(data);
          const finished = data.finished != null && data.finished !== 0 && data.finished !== '';
          return id === matchId && type !== 'matchFinished' && !finished;
        });
        if (current) {
          const group = [...realtimeSocketGroups.values()].find(item => profileIds.some(id => item.ids.includes(id))) || [...realtimeSocketGroups.values()][0];
          if (group && upsertRealtimeMatch(group, current.data)) scheduleRealtimeSocketPublish();
          finish(true);
        } else finish(false);
      });
      socket.addEventListener('error', () => finish(false));
      socket.addEventListener('close', () => { if (!settled) finish(false); });
    } catch { finish(false); }
  }
  function validateRealtimeMatchesHourly() {
    const now = Math.floor(Date.now() / 1000);
    const seen = new Set();
    for (const group of realtimeSocketGroups.values()) {
      for (const match of group.matches.values()) {
        const id = socketMatchId(match);
        const started = Number(match.started || 0);
        const hour = started > 0 ? Math.floor((now - started) / 3600) : 0;
        if (!id || hour < 1) continue;
        seen.add(id + ':' + hour);
        if (!realtimeValidatedMatches.has(id + ':' + hour)) {
          realtimeValidatedMatches.set(id + ':' + hour, Date.now());
          validateRealtimeMatchHourly(match);
        }
      }
    }
    for (const key of realtimeValidatedMatches.keys()) if (!seen.has(key)) realtimeValidatedMatches.delete(key);
  }
  function startRealtimeValidationLoop() {
    if (realtimeValidationTimer) return;
    realtimeValidationTimer = setInterval(validateRealtimeMatchesHourly, 60000);
    realtimeValidationTimer.unref?.();
  }
  function normalizeSocketMatch(match) {
    if (!match || typeof match !== 'object') return null;
    const started = typeof match.started === 'string' ? Math.floor(Date.parse(match.started) / 1000) : Number(match.started || 0);
    const finished = typeof match.finished === 'string' ? Math.floor(Date.parse(match.finished) / 1000) : Number(match.finished || 0);
    return { ...match, id: match.id ?? match.matchId ?? null, started: Number.isFinite(started) ? started : 0, finished: Number.isFinite(finished) ? finished : 0, rms: match.rms || match.map || match.mapName || '', leaderboard: match.leaderboardId || match.leaderboard || '', players: Array.isArray(match.players) ? match.players.map(player => ({ ...player, id: player.id ?? player.profileId ?? null, civilization: player.civilization || player.civ || '', civilization_id: player.civilization_id || player.civ || '', country: player.country || '' })) : [] };
  }
  function socketStates() {
    const matchByProfile = new Map();
    for (const group of realtimeSocketGroups.values()) {
      for (const lobby of group.lobbies.values()) for (const player of Array.isArray(lobby.players) ? lobby.players : []) {
        const id = String(player.id ?? player.profileId ?? '').trim();
        if (/^\d+$/.test(id)) matchByProfile.set(id, lobby);
      }
      for (const match of group.matches.values()) for (const player of Array.isArray(match.players) ? match.players : []) {
        const id = String(player.id ?? player.profileId ?? '').trim();
        if (/^\d+$/.test(id) && !matchByProfile.has(id)) matchByProfile.set(id, match);
      }
    }
    return realtimeSocketProfileIds.map(profileId => { const match = matchByProfile.get(String(profileId)); return match ? normalizeRealtimeLatestMatch(match, profileId) : { profileId: String(profileId), status: 'offline', match: null }; });
  }
  async function publishRealtimeSocketState() {
    realtimeSocketPublishTimer = null;
    if (!realtimeSocketProfileIds.length) return;
    try {
      const payload = await buildEnrichedPayload(realtimeSocketProfileIds, socketStates(), 'aoe2companion-websocket');
      const key = realtimeSocketProfileIds.join(',');
      realtimePayloadCache = { key, payload };
      await writeFile(realtimePayloadPath, JSON.stringify({ key, payload }), 'utf8');
      console.log(`[realtime] websocket cache refreshed: ${payload.states.length} states`);
    } catch (error) { console.warn('[realtime] websocket cache publish failed:', error.message); }
  }
  function scheduleRealtimeSocketPublish() {
    if (realtimeSocketPublishTimer) return;
    realtimeSocketPublishTimer = setTimeout(() => publishRealtimeSocketState(), 300);
    realtimeSocketPublishTimer.unref?.();
  }
  function connectRealtimeSocketGroup(group) {
    if (!WebSocket) return;
    const generation = realtimeSocketGeneration;
    const url = `wss://socket.aoe2companion.com/listen?handler=ongoing-matches&profile_ids=${group.ids.join(',')}`;
    try {
      const socket = new WebSocket(url);
      group.socket = socket;
      group.connected = false;
      socket.addEventListener('open', () => { group.connected = true; group.failures = 0; console.log(`[realtime] websocket group ${group.index + 1} connected (${group.ids.length} profiles)`); });
      socket.addEventListener('message', event => {
        let messages; try { messages = JSON.parse(String(event.data)); } catch { return; }
        if (!Array.isArray(messages)) messages = [messages];
        let changed = false;
        for (const message of messages) {
          const type = String(message?.type || '');
          const data = message?.data || {};
          const id = socketMatchId(data);
          if (!id) continue;
          if (type === 'matchFinished') { if (group.matches.delete(id)) changed = true; }
          else if (type === 'matchAdded' || type === 'matchUpdated' || type === 'matchStarted') {
            if (upsertRealtimeMatch(group, data)) changed = true;
            if (type === 'matchAdded') Promise.resolve(onMatchAdded(data)).catch(error => console.warn('[danmaku] matchAdded hook failed:', error.message));
          }
        }
        if (changed) scheduleRealtimeSocketPublish();
      });
      socket.addEventListener('error', () => { group.connected = false; });
      socket.addEventListener('close', () => {
        group.connected = false;
        if (generation !== realtimeSocketGeneration) return;
        group.failures = (group.failures || 0) + 1;
        const delay = Math.min(60000, Math.max(5000, group.failures * 5000));
        clearTimeout(group.reconnectTimer);
        group.reconnectTimer = setTimeout(() => connectRealtimeSocketGroup(group), delay);
        group.reconnectTimer.unref?.();
        console.warn(`[realtime] websocket group ${group.index + 1} closed; reconnecting in ${Math.round(delay / 1000)}s`);
      });
    } catch (error) { group.connected = false; console.warn(`[realtime] websocket group ${group.index + 1} failed:`, error.message); }
  }
  function normalizeSocketLobby(data) {
    if (!data || typeof data !== 'object') return null;
    const rawPlayers = Array.isArray(data.players) ? data.players : Array.isArray(data.slots) ? data.slots : data.slots && typeof data.slots === 'object' ? Object.values(data.slots) : [];
    const players = rawPlayers.map(slot => {
      const player = slot?.player || slot?.user || slot;
      return { ...player, id: player?.id ?? player?.profileId ?? player?.profile_id ?? player?.userId ?? player?.user_id ?? null, name: player?.name || player?.alias || player?.profileName || '', civilization: player?.civilization || player?.civ || '', civilization_id: player?.civilization_id || player?.civilizationId || player?.civ || '', country: player?.country || '', rating: player?.rating ?? null, team: player?.team ?? slot?.team ?? null, color: player?.color ?? slot?.color ?? null };
    }).filter(player => player.id != null);
    const startedValue = data.started || data.startedAt || data.created || data.createdAt || data.updated || data.updatedAt;
    const parsedStarted = typeof startedValue === 'string' ? Math.floor(Date.parse(startedValue) / 1000) : Number(startedValue || 0);
    return { ...data, id: data.id ?? data.lobbyId ?? data.matchId ?? null, started: Number.isFinite(parsedStarted) && parsedStarted > 0 ? parsedStarted : Math.floor(Date.now() / 1000), finished: 0, rms: data.rms || data.map || data.mapName || data.map_type || '', leaderboard: '', server: data.server || data.region || '', lobby: true, players };
  }
  function connectRealtimeLobbyGroup(group) {
    if (!WebSocket) return;
    const generation = realtimeSocketGeneration;
    const url = `wss://socket.aoe2companion.com/listen?handler=lobbies&profile_ids=${group.ids.join(',')}`;
    try {
      const socket = new WebSocket(url);
      group.lobbySocket = socket;
      group.lobbyConnected = false;
      socket.addEventListener('open', () => { group.lobbyConnected = true; group.lobbyFailures = 0; console.log(`[realtime] lobby websocket group ${group.index + 1} connected (${group.ids.length} profiles)`); });
      socket.addEventListener('message', event => {
        let messages; try { messages = JSON.parse(String(event.data)); } catch { return; }
        if (!Array.isArray(messages)) messages = [messages];
        let changed = false;
        for (const message of messages) {
          const type = String(message?.type || '').toLowerCase();
          const data = message?.data || {};
          const id = String(data?.lobbyId ?? data?.id ?? data?.matchId ?? '');
          if (!id) continue;
          if (type.includes('removed') || type.includes('deleted') || type.includes('finished')) { group.lobbies.delete(id); changed = true; }
          else if (type.includes('added') || type.includes('updated') || type.includes('created') || type === '') { const lobby = normalizeSocketLobby(data); if (lobby) { group.lobbies.set(id, lobby); changed = true; } }
        }
        if (changed) scheduleRealtimeSocketPublish();
      });
      socket.addEventListener('error', () => { group.lobbyConnected = false; });
      socket.addEventListener('close', () => {
        group.lobbyConnected = false;
        if (generation !== realtimeSocketGeneration) return;
        group.lobbyFailures = (group.lobbyFailures || 0) + 1;
        const delay = Math.min(60000, Math.max(5000, group.lobbyFailures * 5000));
        clearTimeout(group.lobbyReconnectTimer);
        group.lobbyReconnectTimer = setTimeout(() => connectRealtimeLobbyGroup(group), delay);
        group.lobbyReconnectTimer.unref?.();
        console.warn(`[realtime] lobby websocket group ${group.index + 1} closed; reconnecting in ${Math.round(delay / 1000)}s`);
      });
    } catch (error) { group.lobbyConnected = false; console.warn(`[realtime] lobby websocket group ${group.index + 1} failed:`, error.message); }
  }

  async function startRealtimeWebSockets(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    if (key === realtimeSocketProfileIds.join(',') && realtimeSocketGroups.size) return;
    realtimeSocketGeneration += 1;
    for (const group of realtimeSocketGroups.values()) { clearTimeout(group.reconnectTimer); clearTimeout(group.lobbyReconnectTimer); try { group.socket?.close(); group.lobbySocket?.close(); } catch {} }
    realtimeSocketGroups.clear();
    realtimeSocketProfileIds = ids;
    for (let offset = 0, index = 0; offset < ids.length; offset += realtimeWebSocketBatchSize, index += 1) { const group = { index, ids: ids.slice(offset, offset + realtimeWebSocketBatchSize), matches: new Map(), lobbies: new Map(), connected: false, lobbyConnected: false, failures: 0, lobbyFailures: 0, socket: null, lobbySocket: null, reconnectTimer: null, lobbyReconnectTimer: null }; realtimeSocketGroups.set(index, group); connectRealtimeSocketGroup(group); connectRealtimeLobbyGroup(group); }
    startRealtimeValidationLoop();
  }
  function realtimeWebSocketsHealthy(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value)))];
    return ids.join(',') === realtimeSocketProfileIds.join(',') && realtimeSocketGroups.size > 0 && [...realtimeSocketGroups.values()].every(group => group.connected && group.lobbyConnected);
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

  return { normalizeRealtimeLatestMatch, refreshRealtimePayload, readCachedRealtimeLatestMatch, fetchRealtimeStates, getCachedPayload, startRealtimeWebSockets, realtimeWebSocketsHealthy };
}
