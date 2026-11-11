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
  return /^(S|A)([- ]?TIER)?$/i.test(String(match?.tournament?.tier || match?.tier || '').trim()) || hasChinaOpponent(match);
}
export function scheduleTierLabel(match) {
  const tier = String(match?.tournament?.tier || match?.tier || '').trim();
  return tier ? `${tier}级` : '未定级';
}
