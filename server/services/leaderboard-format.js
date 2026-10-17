export function leaderboardRowsFromPayloads(pages) {
  const groups = pages.flatMap(payload => payload.statGroups || []);
  const stats = new Map(pages.flatMap(payload => payload.leaderboardStats || []).map(row => [row.statgroup_id, row]));
  return groups.flatMap(group => (group.members || []).map(member => {
    const stat = stats.get(group.id);
    const steamId = member.name?.match(/^\/steam\/(\d+)$/)?.[1] || '';
    return stat ? { rank: stat.rank, name: member.alias || member.name || '未知玩家', alias: member.alias || '', clan: member.clan || '', country: member.country || '', rating: stat.rating, highestRating: stat.highestrating ?? stat.rating, wins: stat.wins, losses: stat.losses, streak: stat.streak, lastMatchDate: stat.lastmatchdate ?? null, profileId: member.profile_id, steamId } : [];
  })).sort((a, b) => a.rank - b.rank);
}

export function mergeLeaderboardData(base, pageData, maxRows = 2000) {
  const rows = new Map((base?.rows || []).map(row => [String(row.profileId), row]));
  for (const row of pageData.rows || []) rows.set(String(row.profileId), row);
  return {
    ...(base || pageData),
    total: Math.min(maxRows, pageData.total || base?.total || rows.size),
    pageSize: 100,
    pageCount: Math.min(Math.ceil(maxRows / 100), pageData.pageCount || base?.pageCount || Math.max(1, Math.ceil((pageData.total || rows.size) / 100))),
    loadedPages: [...new Set([...(base?.loadedPages || []), ...(pageData.loadedPages || [])])].sort((a, b) => a - b),
    rows: [...rows.values()].filter(row => Number(row.rank) <= maxRows).sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, maxRows)
  };
}
