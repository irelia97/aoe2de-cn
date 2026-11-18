const chinaRegions = new Set([
  'CN', 'HK', 'MO', 'TW',
  'CHINA', 'MAINLAND CHINA', 'HONG KONG', 'MACAU', 'MACAO', 'TAIWAN', 'CHINESE TAIPEI',
  '中国', '中國', '中国大陆', '中國大陸', '香港', '澳门', '澳門', '台湾', '台灣', '臺灣'
]);

export function hasChinaOpponent(match) {
  return (Array.isArray(match?.opponents) ? match.opponents : []).some(player =>
    [player?.countryCode, player?.country].some(value => chinaRegions.has(String(value || '').trim().toUpperCase())));
}
export function qualifiesForSchedule(match) {
  return match?.hasTournamentEloTop32Player === true
    || /^(S|A)([- ]?TIER)?$/i.test(String(match?.tournament?.tier || match?.tier || '').trim())
    || hasChinaOpponent(match);
}
export function scheduleTierLabel(match) {
  const tier = String(match?.tournament?.tier || match?.tier || '').trim();
  if (!tier) return '未定级';
  const type = String(match?.tournament?.tierType || match?.tierType || '').trim();
  if (/^show\s*match$/i.test(type) || /^show\s*match$/i.test(tier)) return '表演赛';
  const rank = tier.match(/^([SABC])(?:[- ]?TIER)?$/i)?.[1];
  if (rank) return `${rank.toUpperCase()}级`;
  return tier;
}
