const forcedChinaProfileIds = new Set([
  '215442', '1432837', '3077860', '5602224', '6109694', '9414010', '9695965',
  '9873875', '10198859', '10710012', '11406458', '12926541', '20435955',
  '21333895', '22225320', '17001713'
]);

export function forceChinaCountry(profileId, fallback = '') {
  return forcedChinaProfileIds.has(String(profileId)) ? 'cn' : fallback;
}

export function isForcedChinaProfile(profileId) {
  return forcedChinaProfileIds.has(String(profileId));
}
