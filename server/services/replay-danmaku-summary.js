import { collectEffectiveActionTimes, replayEapmStats, replayGameSpeed } from '../../public/replay-eapm.js';
import { collectPlayerAgeEvents } from '../../public/replay-player-ages.js';

export function formatResearchDelay(milliseconds) {
  const seconds = Math.round(Math.abs(milliseconds) / 1000);
  return seconds > 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

export function matchRatingChange(match, profileId) {
  const mode = String(match?.leaderboardId || match?.leaderboard || '').toLowerCase().replace(/ /g, '_');
  if (!/^(rm|dm|ew)_(1v1|tg|team)$/.test(mode)) return '';
  const players = (match.teams || []).flatMap(team => team.players || []).concat(match.players || []);
  const player = players.find(player => String(player.profileId ?? player.id) === String(profileId));
  const value = player?.ratingDiff ?? player?.ratingDelta;
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) >= 10000) return '积分未知';
  return `${value >= 0 ? '+' : ''}${Math.trunc(value)}分`;
}

export function formatReplayDanmaku(replay, profileId, playerNames = {}, ratingChange = '') {
  const players = (replay.summary?.teams || []).flatMap(team => team.players || []);
  const streamer = players.find(p => String(p.profile_id) === String(profileId));
  if (players.length < 2 || !streamer) throw new Error('录像玩家不匹配');
  const duration = Number(replay.summary.duration);
  if (!(duration > 0)) throw new Error('录像缺少游戏时长');
  const ages = collectPlayerAgeEvents(replay.full).filter(e => e.player === Number(streamer.player_number));
  const research = new Map();
  for (const chapter of replay.full?.chapters || []) for (const op of chapter.operations || []) {
    const item = op.Action?.action_data?.Research;
    if (!item || Number(item.player_id) !== Number(streamer.player_number)) continue;
    const tech = Number(item.technology_type), time = Number(op.Action.world_time);
    if ([202,203].includes(tech) && Number.isFinite(time) && (!research.has(tech) || time < research.get(tech))) research.set(tech,time);
  }
  function timing(age, tech, ageName, techName) {
    const upgrade = ages.find(e => e.age === age)?.time;
    const clicked = research.get(tech);
    if (clicked == null) return `未研究${techName}`;
    if (upgrade == null) return `${techName}：缺少升${ageName}记录`;
    const delta = clicked - upgrade;
    if (delta < 0) return `升${ageName}前${formatResearchDelay(delta)}点${techName}`;
    return `升${ageName}后${formatResearchDelay(delta)}点${techName}`;
  }
  const researchText = `${timing(1,202,'封建','双刃斧')}，${timing(2,203,'城堡','弓锯')}${ratingChange ? `, ${ratingChange}` : ''}`;
  if (players.length > 2) return researchText;
  const opponent = players.find(p => p !== streamer);
  const actions = collectEffectiveActionTimes(replay.full, players, duration, replayGameSpeed(replay.summary));
  const playerText = player => `${String(playerNames[String(player.profile_id)] ?? player.name).replace(/[\r\n]/g,' ')}(${replayEapmStats(actions.get(String(player.player_number)) || [], duration).global.toFixed(1)})`;
  return `eAPM ${playerText(streamer)} vs ${playerText(opponent)}，${researchText}`;
}
