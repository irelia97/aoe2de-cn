function templateAt(source, start) {
  let depth = 0;
  for (let i = start; i < source.length - 1; i++) {
    const pair = source.slice(i, i + 2);
    if (pair === '{{') { depth++; i++; }
    else if (pair === '}}') { depth--; i++; if (!depth) return source.slice(start, i + 1); }
  }
  return '';
}
const nameKey = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function tournamentRoundNameZh(value) {
  const text = String(value || '').trim();
  const names = { quarterfinals:'1/4决赛', quarterfinal:'1/4决赛', semifinals:'半决赛', semifinal:'半决赛', final:'决赛', finals:'决赛', grandfinal:'总决赛', grandfinals:'总决赛', thirdplacematch:'季军赛' };
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const size = text.match(/^(?:Round of\s*|Ro\s*)(\d+)$/i);
  return names[key] || (size ? `${size[1]}强` : text);
}
export function parseTournamentRounds(source) {
  const rows = [];
  for (const opening of source.matchAll(/\{\{Bracket\s*\|/gi)) {
    const bracket = templateAt(source, opening.index);
    if (!bracket) continue;
    const headers = new Map();
    for (const header of bracket.matchAll(/\|\s*(R\d+)M\d+header\s*=\s*([^\n\r]+)/gi)) {
      const text = header[2].replace(/\{\{[^{}]*\}\}/g, '').replace(/\s*\([^)]*\)/g, '').replace(/'{2,}/g, '').trim();
      if (text) headers.set(header[1].toUpperCase(), text);
    }
    for (const opening of bracket.matchAll(/\|\s*(R\d+)M\d+\s*=\s*(\{\{Match\b)/gi)) {
      const block = templateAt(bracket, opening.index + opening[0].lastIndexOf('{{'));
      const opponents = [1, 2].map(n => block.match(new RegExp('\\|\\s*opponent' + n + '\\s*=\\s*\\{\\{(?:Solo|Team)Opponent\\s*\\|\\s*([^|}\\r\\n]+)', 'i'))?.[1]?.trim() || '');
      const round = headers.get(opening[1].toUpperCase());
      const date = block.match(/\|\s*date\s*=\s*([^\n\r]+)/i)?.[1]?.replace(/\{\{abbr\/GMT\}\}/gi, '').trim() || '';
      if (round && opponents.every(Boolean)) rows.push({ round:tournamentRoundNameZh(round), opponents, date, bestOf: Number(block.match(/\|\s*bestof\s*=\s*(\d+)/i)?.[1]) || null });
    }
  }
  return rows;
}
export function findTournamentRound(match, rows) {
  const names = (match.opponents || []).map(p => nameKey(p.name)).sort();
  if (names.length !== 2 || names.some(n => !n || n === 'tbd')) return null;
  const candidates = rows.filter(row => row.opponents.map(nameKey).sort().every((name, i) => name === names[i]));
  const target = Number(match.timestamp) * 1000;
  const year = new Date(target).getUTCFullYear();
  const dated = candidates.map(row => {
    let date = row.date.replace(/\s+-\s+/, ' ');
    if (!/\b20\d{2}\b/.test(date)) date = date.replace(/^(\w+\s+\d+),?\s*/, `$1, ${year} `);
    return { row, distance: Math.abs(Date.parse(`${date} UTC`) - target) };
  }).filter(item => Number.isFinite(item.distance) && item.distance < 24 * 60 * 60_000).sort((a,b) => a.distance - b.distance);
  return dated.length && (dated.length === 1 || dated[0].distance < dated[1].distance) ? dated[0].row : null;
}
