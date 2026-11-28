function createRealtimeCardFormat({ escapeHtml, realtimePlayerColor, countryFlag, realtimeCivIconMarkup, civilizationNameZh }) {
  function realtimeGroupedPlayers(match) {
    const players = Array.isArray(match?.players) ? match.players : [];
    const leaderboard = String(match?.leaderboard || '').toUpperCase();
    const teamGame = leaderboard.includes('TG') || players.length > 2;
    if (!teamGame) return null;
    const groups = new Map();
    players.forEach((player,index) => {
      const team=String(player.team ?? `team-${index+1}`);
      if (!groups.has(team)) groups.set(team,[]);
      groups.get(team).push({player,index});
    });
    return [...groups.entries()];
  }
  function realtimeLeaderboardLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '大厅局';
    const key = raw.toUpperCase().replace(/[\s-]+/g, '_');
    const names = {
      RM_1V1: '随机地图 1v1', RM_TG: '团队随机地图', RM_TEAM: '团队随机地图',
      EW_1V1: '帝国战争 1v1', EW_TG: '团队帝国战争', EW_TEAM: '团队帝国战争',
      DM_1V1: '死亡竞赛 1v1', DM_TG: '团队死亡竞赛', DM_TEAM: '团队死亡竞赛',
      QP_1V1: '快速匹配 1v1', QP_TG: '团队快速匹配', QP_TEAM: '团队快速匹配',
      UNRANKED: '非排位'
    };
    return names[key] || raw;
  }
  function realtimePlayerRow(player,index) {
    const color=Number(player.color);
    const number=Number.isFinite(color)&&color>0?color:index+1;
    const rating=player.ratingMode==='rm_1v1'?Number(player.rating):NaN;
    const ratingText=Number.isFinite(rating)&&rating>0?rating.toLocaleString('zh-CN'):'—';
    return `<div class="realtime-player-row"><span class="realtime-player-number" style="background:${escapeHtml(realtimePlayerColor(number,index))}">${number}</span><span class="realtime-country">${countryFlag(player.country)}</span><a class="realtime-player-name" href="/players/${encodeURIComponent(String(player.profileId||null))}"><strong>${escapeHtml(player.name||`玩家 ${player.profileId||''}`)}</strong></a><span class="realtime-player-civ">${realtimeCivIconMarkup(player.civilizationId)}${escapeHtml(civilizationNameZh(player.civilization||'未知文明'))}</span><span class="realtime-player-rating" title="1v1 随机地图分数">${ratingText}</span></div>`;
  }
  return { realtimeGroupedPlayers, realtimeLeaderboardLabel, realtimePlayerRow };
}
