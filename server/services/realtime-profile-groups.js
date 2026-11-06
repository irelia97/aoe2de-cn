export function splitRealtimeProfiles(profileIds, limit = 4) {
  const ids = [...new Set(profileIds.map(String))].filter(id => /^[1-9]\d*$/.test(id));
  const count = Math.min(limit, ids.length);
  const groups = [];
  let offset = 0;
  for (let index = 0; index < count; index++) {
    const size = Math.floor(ids.length / count) + (index < ids.length % count ? 1 : 0);
    groups.push(ids.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}
