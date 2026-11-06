const sourceKey = item => `${item.platform || ''}|${item.url || ''}`;
const nameKey = item => String(item.name || '').normalize('NFKC').trim().toLowerCase();
const profiles = item => (Array.isArray(item.profileIds) ? item.profileIds : []).map(String);

function sameStreamer(a, b) {
  if (sourceKey(a) === sourceKey(b)) return true;
  if (nameKey(a) && nameKey(a) === nameKey(b)) return true;
  const ids = new Set(profiles(a));
  return profiles(b).some(id => ids.has(id));
}

// Display preference may switch platforms while the streamer stays live.
// Announcements describe the streamer's presence, not a selected URL changing.
export function liveNotificationChanges(previous, current, failedSourceKeys = new Set()) {
  const distinct = items => items.filter((item, index) => !items.slice(0, index).some(other => sameStreamer(item, other)));
  return {
    started: distinct(current.filter(item => !previous.some(other => sameStreamer(item, other)))),
    ended: distinct(previous.filter(item => !failedSourceKeys.has(sourceKey(item)) && !current.some(other => sameStreamer(item, other))))
  };
}
