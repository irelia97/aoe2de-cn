export function tournamentPath(value) {
  try { return decodeURIComponent(new URL(value).pathname).replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
}
export function resolveTournament(event, tournaments) {
  const path = tournamentPath(event?.url);
  const byPath = path && tournaments.filter(item => {
    const candidate = tournamentPath(item.url);
    return candidate && (path === candidate || path.startsWith(`${candidate}/`));
  }).sort((a, b) => tournamentPath(b.url).length - tournamentPath(a.url).length)[0];
  if (byPath) return byPath;
  const key = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return tournaments.find(item => key(item.name) === key(event?.name));
}
