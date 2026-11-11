const wiki = 'https://liquipedia.net/ageofempires/';
const day = 86_400_000;
const nameKey = value => String(value ?? '').normalize('NFC').trim().replace(/[_\s]+/g, ' ').toLowerCase();
const decode = value => value.replace(/&(?:amp|quot|apos|lt|gt|#39|#160);/g,
  entity => ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&#39;':"'",'&#160;':' '})[entity]);

function pageTitle(href) {
  const url = new URL(decode(href), wiki);
  if (!url.href.startsWith(wiki)) return '';
  return (url.pathname.endsWith('/index.php') ? url.searchParams.get('title') || '' :
    decodeURIComponent(url.pathname.slice(new URL(wiki).pathname.length))).replaceAll('_', ' ');
}

export function parseTeamDirectory(html) {
  if (!/<h2\b[^>]*\bid="Active_Teams"/i.test(html)) throw Error('Missing active team directory');
  const active = html.split(/<h2\b[^>]*\bid="Disbanded_Teams"/i)[0];
  const teams = [];
  for (const [table] of active.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const header = table.match(/<span class="team-template-text">\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
    if (!header) continue;
    const title = pageTitle(header[1]);
    if (!title) continue;
    const members = [];
    for (const [row] of table.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
      if (!cells[0]?.[1].includes('inline-player')) continue;
      const player = cells[0][1].match(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/i);
      if (!player) throw Error('Unrecognized member row in ' + title);
      members.push({ name: decode(player[2]).trim(), title: pageTitle(player[1]), role: decode((cells[2]?.[1] || '').replace(/<[^>]*>/g, '')).trim() });
    }
    teams.push({ title, name: decode(header[2]).trim(), members });
  }
  if (!teams.some(team => nameKey(team.title) === 'cn zhongsheng')) throw Error('Incomplete active team directory');
  return teams;
}

export function classifyTeam(wikitext, members) {
  const games = wikitext?.match(/^\|\s*games?\s*=\s*([^\r\n]*)/im)?.[1];
  const aoe2 = /^(?:aoe2(?:de)?|age of empires ii(?:\s*:\s*definitive edition)?)$/i;
  const matchesGame = Boolean(games?.split(',').some(game => aoe2.test(game.trim())));
  const explicitRoles = members.some(member => /^(?:aoe2(?:de)?|age of empires ii)\b/i.test(member.role));
  if (matchesGame || explicitRoles || /\{\{DISPLAYTITLE:[^}]*\(Age of Empires II team\)/i.test(wikitext || '')) return 'aoe2';
  return games?.trim() ? 'other' : 'unknown';
}

const confirmedProfiles = new Map([
  ['ning', '5623928'], ['addu', '5854345'], ['n0 chanc3', '2005653'],
  ['jupy', '231890'], ['pain', '5251865'], ['ique', '11192068'],
  ['stonepleaseaoe', '339835'], ['猪咪', '711407'], ['钢铁直男', '223271'],
  ['emil :d', '862991'], ['qin tian dragon', '5013791'], ['vinchester', '271202'],
  ['iantagonisti', '2589331'], ['mihai06', '288714'], ['lobodelanieve', '2920057']
]);
const preferredTeams = new Map([['628503', 'the amigos'], ['1995414', 'old school']]);

export function indexTeamRosters(teams, references) {
  const names = new Map();
  for (const [id, ref] of references) {
    const canonical = ref.canonicalProfileId || id;
    const normalized = nameKey(ref.name);
    if (!normalized || !/^\d+$/.test(canonical)) continue;
    if (!names.has(normalized)) names.set(normalized, new Set());
    names.get(normalized).add(canonical);
  }
  const byProfile = new Map(), unresolved = [], conflicts = [];
  for (const team of teams) for (const member of team.members) {
    const confirmed = confirmedProfiles.get(nameKey(member.title));
    const possible = new Set(confirmed ? [references.get(confirmed)?.canonicalProfileId || confirmed] : [
      ...(names.get(nameKey(member.name)) || []),
      ...(names.get(nameKey(member.title)) || [])
    ]);
    if (possible.size !== 1) {
      unresolved.push({ team: team.name, teamTitle: team.title, name: member.name, title: member.title,
        reason: possible.size ? 'multiple' : 'missing', candidates: [...possible] });
      continue;
    }
    const [id] = possible;
    if (!byProfile.has(id)) byProfile.set(id, new Map());
    if (!team.national) byProfile.get(id).set(nameKey(team.name), team.name);
  }
  for (const [id, choices] of byProfile) {
    const preferred = preferredTeams.get(id);
    if (choices.has(preferred)) byProfile.set(id, new Map([[preferred, choices.get(preferred)]]));
    else if (choices.size > 1) conflicts.push({ id, name: references.get(id)?.name, teams: [...choices.values()] });
  }
  return { byProfile, unresolved, conflicts };
}

export function createTeamRosterSync({ read, save, fetchDirectory, fetchTeamPages, references, onChange, now = Date.now }) {
  let snapshot, index, loading;
  const load = () => loading ??= read().then(JSON.parse).then(async saved => {
    if (saved.fetchedAt > 0 && saved.teams?.length) {
      index = indexTeamRosters(saved.teams, await references());
      snapshot = saved;
    }
  }).catch(error => { if (error.code !== 'ENOENT') console.warn('[team-rosters] cache:', error.message); });

  async function run() {
    await load();
    let delay = Math.max(0, (snapshot?.fetchedAt || 0) + day - now());
    if (!delay) {
      try {
        const directory = parseTeamDirectory(await fetchDirectory());
        const sources = await fetchTeamPages(directory.map(team => team.title));
        const previous = new Map((snapshot?.teams || []).map(team => [nameKey(team.title), team]));
        const teams = [], unknownTeams = [];
        for (const team of directory) {
          const source = sources.get(team.title);
          const kind = classifyTeam(source, team.members);
          const old = previous.get(nameKey(team.title));
          if (kind === 'aoe2') {
            const national = /^\|\s*national_team\s*=\s*(?:true|yes|1)\b/im.test(source || '');
            const members = team.members.filter(member => !/^(?:admin|manager|owner|coach)(?:\s|\/|$)|^(?:aoeo|aom|aoe[1345])\b/i.test(member.role));
            teams.push({ ...team, national, members: team.members.length || !old ? members : old.members });
          } else if (kind === 'unknown') {
            unknownTeams.push(team.title);
            if (old) teams.push(old);
          }
        }
        if (!teams.length || teams.length < (snapshot?.teams.length || 0) / 2) throw Error('Incomplete AoE2 team snapshot');
        const nextIndex = indexTeamRosters(teams, await references());
        const retired = new Map(Object.entries(snapshot?.retired || {}).map(([id, values]) => [id, new Set(values)]));
        for (const [id, choices] of index?.byProfile || []) {
          for (const choice of choices.keys()) if (!nextIndex.byProfile.get(id)?.has(choice)) {
            if (!retired.has(id)) retired.set(id, new Set());
            retired.get(id).add(choice);
          }
        }
        const next = { fetchedAt: now(), teams, unknownTeams, unresolved: nextIndex.unresolved, conflicts: nextIndex.conflicts,
          retired: Object.fromEntries([...retired].map(([id, values]) => [id, [...values]])) };
        await save(JSON.stringify(next));
        index = nextIndex;
        snapshot = next;
        delay = day;
        console.log('[team-rosters] synced:', teams.length, 'teams;', next.unresolved.length, 'unconfirmed roster entries');
        onChange();
      } catch (error) {
        delay = 60 * 60_000;
        console.warn('[team-rosters] refresh deferred:', error.message);
      }
    }
    setTimeout(run, delay).unref?.();
  }
  return {
    start() { void run(); },
    async apply(teams, refs, verified) {
      await load();
      if (!index) return teams;
      for (const [id, existing] of teams) {
        const canonical = verified.get(id)?.canonicalProfileId || refs.get(id)?.canonicalProfileId || id;
        const choices = index.byProfile.get(canonical) || index.byProfile.get(id);
        if (choices?.size === 1) teams.set(id, choices.values().next().value);
        else if (!choices?.size && snapshot.retired?.[canonical]?.includes(nameKey(existing))) teams.set(id, '');
      }
      return teams;
    }
  };
}
