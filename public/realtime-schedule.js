export function hasChinaOpponent(match) {
  return (Array.isArray(match?.opponents) ? match.opponents : []).some(player =>
    ['CN', 'CHINA', '中国'].includes(String(player?.countryCode || '').trim().toUpperCase()) ||
    ['CN', 'CHINA', '中国'].includes(String(player?.country || '').trim().toUpperCase()));
}
export function qualifiesForSchedule(match) {
  return /^(S|A|B)([- ]?TIER)?$/i.test(String(match?.tournament?.tier || match?.tier || '').trim()) || hasChinaOpponent(match);
}
export function scheduleTierLabel(match) {
  const tier = String(match?.tournament?.tier || match?.tier || '').trim();
  return tier ? `${tier}级` : '未定级';
}
