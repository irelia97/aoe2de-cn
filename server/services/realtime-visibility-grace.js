const period = 5 * 60 * 1000;
const hasStatus = state => ['game', 'queueing', 'matched', 'cancelled', 'lobby'].includes(state.status) || Boolean(state.live?.url);

export function createVisibilityGrace({ now = Date.now, onExpire = () => {} } = {}) {
  const records = new Map();
  function clear(id) {
    clearTimeout(records.get(id)?.timer);
    records.delete(id);
  }
  function remember(id, until = null) {
    clear(id);
    const record = { until };
    if (until) {
      record.timer = setTimeout(onExpire, Math.max(0, until - now()));
      record.timer.unref?.();
    }
    records.set(id, record);
    return record;
  }
  return {
    restore(states) {
      for (const state of states) {
        const id = String(state.profileId);
        if (hasStatus(state)) remember(id);
        else if (state.visibilityGrace?.until > now()) remember(id, state.visibilityGrace.until);
      }
    },
    apply(states) {
      const ids = new Set(states.map(state => String(state.profileId)));
      for (const id of records.keys()) if (!ids.has(id)) clear(id);
      return states.map(state => {
        const id = String(state.profileId);
        if (hasStatus(state)) {
          remember(id);
          return { ...state, graceUntil: null, visibilityGrace: undefined };
        }
        let record = records.get(id);
        if (record && record.until === null) record = remember(id, now() + period);
        // Preserve a persisted grace window even if no active state has been
        // observed yet during this process lifetime.
        if (!record && Number(state.graceUntil) > now()) record = remember(id, Number(state.graceUntil));
        if (record?.until > now()) return { ...state, graceUntil: record.until, visibilityGrace: { until: record.until } };
        clear(id);
        return { ...state, graceUntil: null, visibilityGrace: undefined };
      });
    }
  };
}
