export function activityCutoff(now = new Date()) {
  return Math.floor((now.getTime() - 45 * 24 * 60 * 60 * 1000) / 1000);
}

export function personalActivity(payload) {
  if (payload?.result?.code !== 0 || !Array.isArray(payload.statGroups) || !Array.isArray(payload.leaderboardStats)) throw new Error('Invalid official activity response');
  const groups = new Map(payload.statGroups.map(group => [String(group.id), (group.members || []).map(member => String(member.profile_id))]));
  const times = new Map();
  for (const stat of payload.leaderboardStats) for (const id of groups.get(String(stat.statgroup_id)) || []) {
    const time = Number(stat.lastmatchdate) || 0;
    if (time > (times.get(id) || 0)) times.set(id, time);
  }
  return times;
}
