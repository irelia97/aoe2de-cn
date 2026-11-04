export function createRealtimeRatings({ fetchStats, onChange, concurrency = 8, now = Date.now }) {
  const cache = new Map();
  const pending = new Set();
  const queue = [];
  let running = 0;
  function drain() {
    while (running < concurrency && queue.length) {
      const id = queue.shift();
      running++;
      Promise.resolve().then(() => fetchStats(id, { rankedOnly:true })).then(rows => {
        const row = Array.isArray(rows) ? rows.find(item => Number(item.id) === 3 && Number(item.rating) > 0) : null;
        const rating = row ? Number(row.rating) : null;
        const previous = cache.get(id)?.rating ?? null;
        cache.set(id, { rating, refreshAt:now()+10*60*1000 });
        if (rating !== previous) onChange();
      }).catch(() => {
        cache.set(id, { rating:cache.get(id)?.rating ?? null, refreshAt:now()+60000 });
      }).finally(() => {
        pending.delete(id);
        running--;
        while (cache.size > 2000) cache.delete(cache.keys().next().value);
        drain();
      });
    }
  }
  return {
    get(ids) {
      const ratings = new Map();
      for (const id of new Set(ids.map(String))) {
        const entry = cache.get(id);
        if (entry?.rating != null) ratings.set(id,entry.rating);
        if ((!entry || entry.refreshAt <= now()) && !pending.has(id)) {
          pending.add(id);
          queue.push(id);
        }
      }
      drain();
      return ratings;
    },
    restore(states) {
      for (const state of states) {
        const players = [state.player,...(state.match?.players || []),...(state.lobby?.players || []),...(state.queue?.players || [])];
        for (const player of players) {
          const id = String(player?.profileId || '');
          const rating = Number(player?.rating1v1 ?? player?.rating);
          if (id && Number.isFinite(rating) && rating > 0 && !cache.has(id)) cache.set(id,{rating,refreshAt:now()});
        }
      }
    }
  };
}
