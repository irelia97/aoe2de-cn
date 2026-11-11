const team = 'CN ZhongSheng';
const day = 86_400_000;
const key = name => String(name || '').trim().toLowerCase();

export function parseCnzsRoster(html) {
  const active = html.match(/<h3\b[^>]*\bid="Active"[^>]*>/i);
  const former = html.match(/<h3\b[^>]*\bid="Former"[^>]*>/i);
  if (!active || !former || former.index <= active.index) throw Error('Missing roster headings');
  const names = section => {
    const table = section.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
    if (!table) throw Error('Missing roster table');
    const players = [];
    for (const [row] of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const cell = row.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1];
      if (!cell) continue;
      const name = cell.match(/<a\b[^>]*>([^<]+)<\/a>/i)?.[1];
      if (!name?.trim()) throw Error('Unrecognized roster row');
      players.push(name.trim().replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'"));
    }
    if (!players.length) throw Error('Empty roster table');
    return players;
  };
  return { active: names(html.slice(active.index, former.index)), former: names(html.slice(former.index)) };
}

export function applyCnzsRoster(teams, references, verified, roster) {
  if (!roster) return teams;
  const active = new Set(roster.active.map(key));
  const former = new Set(roster.former.map(key));
  for (const [id, existing] of teams) {
    const canonical = verified.get(id)?.canonicalProfileId;
    const name = key(references.get(canonical)?.name || references.get(id)?.name);
    if (active.has(name)) teams.set(id, team);
    else if (former.has(name) && [key(team), 'cnzs'].includes(key(existing))) teams.set(id, '');
  }
  return teams;
}

export function createCnzsRoster({ read, save, fetchHtml, onChange, now = Date.now }) {
  let roster, loading, timer;
  function load() {
    return loading ??= read().then(JSON.parse).then(saved => {
      if (saved.fetchedAt > 0 && [saved.active, saved.former].every(
        list => Array.isArray(list) && list.length && list.every(name => typeof name === 'string' && name.trim())
      )) roster = saved;
    }).catch(error => {
      if (error.code !== 'ENOENT') console.warn('[cnzs-roster] cache:', error.message);
    });
  }
  async function refresh() {
    await load();
    let delay = Math.max(0, (roster?.fetchedAt || 0) + day - now());
    if (!delay) {
      try {
        const next = { ...parseCnzsRoster(await fetchHtml()), fetchedAt: now() };
        await save(JSON.stringify(next));
        roster = next;
        delay = day;
        console.log('[cnzs-roster] synced:', next.active.join(', '));
        onChange();
      } catch (error) {
        delay = 60 * 60_000;
        console.warn('[cnzs-roster] refresh deferred:', error.message);
      }
    }
    timer = setTimeout(refresh, delay);
    timer.unref?.();
  }
  return {
    async get() { await load(); return roster; },
    start() { void refresh(); }
  };
}
