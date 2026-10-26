import { parentPort } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

let database, version, metadata, previousMetadata;
parentPort.on('message', ({ id, path, stamp, kind, filters }) => {
  try {
    if (version !== `${path}:${stamp}`) {
      database?.close();
      database = new DatabaseSync(path, { readOnly: true });
      database.exec('PRAGMA query_only=ON; PRAGMA cache_size=-16384; PRAGMA busy_timeout=1000;');
      metadata = JSON.parse(database.prepare("SELECT value FROM metadata WHERE key='metadata'").get().value);
      previousMetadata = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='previous_metadata'").get()
        ? JSON.parse(database.prepare("SELECT value FROM previous_metadata WHERE key='metadata'").get().value) : null;
      version = `${path}:${stamp}`;
    }
    if (kind === 'meta') { parentPort.postMessage({ id, data: metadata }); return; }
    if (kind === 'winrates') {
      const slugs = new Map(metadata.civs.map(item => [item.id, item.slug]));
      const rows = database.prepare(`SELECT mode,civ,
        CASE WHEN (mode='rm_1v1' AND elo>=4) OR (mode='rm_team' AND elo>=3) THEN 'high' ELSE 'low' END AS bracket,
        SUM(n) AS games,SUM(w) AS wins
        FROM civilization WHERE mode IN ('rm_1v1','rm_team')
        GROUP BY mode,civ,bracket`).all();
      const civilizations = {};
      for (const row of rows) {
        const slug = slugs.get(row.civ);
        if (!slug) continue;
        ((civilizations[slug] ||= {})[row.mode] ||= {})[row.bracket] = {
          games: row.games, wins: row.wins, winRate: row.games ? row.wins / row.games : null,
        };
      }
      parentPort.postMessage({ id, data: { dateFrom: metadata.dateFrom, dateTo: metadata.dateTo, generatedAt: metadata.generatedAt, civilizations } });
      return;
    }
    const { mode, map, elo, duration, civ } = filters;
    if (map !== null && !metadata.maps.some(item => item.id === map)) throw Object.assign(new Error('地图筛选无效'), { statusCode: 400 });
    const conditions = ['mode=?'], values = [mode];
    for (const [name, value] of [['map', map], ['elo', elo], ['duration', duration]]) {
      if (value !== null) { conditions.push(`${name}=?`); values.push(value); }
    }
    const where = conditions.join(' AND ');
    const totals = database.prepare(`SELECT coalesce(SUM(n),0) AS games FROM games WHERE ${where}`).get(...values);
    const totalGames = metadata.modes?.[mode]?.games ?? database.prepare('SELECT coalesce(SUM(n),0) AS n FROM games WHERE mode=?').get(mode).n;
    const overview = database.prepare(`SELECT civ,SUM(n) AS n,SUM(w) AS w FROM civilization WHERE ${where} GROUP BY civ ORDER BY 1.0*SUM(w)/SUM(n) DESC,SUM(n) DESC,civ`).all(...values);
    const byId = new Map(metadata.civs.map(item => [item.id, item.slug]));
    const players = overview.reduce((sum, row) => sum + row.n, 0);
    const civilizations = overview.map(row => ({
      civ: byId.get(row.civ), games: row.n, wins: row.w, losses: row.n - row.w,
      winRate: row.n ? row.w / row.n : null, usage: players ? row.n / players : 0,
    }));
    const comparable = previousMetadata && previousMetadata.dateFrom === metadata.dateFrom && previousMetadata.dateTo < metadata.dateTo
      && JSON.stringify(previousMetadata.ratingsByMode?.[mode] || previousMetadata.ratings) === JSON.stringify(metadata.ratingsByMode?.[mode] || metadata.ratings)
      && JSON.stringify(previousMetadata.durations) === JSON.stringify(metadata.durations);
    let previousWhere, previousValues, previousById;
    const previousRates = new Map();
    if (comparable) {
      const slug = metadata.maps.find(item => item.id === map)?.slug;
      const previousMap = map === null ? null : previousMetadata.maps.find(item => item.slug === slug)?.id;
      previousById = new Map(previousMetadata.civs.map(item => [item.id, item.slug]));
      if (map === null || previousMap !== undefined) {
        const conditions = ['mode=?']; previousValues = [mode];
        for (const [name,value] of [['map',previousMap],['elo',elo],['duration',duration]]) {
          if (value !== null) { conditions.push(`${name}=?`); previousValues.push(value); }
        }
        previousWhere = conditions.join(' AND ');
        const rows = database.prepare(`SELECT civ,SUM(n) n,SUM(w) w FROM previous_civilization WHERE ${previousWhere} GROUP BY civ`).all(...previousValues);
        const total = rows.reduce((sum,row) => sum+row.n,0);
        for (const row of rows) previousRates.set(previousById.get(row.civ), { winRate:row.w/row.n, usage:row.n/total });
      }
    }
    for (const row of civilizations) {
      const previous = previousRates.get(row.civ);
      row.winRateDelta = previous ? row.winRate-previous.winRate : comparable ? null : 0;
      row.usageDelta = previous ? row.usage-previous.usage : comparable ? null : 0;
    }
    const selected = metadata.civs.find(item => item.slug === civ)
      || metadata.civs.find(item => item.id === overview[0]?.civ);
    const matchups = selected ? database.prepare(`SELECT opponent,SUM(n) AS n,SUM(w) AS w,SUM(games) AS games
      FROM matchup WHERE ${where} AND civ=? GROUP BY opponent ORDER BY 1.0*SUM(w)/SUM(n) DESC,SUM(games) DESC,opponent`)
      .all(...values, selected.id).map(row => ({
        civ: byId.get(row.opponent), games: row.games, observations: row.n,
        wins: row.w, losses: row.n - row.w, winRate: row.n ? row.w / row.n : null,
      })) : [];
    const previousMatchups = new Map();
    const previousSelected = comparable && previousMetadata.civs.find(item => item.slug === selected?.slug);
    if (previousWhere && previousSelected) {
      for (const row of database.prepare(`SELECT opponent,SUM(n) n,SUM(w) w FROM previous_matchup WHERE ${previousWhere} AND civ=? GROUP BY opponent`).all(...previousValues,previousSelected.id)) {
        previousMatchups.set(previousById.get(row.opponent),row.w/row.n);
      }
    }
    for (const row of matchups) {
      row.winRateDelta = previousMatchups.has(row.civ) ? row.winRate-previousMatchups.get(row.civ) : comparable ? null : 0;
    }
    let trend = null;
    if (metadata.trendGranularity === 'weekly_cumulative' && selected) {
      const point = row => ({ date: row.date, games: row.games ?? row.n, observations: row.n,
        wins: row.w, winRate: row.n ? row.w / row.n : null });
      const historyConditions = ['mode=?', 'civ=?'], historyValues = [mode, selected.slug];
      for (const [name,value] of [['map',map === null ? null : metadata.maps.find(item => item.id === map)?.slug],['elo',elo],['duration',duration]]) {
        if (value !== null) { historyConditions.push(`${name}=?`); historyValues.push(value); }
      }
      const historyWhere = historyConditions.join(' AND ');
      const snapshots = database.prepare('SELECT date,generated_at,rules FROM trend_snapshots ORDER BY date').all().map(row => {
        const rules = JSON.parse(row.rules);
        return { date:row.date, generatedAt:row.generated_at, comparable: rules.dateFrom === metadata.dateFrom
          && JSON.stringify(rules.ratingsByMode?.[mode]) === JSON.stringify(metadata.ratingsByMode?.[mode] || metadata.ratings)
          && JSON.stringify(rules.durations) === JSON.stringify(metadata.durations) };
      });
      const allowed = new Set(snapshots.filter(row => row.comparable).map(row => row.date));
      trend = {
        granularity: metadata.trendGranularity, snapshots,
        overall: database.prepare(`SELECT snapshot date,SUM(n) n,SUM(w) w FROM trend_civilization WHERE ${historyWhere} GROUP BY snapshot ORDER BY snapshot`)
          .all(...historyValues).filter(row => allowed.has(row.date)).map(point),
        matchups: database.prepare(`SELECT snapshot date,opponent,SUM(n) n,SUM(w) w,SUM(games) games FROM trend_matchup WHERE ${historyWhere} GROUP BY snapshot,opponent ORDER BY snapshot,opponent`)
          .all(...historyValues).filter(row => allowed.has(row.date)).map(row => ({ ...point(row), civ:row.opponent })),
      };
    }
    parentPort.postMessage({ id, data: { mode, filters: { map, elo, duration },
      games: totals.games, totalGames, gameShare: totalGames ? totals.games / totalGames : 0, players, selectedCiv: selected?.slug || null, civilizations, matchups, trend,
      comparison: comparable ? { dateFrom: previousMetadata.dateFrom, dateTo: previousMetadata.dateTo, generatedAt: previousMetadata.generatedAt } : null,
      dateFrom: metadata.dateFrom, dateTo: metadata.dateTo, generatedAt: metadata.generatedAt } });
  } catch (error) { parentPort.postMessage({ id, error: error.message, statusCode: error.statusCode }); }
});
