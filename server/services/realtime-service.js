import { readQueueSnapshot } from './queue-snapshot.js';
import { createVisibilityGrace } from './realtime-visibility-grace.js';
import { createLobbyListener } from './realtime-lobbies.js';
import { createRealtimeRatings } from './realtime-ratings.js';
import { cleanRealtimePlayerName, realtimePlayerNameOverrides, realtimePlayerIdentityOverrides } from './realtime-player-names.js';

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
    getLiveTournamentForPlayer = () => null,
    WebSocket,
    onMatchAdded = () => {},
    notificationProfileIds = [],
    onMatchPreparing = () => {}
  } = deps;

  const notificationTasks = new Map();
  const lobbyListener = createLobbyListener({ WebSocket, onChange:() => scheduleRealtimeSocketPublish() });
  const realtimeRatings = createRealtimeRatings({ fetchStats:fetchPersonalLeaderboardStats, onChange:() => scheduleRealtimeSocketPublish() });
  const queueEntries = new Map();
  let queueRecheckPromise = null, nextQueueRecheckAt = 0;
  async function recheckExpiredQueues() {
    if (queueRecheckPromise || Date.now() < nextQueueRecheckAt) return;
    const expired = [...queueEntries].filter(([,entry]) => Date.now()-entry.seenAt > 300000);
    if (!expired.length) return;
    const generation = realtimeSocketGeneration;
    const ids = [...new Set(expired.flatMap(([,entry]) => (entry.data.players||[]).map(p=>String(p.profileId))).filter(id=>realtimeSocketProfileIds.includes(id)))];
    if (!ids.length) return;
    nextQueueRecheckAt = Date.now()+60000;
    queueRecheckPromise = Promise.resolve().then(()=>deps.readQueueSnapshot ? deps.readQueueSnapshot(ids) : readQueueSnapshot(WebSocket,ids)).then(rows=>{
      if (generation !== realtimeSocketGeneration) return;
      for (const [id,entry] of expired) {
        if (queueEntries.get(id) !== entry) continue;
        const monitored=(entry.data.players||[]).filter(p=>ids.includes(String(p.profileId)));
        const matching=rows.filter(row=>['queueing','matched'].includes(row.status)&&(row.players||[]).some(p=>monitored.some(m=>String(m.profileId)===String(p.profileId))));
        queueEntries.delete(id);
        for (const row of matching) {
          if (!queueEntries.has(row.id)) queueEntries.set(row.id,{data:{...row,displaySeed:entry.data.displaySeed},seenAt:Date.now()});
        }
        const absent=monitored.filter(p=>!matching.some(row=>(row.players||[]).some(m=>String(m.profileId)===String(p.profileId))));
        if (entry.data.status==='queueing' && absent.length) rememberQueueGrace({...entry.data,players:absent});
      }
      scheduleRealtimeSocketPublish();
    }).catch(error=>console.warn('[realtime] queue recheck failed; keeping existing state:',error.message)).finally(()=>{queueRecheckPromise=null;});
    return queueRecheckPromise;
  }
  const queueGrace = new Map();
  function rememberQueueGrace(data, until = Date.now() + 5*60*1000) {
    for (const player of data.players || []) {
      const id = String(player.profileId);
      if (!realtimeSocketProfileIds.includes(id)) continue;
      queueGrace.set(id, { until, queueId:data.id });
      const timer = setTimeout(() => {
        if (queueGrace.get(id)?.until !== until) return;
        queueGrace.delete(id); scheduleRealtimeSocketPublish();
      }, Math.max(0, until-Date.now()));
      timer.unref?.();
    }
  }
  const cancelledPlayers = new Map();
  let queueSocket, queueReconnectTimer;
  function queueState(profileId) {
    if (queueSocket?.readyState !== 1) return null;
    const now = Date.now();
    for (const [id, entry] of queueEntries) {
      if (now - entry.seenAt > 300000) void recheckExpiredQueues();
      const data = entry.data;
      if (!(data.players || []).some(p => String(p.profileId) === String(profileId))) continue;
      return { profileId: String(profileId), status: data.status, match: null, queue: data };
    }
    return null;
  }
  function connectQueueSocket() {
    if (!WebSocket) return;
    const generation = realtimeSocketGeneration;
    const socket = new WebSocket('wss://socket.aoe2companion.com/listen?handler=queueing');
    queueSocket = socket;
    socket.addEventListener('open', () => { queueEntries.clear(); console.log('[realtime] queueing connected'); });
    socket.addEventListener('message', event => {
      if (socket !== queueSocket) return;
      let messages; try { messages = JSON.parse(String(event.data)); } catch { return; }
      let changed = false;
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        const data = message.data;
        if (!data?.id) continue;
        if (message.type === 'queueingRemoved') {
          const prior = queueEntries.get(data.id)?.data;
          if (data.reason === 'left' && prior?.status === 'queueing' && Array.isArray(data.profileIds) && data.profileIds.length) {
            const leftIds = new Set(data.profileIds.map(String));
            const departed = (prior.players || []).filter(player => leftIds.has(String(player.profileId)));
            const remaining = (prior.players || []).filter(player => !leftIds.has(String(player.profileId)));
            if (departed.length) {
              rememberQueueGrace({ ...prior, players:departed });
              if (remaining.length) {
                queueEntries.set(data.id, { data:{ ...prior, players:remaining, partyLeaderProfileId:leftIds.has(String(prior.partyLeaderProfileId)) ? null : prior.partyLeaderProfileId }, seenAt:Date.now() });
              } else queueEntries.delete(data.id);
              changed = true;
            }
            continue;
          }
          if (prior?.status === 'queueing') rememberQueueGrace(prior);
          if (data.reason === 'cancelled' && prior?.status === 'matched') {
            const cancellingIds = new Set((Array.isArray(data.profileIds) ? data.profileIds : []).map(String));
            rememberQueueGrace({ ...prior, players:(prior.players || []).filter(player => !cancellingIds.has(String(player.profileId))) });
            const members = new Set((prior.players || []).map(p => String(p.profileId)));
            for (const id of Array.isArray(data.profileIds) ? data.profileIds : []) {
              const profileId = String(id);
              if (members.has(profileId) && realtimeSocketProfileIds.includes(profileId)) {
                queueGrace.delete(profileId);
                cancelledPlayers.set(profileId, { matchId: prior.matchId, cancelledAt: Date.now(), players: (prior.players || []).map(p => ({ profileId:String(p.profileId), name:p.name || '' })) });
                changed = true;
              }
            }
          }
          if (queueEntries.delete(data.id)) changed = true;
          continue;
        }
        const prior = queueEntries.get(data.id)?.data || {};
        const merged = { ...prior, ...data };
        if (!(merged.players || []).some(p => realtimeSocketProfileIds.includes(String(p.profileId)))) continue;
        for (const player of merged.players || []) { cancelledPlayers.delete(String(player.profileId)); queueGrace.delete(String(player.profileId)); }
        merged.displaySeed = prior.displaySeed ?? Math.random();
        queueEntries.set(data.id, { data: merged, seenAt: Date.now() });
        changed = true;
      }
      if (changed) scheduleRealtimeSocketPublish();
    });
    socket.addEventListener('error', () => console.warn('[realtime] queueing connection error'));
    socket.addEventListener('close', () => {
      if (socket !== queueSocket || generation !== realtimeSocketGeneration) return;
      queueEntries.clear(); scheduleRealtimeSocketPublish();
      queueReconnectTimer = setTimeout(connectQueueSocket, 5000); queueReconnectTimer.unref?.();
    });
  }
  function notifyActiveMatch(rawMatch) {
    const profileId = (rawMatch?.players || []).map(player => String(player.profileId ?? player.id))
      .find(id => notificationProfileIds.includes(id));
    if (!profileId) return;
    const state = normalizeRealtimeLatestMatch(rawMatch, profileId);
    const match = state.match;
    if (state.status !== 'game' || !match?.players || match.players.length < 2) return;
    if (!match.map || /^(unknown|未知地图)$/i.test(String(match.map).trim()) || !match.server) return;
    const id = String(match.id);
    if (notificationTasks.has(id)) return;
    Promise.resolve(onMatchPreparing(match)).catch(error => console.warn('[danmaku] browser preparation failed:', error.message));
    const task = Promise.resolve().then(async () => {
      match.players = await Promise.all(match.players.map(async player => {
        let rating = null;
        try {
          const rows = await fetchPersonalLeaderboardStats(String(player.profileId));
          const row = Array.isArray(rows) ? rows.find(item => Number(item.id) === 3 && Number.isFinite(Number(item.rating))) : null;
          if (row) rating = Number(row.rating);
        } catch {}
        return { ...player, rating, ratingMode: 'rm_1v1' };
      }));
      await onMatchAdded(match);
    }).catch(error => {
      notificationTasks.delete(id);
      console.warn('[danmaku] direct match hook failed:', error.message);
    });
    notificationTasks.set(id, task);
    if (notificationTasks.size > 2000) notificationTasks.delete(notificationTasks.keys().next().value);
  }

  function normalizeRealtimeLatestMatch(match, profileId) {
    if (!match || typeof match !== 'object') return { profileId: String(profileId), status: 'offline', match: null };
    const started = Number(match.started || 0);
    const finished = Number(match.finished || 0);
    const abandoned = match.abandoned === true;
    const now = Math.floor(Date.now() / 1000);
    // An unfinished record can be left behind by a disconnected or abandoned
    // match. Keep only plausible current matches in the realtime monitor.
    const activeAge = started > 0 && started <= now + 300 && now - started <= 3 * 60 * 60;
    const inProgress = Boolean(!abandoned && activeAge && (match.live || !finished));
    const status = inProgress ? 'game' : 'offline';
    return {
      profileId: String(profileId),
      status,
      match: {
        id: match.id ?? null,
        map: match.rms || '',
        leaderboard: match.leaderboard || '',
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
  const recentGames = new Map();
  const gracePeriod = 5 * 60 * 1000;
  const visibilityGrace = createVisibilityGrace({ onExpire: () => scheduleRealtimeSocketPublish() });

  function withGameGrace(states) {
    const now = Date.now();
    return states.map(state => {
      const id = String(state.profileId);
      if (state.status === 'game' && state.match) {
        recentGames.set(id, { state, endedAt: null });
        return { ...state, graceUntil: null };
      }
      let recent = recentGames.get(id);
      const finished = Number(state.match?.finished) * 1000;
      if (finished > 0 && finished <= now && (!recent || String(recent.state.match?.id) === String(state.match.id))) {
        if (!recent || recent.endedAt == null) {
          recent = { state, endedAt: finished };
          recentGames.set(id, recent);
        }
      }
      if (recent && recent.endedAt == null) recent.endedAt = now;
      if (recent && now < recent.endedAt + gracePeriod) {
        return { ...recent.state, ...state, status: 'offline', match: recent.state.match, graceUntil: recent.endedAt + gracePeriod };
      }
      recentGames.delete(id);
      return { ...state, graceUntil: null };
    });
  }

  async function buildEnrichedPayload(profileIds, states, source = 'aoe2companion-latest') {
    states = withGameGrace(states);
    states = states.map(state => {
      const lobby = lobbyListener.state(state.profileId);
      const queued = queueState(state.profileId);
      if (lobby && !queued) {
        cancelledPlayers.delete(String(state.profileId));
        queueGrace.delete(String(state.profileId));
        return lobby;
      }
      const cancelled = cancelledPlayers.get(String(state.profileId));
      if (cancelled) {
        if (state.status === 'game' && Number(state.match?.started)*1000 > cancelled.cancelledAt) cancelledPlayers.delete(String(state.profileId));
        else return { profileId:String(state.profileId), status:'cancelled', match:null, cancellation:cancelled };
      }
      if (!queued) {
        const grace = queueGrace.get(String(state.profileId));
        if (state.status === 'game') queueGrace.delete(String(state.profileId));
        else if (grace?.until > Date.now()) return { ...state, status:'offline', graceUntil:grace.until, queueGrace:grace };
        return state;
      }
      // A new queue supersedes stale game/grace records. A confirmed game
      // supersedes the matching countdown for that same match.
      if (queued.status === 'matched' && state.status === 'game' && String(state.match?.id) === String(queued.queue.matchId)) return state;
      return queued;
    });
    const liveByProfile = new Map();
    try {
      const media = await getMediaCache();
      for (const item of Array.isArray(media.live) ? media.live : []) {
        if (!item?.live) continue;
        const live = { title: item.title || '正在直播', url: item.url || '', platform: item.platform || '' };
        for (const profileId of Array.isArray(item.profileIds) ? item.profileIds : []) liveByProfile.set(String(profileId), live);
      }
    } catch {}
    // One visibility rule covers every transition, including socket gaps,
    // cancelled matches and ended streams. Live streams never expire here.
    states = visibilityGrace.apply(states.map(state => ({ ...state, live: liveByProfile.get(String(state.profileId)) || null })));
    // Read RM 1v1 from each player's profile data. Do not use the top-2000
    // leaderboard here: players outside that list would otherwise fall back
    // to the rating attached to the current match (for example RM TG).
    const activeProfileIds = [...new Set(states.flatMap(state => {
      const visible = state.status === 'game' || state.status === 'cancelled' || state.status === 'lobby' || state.queue || state.graceUntil > Date.now() || liveByProfile.has(String(state.profileId));
      if (!visible) return [];
      return [state.profileId, ...(state.status === 'game' && Array.isArray(state.match?.players) ? state.match.players.map(player => player.profileId) : []), ...(state.status === 'matched' ? (state.queue?.players || []).map(player => player.profileId) : []), ...(state.lobby?.players || []).map(player=>player.profileId)];
    }).map(id => String(id || '').trim()).filter(id => /^[1-9]\d*$/.test(id)))];
    // Publish status immediately using known ratings; new/expired ratings
    // refresh independently and trigger a later update for card ordering.
    const ratingMap = realtimeRatings.get(activeProfileIds);
    const realtimeReferences = await loadRlReference();
    const nameIds = states.flatMap(state => [state.profileId,...(state.match?.players||[]).map(p=>p.profileId),...(state.queue?.players||[]).map(p=>p.profileId),...(state.cancellation?.players||[]).map(p=>p.profileId),...(state.lobby?.players||[]).map(p=>p.profileId)]);
    const verifiedNames = deps.loadVerifiedRealtimeNames ? await deps.loadVerifiedRealtimeNames(nameIds) : new Map();
    const displayName = (id, name, clan='') => {
      const verified = verifiedNames.get(String(id));
      const reference = realtimeReferences.get(String(id));
      const identity = realtimePlayerIdentityOverrides.get(String(id)) || verified?.canonicalProfileId || reference?.canonicalProfileId || String(id);
      const canonical = realtimePlayerNameOverrides.get(String(id)) || realtimePlayerNameOverrides.get(identity) || verified?.name || reference?.name;
      return cleanRealtimePlayerName(canonical || name, canonical ? '' : clan);
    };
    function tournamentScoreForPlayer(tournament, playerNames) {
      const score = Array.isArray(tournament?.score) && tournament.score.length >= 2 ? tournament.score : null;
      const opponents = Array.isArray(tournament?.opponents) ? tournament.opponents : [];
      if (!score || opponents.length < 2) return score;
      const names = playerNames.map(value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);
      const side = opponents.findIndex(opponent => {
        const candidates = [opponent?.name, ...(Array.isArray(opponent?.members) ? opponent.members : [])]
          .map(value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''))
          .filter(Boolean);
        return names.some(name => candidates.some(candidate => candidate === name || candidate.startsWith(name) || name.startsWith(candidate)));
      });
      return side === 0 ? [score[0], score[1]] : side === 1 ? [score[1], score[0]] : score;
    }
    const enrichedStates = states.map(state => {
      const profile = localProfileDetails(state.profileId)?.player || {};
      const own = state.match?.players?.find(player => String(player.profileId) === String(state.profileId)) || {};
      const reference = realtimeReferences.get(String(state.profileId));
      const playerName = profile.name || own.name || `玩家 ${state.profileId}`;
      const profileAlias = String(playerName).split(/[.|｜]/).pop().trim();
      const tournament = state.match && !state.match.tournament
        ? (getLiveTournamentForPlayer(playerName)
          || getLiveTournamentForPlayer(profileAlias)
          || getLiveTournamentForPlayer(own.name))
        : null;
      const match = state.match && tournament
        ? {
          ...state.match,
          tournament,
          score: (() => {
            const score = tournamentScoreForPlayer(tournament, [playerName, profileAlias, own.name]);
            return Array.isArray(score)
              && score.length >= 2
              && score.some(value => String(value ?? '').trim() !== '')
              ? score
              : state.match.score;
          })()
        }
        : state.match;
      const ratedMatch = match ? { ...match, players: (match.players || []).map(player => ({ ...player, originalName:player.name, name:displayName(player.profileId,player.name,player.clan), rating: ratingMap.get(String(player.profileId)) ?? null, ratingMode: 'rm_1v1' })) } : null;
      const queue = state.queue ? { ...state.queue, players: (state.queue.players || []).map(p => ({ ...p, country:forceChinaCountry(p.profileId,p.country || ''), originalName:p.name, name:displayName(p.profileId,p.name,p.clan), rating1v1: ratingMap.get(String(p.profileId)) ?? null })) } : undefined;
      const cancellation = state.cancellation ? {...state.cancellation,players:(state.cancellation.players||[]).map(p=>({...p,name:displayName(p.profileId,p.name)}))} : undefined;
      if (state.lobby) state = { ...state, lobby:{...state.lobby, players:(state.lobby.players||[]).map(player=>({...player,country:forceChinaCountry(player.profileId,player.country || ''),name:displayName(player.profileId,player.name),rating:ratingMap.get(String(player.profileId))??null,ratingMode:'rm_1v1'}))} };
      return { ...state, ...(queue ? { queue } : {}), ...(cancellation?{cancellation}:{}), match: ratedMatch, identity: realtimePlayerIdentityOverrides.get(String(state.profileId)) || verifiedNames.get(String(state.profileId))?.canonicalProfileId || reference?.canonicalProfileId || String(state.profileId), live: liveByProfile.get(String(state.profileId)) || null, player: { profileId: String(state.profileId), originalName:playerName, name:displayName(state.profileId,playerName,profile.team), team: profile.team || '', country: profile.country_code || own.country || '', rating: ratingMap.get(String(state.profileId)) ?? null } };
    });
    return { source, checkedAt: new Date().toISOString(), states: enrichedStates };
  }

  async function buildRealtimePayload(profileIds) {
    return buildEnrichedPayload(profileIds, await fetchRealtimeStates(profileIds));
  }

  const realtimeWebSocketGroupCount = 4;
  const realtimeSocketGroups = new Map();
  let realtimeSocketGeneration = 0;
  let realtimeSocketProfileIds = [];
  let realtimeSocketPublishTimer = null;
  let realtimeValidationTimer = null;
  const realtimeValidatedMatches = new Map();
  const realtimeValidationConcurrency = 2;
  const realtimeValidationQueue = [];
  const realtimeValidationPending = new Set();
  let realtimeValidationActive = 0;
  let realtimeLastPublishAt = null;
  const realtimeValidationStats = { kept: 0, removed: 0, deferred: 0, lastRunAt: null, lastResult: null };

  function socketMatchId(match) { return String(match?.matchId ?? match?.match_id ?? match?.id ?? ''); }
  function socketMatchPlayerIds(match) {
    return new Set((Array.isArray(match?.players) ? match.players : []).map(player => String(player?.id ?? player?.profileId ?? player?.profile_id ?? '').trim()).filter(id => /^\d+$/.test(id)));
  }
  function removeRealtimeMatch(matchId, finishedAt = null) {
    const id = String(matchId || '');
    if (!id) return false;
    let changed = false;
    for (const group of realtimeSocketGroups.values()) {
      const match = group.matches.get(id);
      if (match) {
        const parsed = typeof finishedAt === 'string' ? Date.parse(finishedAt) : Number(finishedAt) * 1000;
        const endedAt = parsed > 0 && parsed <= Date.now() ? parsed : Date.now();
        for (const playerId of socketMatchPlayerIds(match)) {
          const recent = recentGames.get(String(playerId));
          if (!recent || String(recent.state.match?.id) === id) {
            recentGames.set(String(playerId), { state: normalizeRealtimeLatestMatch({ ...match, live: false, finished: Math.floor(endedAt / 1000) }, playerId), endedAt: recent?.endedAt ?? endedAt });
          }
        }
      }
      if (group.matches.delete(id)) changed = true;
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
    notifyActiveMatch(match);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(match)) changed = true;
    return changed;
  }
  async function validateRealtimeMatchEveryThirtyMinutes(match, generation = realtimeSocketGeneration, reason = 'periodic') {
    if (!match) return;
    const matchId = socketMatchId(match);
    const monitoredIds = new Set(realtimeSocketProfileIds.map(String));
    const profileIds = [...socketMatchPlayerIds(match)].sort((a, b) => Number(monitoredIds.has(b)) - Number(monitoredIds.has(a)));
    if (!matchId || !profileIds.length) return;
    let lastError = null;
    for (const profileId of profileIds) {
      try {
        const latest = await fetchLatestWorldsEdgeMatchOnce(profileId);
        if (generation !== realtimeSocketGeneration || ![...realtimeSocketGroups.values()].some(group => group.matches.get(matchId) === match)) return;
        if (!latest || !socketMatchId(latest)) throw new Error('empty match response; keeping existing state');
        const latestState = normalizeRealtimeLatestMatch(latest, profileId);
        const active = socketMatchId(latest) === matchId && latestState.status === 'game';
        if (active) {
          const group = [...realtimeSocketGroups.values()].find(item => item.ids.includes(profileId)) || [...realtimeSocketGroups.values()][0];
          if (group && upsertRealtimeMatch(group, latest)) scheduleRealtimeSocketPublish();
          realtimeValidationStats.kept += 1;
          realtimeValidationStats.lastResult = { matchId, result: 'kept', profileId };
          console.log(`[realtime] ${reason} API validation kept match ${matchId}`);
        } else {
          removeRealtimeMatch(matchId);
          realtimeValidationStats.removed += 1;
          realtimeValidationStats.lastResult = { matchId, result: 'removed', profileId };
          console.log(`[realtime] ${reason} API validation removed stale match ${matchId}`);
        }
        realtimeValidationStats.lastRunAt = new Date().toISOString();
        return;
      } catch (error) {
        lastError = error;
        if (error.rateLimited) break;
      }
    }
    realtimeValidationStats.deferred += 1;
    realtimeValidationStats.lastRunAt = new Date().toISOString();
    realtimeValidationStats.lastResult = { matchId, result: 'deferred', error: lastError?.message || 'all lookups failed' };
    console.warn('[realtime] 30-minute API validation deferred for match ' + matchId + ': ' + (lastError?.message || 'all lookups failed'));
  }
  function drainRealtimeValidationQueue() {
    while (realtimeValidationActive < realtimeValidationConcurrency && realtimeValidationQueue.length) {
      const { match, generation, reason } = realtimeValidationQueue.shift();
      realtimeValidationActive += 1;
      Promise.resolve(validateRealtimeMatchEveryThirtyMinutes(match, generation, reason))
        .catch(error => console.warn('[realtime] 30-minute API validation failed:', error.message))
        .finally(() => {
          realtimeValidationActive -= 1;
          realtimeValidationPending.delete(`${generation}:${socketMatchId(match)}`);
          const timer = setTimeout(drainRealtimeValidationQueue, 750);
          timer.unref?.();
        });
    }
  }
  function enqueueRealtimeValidation(match, reason = 'periodic') {
    const generation = realtimeSocketGeneration;
    const key = `${generation}:${socketMatchId(match)}`;
    if (realtimeValidationPending.has(key)) return;
    realtimeValidationPending.add(key);
    realtimeValidationQueue.push({ match, generation, reason });
    drainRealtimeValidationQueue();
  }
  function validateRealtimeMatchesEveryThirtyMinutes() {
    const now = Math.floor(Date.now() / 1000);
    const validationBucket = Math.floor(now / (30 * 60));
    const seen = new Set();
    for (const group of realtimeSocketGroups.values()) {
      for (const match of group.matches.values()) {
        const id = socketMatchId(match);
        const started = Number(match.started || 0);
        if (!id || started <= 0) continue;
        // Reconcile every active match every 30 minutes because events that
        // occur while a WebSocket is reconnecting are not replayed.
        const key = id + ':' + validationBucket;
        seen.add(key);
        if (!realtimeValidatedMatches.has(key)) {
          realtimeValidatedMatches.set(key, Date.now());
          enqueueRealtimeValidation(match);
        }
      }
    }
    for (const key of realtimeValidatedMatches.keys()) if (!seen.has(key)) realtimeValidatedMatches.delete(key);
  }
  function startRealtimeValidationLoop() {
    if (realtimeValidationTimer) return;
    realtimeValidationTimer = setInterval(() => { validateRealtimeMatchesEveryThirtyMinutes(); void recheckExpiredQueues(); }, 60000);
    realtimeValidationTimer.unref?.();
  }
  function normalizeSocketMatch(match) {
    if (!match || typeof match !== 'object') return null;
    const started = typeof match.started === 'string' ? Math.floor(Date.parse(match.started) / 1000) : Number(match.started || 0);
    const finished = typeof match.finished === 'string' ? Math.floor(Date.parse(match.finished) / 1000) : Number(match.finished || 0);
    const rawPlayers = Array.isArray(match.players) ? match.players : Array.isArray(match.teams) ? match.teams.flatMap(team => Array.isArray(team?.players) ? team.players : []) : [];
    return { ...match, id: match.id ?? match.matchId ?? null, started: Number.isFinite(started) ? started : 0, finished: Number.isFinite(finished) ? finished : 0, rms: [match.mapName, match.rms, match.map].find(value => value && !/^(unknown|未知地图)$/i.test(String(value).trim())) || '', leaderboard: match.leaderboard || match.leaderboardId || '', players: rawPlayers.map(player => ({ ...player, id: player.id ?? player.profileId ?? null, civilization: player.civilization || player.civ || '', civilization_id: player.civilization_id || player.civ || '', country: player.country || '' })) };
  }
  function socketStates() {
    const matchByProfile = new Map();
    for (const group of realtimeSocketGroups.values()) {
      for (const match of group.matches.values()) for (const player of Array.isArray(match.players) ? match.players : []) {
        const id = String(player.id ?? player.profileId ?? '').trim();
        if (/^\d+$/.test(id)) matchByProfile.set(id, match);
      }
    }
    return realtimeSocketProfileIds.map(profileId => { const match = matchByProfile.get(String(profileId)); return match ? normalizeRealtimeLatestMatch(match, profileId) : { profileId: String(profileId), status: 'offline', match: null }; });
  }
  async function publishRealtimeSocketState() {
    realtimeSocketPublishTimer = null;
    if (!realtimeSocketProfileIds.length) return;
    try {
      for (const group of realtimeSocketGroups.values()) for (const match of group.matches.values()) notifyActiveMatch(match);
      const payload = await buildEnrichedPayload(realtimeSocketProfileIds, socketStates(), 'aoe2companion-websocket');
      const key = realtimeSocketProfileIds.join(',');
      realtimePayloadCache = { key, payload };
      await writeFile(realtimePayloadPath, JSON.stringify({ key, payload }), 'utf8');
      realtimeLastPublishAt = payload.checkedAt;
      // Notifications run independently at ingestion; list enrichment must not delay them.
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
    const url = `wss://socket.aoe2companion.com/listen?handler=match-updated&profile_ids=${group.ids.join(',')}`;
    try {
      const socket = new WebSocket(url);
      group.socket = socket;
      group.connected = false;
      socket.addEventListener('open', () => {
        if (generation !== realtimeSocketGeneration || group.socket !== socket) return;
        group.connected = true; group.connectedAt = new Date().toISOString(); group.failures = 0;
        group.lastMessageAt = null;
        console.log(`[realtime] match-updated group ${group.index + 1} connected (${group.ids.length} profiles)`);
        // Includes warm-start matches on the first connection, as well as
        // matches whose end event may have been missed while disconnected.
        for (const match of group.matches.values()) enqueueRealtimeValidation(match, 'reconnect');
      });
      socket.addEventListener('message', event => {
        let messages; try { messages = JSON.parse(String(event.data)); } catch { return; }
        if (!Array.isArray(messages)) messages = [messages];
        group.lastMessageAt = new Date().toISOString();
        group.messagesReceived += messages.length;
        let changed = false;
        for (const message of messages) {
          const type = String(message?.type || '');
          const data = message?.data || message || {};
          const id = socketMatchId(data);
          if (!id) continue;
          const finished = data.finished != null && data.finished !== 0 && data.finished !== '';
          const abandoned = data.abandoned === true;
          if (finished || abandoned) {
            if (removeRealtimeMatch(id, data.finished)) changed = true;
          }
          else if (!type || type === 'matchAdded' || type === 'matchUpdated' || type === 'matchStarted') {
            if (upsertRealtimeMatch(group, data)) changed = true;
          }
        }
        if (changed) scheduleRealtimeSocketPublish();
      });
      socket.addEventListener('error', () => { group.connected = false; });
      socket.addEventListener('close', () => {
        group.connected = false;
        group.disconnectedAt = new Date().toISOString();
        if (generation !== realtimeSocketGeneration) return;
        group.failures = (group.failures || 0) + 1;
        group.reconnectCount += 1;
        const delay = Math.min(60000, Math.max(5000, group.failures * 5000));
        clearTimeout(group.reconnectTimer);
        group.reconnectTimer = setTimeout(() => connectRealtimeSocketGroup(group), delay);
        group.reconnectTimer.unref?.();
        console.warn(`[realtime] match-updated group ${group.index + 1} closed; reconnecting in ${Math.round(delay / 1000)}s`);
      });
    } catch (error) { group.connected = false; console.warn(`[realtime] match-updated group ${group.index + 1} failed:`, error.message); }
  }
  async function startRealtimeWebSockets(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    if (key === realtimeSocketProfileIds.join(',') && realtimeSocketGroups.size) return;
    realtimeSocketGeneration += 1;
    clearTimeout(queueReconnectTimer);
    const previousQueueSocket = queueSocket; queueSocket = null;
    try { previousQueueSocket?.close(); } catch {}
    queueEntries.clear();
    for (const group of realtimeSocketGroups.values()) { clearTimeout(group.reconnectTimer); try { group.socket?.close(); } catch {} }
    realtimeSocketGroups.clear();
    realtimeSocketProfileIds = ids;
    const batchSize = Math.max(1, Math.ceil(ids.length / realtimeWebSocketGroupCount));
    for (let offset = 0, index = 0; offset < ids.length; offset += batchSize, index += 1) {
      const group = {
        index, ids: ids.slice(offset, offset + batchSize), matches: new Map(),
        connected: false, connectedAt: null, disconnectedAt: null, lastMessageAt: null, messagesReceived: 0, reconnectCount: 0, failures: 0, socket: null, reconnectTimer: null
      };
      realtimeSocketGroups.set(index, group);
    }
    let cachedPayload = await getCachedPayload(ids);
    // When the monitored-player pool changes, the persisted payload key no
    // longer matches even though it may still contain valid ongoing matches.
    // Restore that payload as a warm start so the realtime page does not go
    // blank while the scheduled API reconciliation catches up.
    if (!cachedPayload) {
      try {
        const persisted = JSON.parse(await readFile(realtimePayloadPath, 'utf8'));
        if (persisted?.payload?.states) cachedPayload = persisted.payload;
      } catch {}
    }
    realtimeRatings.restore(cachedPayload?.states || []);
    visibilityGrace.restore((cachedPayload?.states || []).filter(state => ids.includes(String(state.profileId))));
    for (const state of Array.isArray(cachedPayload?.states) ? cachedPayload.states : []) {
      if (state.queueGrace?.until > Date.now()) rememberQueueGrace({ id:state.queueGrace.queueId, players:[{profileId:state.profileId}] }, state.queueGrace.until);
      if (state.status === 'cancelled' && state.cancellation && ids.includes(String(state.profileId))) cancelledPlayers.set(String(state.profileId), state.cancellation);
      if (state.graceUntil > Date.now() && state.match) {
        recentGames.set(String(state.profileId), { state, endedAt: state.graceUntil - gracePeriod });
      }
      if (state?.status !== 'game' || !state.match) continue;
      const group = [...realtimeSocketGroups.values()].find(item => item.ids.includes(String(state.profileId)));
      if (!group) continue;
      upsertRealtimeMatch(group, {
        ...state.match,
        matchId: state.match.id,
        rms: state.match.map,
        players: Array.isArray(state.match.players) ? state.match.players.map(player => ({ ...player, id: player.profileId, civilization_id: player.civilizationId })) : []
      });
    }
    for (const group of realtimeSocketGroups.values()) connectRealtimeSocketGroup(group);
    if (ids.length) connectQueueSocket();
    lobbyListener.start(ids);
    // Republish restored matches immediately so newly loaded enrichments,
    // such as Liquipedia tournament metadata, are reflected without waiting
    // for the next WebSocket event.
    if ([...realtimeSocketGroups.values()].some(group => group.matches.size)) scheduleRealtimeSocketPublish();
    startRealtimeValidationLoop();
  }
  function realtimeWebSocketsHealthy(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value)))];
    return ids.join(',') === realtimeSocketProfileIds.join(',') && realtimeSocketGroups.size > 0 && [...realtimeSocketGroups.values()].every(group => group.connected);
  }

  async function refreshRealtimePayload(profileIds) {
    const ids = [...new Set((Array.isArray(profileIds) ? profileIds : []).map(value => String(value).trim()).filter(value => /^\d+$/.test(value) && Number(value) > 0))];
    const key = ids.join(',');
    if (realtimeRefreshPromise) return realtimeRefreshPromise;
    realtimeRefreshPromise = (async () => {
      const payload = await buildRealtimePayload(ids);
      realtimePayloadCache = { key, payload };
      await writeFile(realtimePayloadPath, JSON.stringify({ key, payload }), 'utf8');
      realtimeLastPublishAt = payload.checkedAt;
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
    const activeIds = [...new Set(states.filter(state => state.status === 'game' && state.match).flatMap(state => Array.isArray(state.match.players) ? state.match.players.map(player => player.profileId) : []).map(value => String(value || '').trim()).filter(value => /^[0-9]+$/.test(value)))];
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

  function getRealtimeStatus() {
    return {
      healthy: realtimeSocketGroups.size > 0 && [...realtimeSocketGroups.values()].every(group => group.connected),
      profileCount: realtimeSocketProfileIds.length,
      groupCount: realtimeSocketGroups.size,
      socketCount: realtimeSocketGroups.size,
      lobbies: lobbyListener.status(),
      checkedAt: realtimePayloadCache?.payload?.checkedAt || null,
      lastPublishAt: realtimeLastPublishAt,
      groups: [...realtimeSocketGroups.values()].map(group => ({
        group: group.index + 1,
        profileCount: group.ids.length,
        connected: group.connected,
        connectedAt: group.connectedAt,
        disconnectedAt: group.disconnectedAt,
        lastMessageAt: group.lastMessageAt,
        messagesReceived: group.messagesReceived,
        reconnectCount: group.reconnectCount,
        matchCount: group.matches.size
      })),
      validation: { ...realtimeValidationStats, active: realtimeValidationActive, queued: realtimeValidationQueue.length }
    };
  }

  return { normalizeRealtimeLatestMatch, refreshRealtimePayload, readCachedRealtimeLatestMatch, fetchRealtimeStates, getCachedPayload, getRealtimeStatus, startRealtimeWebSockets, realtimeWebSocketsHealthy };
}
