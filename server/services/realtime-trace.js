// Log only compact identifiers and decision fields, never full upstream payloads.
export function createRealtimeTrace({ write = line => console.log(line), now = Date.now } = {}) {
  let previous = new Map();
  const emit = (event, details) => write(`[realtime-trace] ${JSON.stringify({ at: new Date(now()).toISOString(), event, ...details })}`);
  return {
    event: emit,
    validation({ reason, profileId, expected, latest, status, decision }) {
      emit('validation', {
        reason, profileId: String(profileId), decision,
        expectedMatchId: String(expected?.matchId ?? expected?.id ?? ''),
        expectedStarted: expected?.started ?? null,
        latestMatchId: String(latest?.matchId ?? latest?.id ?? ''),
        latestStarted: latest?.started ?? null, latestFinished: latest?.finished ?? null,
        latestAbandoned: latest?.abandoned === true, latestLive: latest?.live ?? null,
        latestStatus: status
      });
    },
    publish(payload, source) {
      const current = new Map();
      for (const state of payload.states || []) {
        const profileId = String(state.profileId);
        const detail = {
          identity: String(state.identity || profileId), status: state.status,
          matchId: state.status === 'game' ? String(state.match?.id || '') : null,
          queueId: state.queue ? String(state.queue.id || '') : null,
          queueMatchId: state.queue?.matchId ? String(state.queue.matchId) : null,
          lobbyId: state.lobby ? String(state.lobby.id || '') : null,
          live: Boolean(state.live?.url), grace: Number(state.graceUntil) > now()
        };
        current.set(profileId, detail);
        const before = previous.get(profileId);
        if (before && JSON.stringify(before) !== JSON.stringify(detail)) emit('state-change', { source, profileId, before, after: detail });
      }
      if (!previous.size) emit('state-baseline', { source, profiles: current.size });
      for (const [profileId, before] of previous) if (!current.has(profileId)) emit('state-removed', { source, profileId, before });
      previous = current;
    }
  };
}
