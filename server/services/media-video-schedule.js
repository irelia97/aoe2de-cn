// Fixed daily round starts in Beijing (UTC+8), independent of the host timezone.
export function nextScheduledVideoRound(timestamp) {
  const offset = 8 * 60 * 60 * 1000;
  const local = new Date(timestamp + offset);
  for (const [hour, minute] of [[8, 30], [12, 1], [15, 30], [18, 1], [20, 0], [22, 30]]) {
    local.setUTCHours(hour, minute, 0, 0);
    if (local.getTime() - offset >= timestamp) return local.getTime() - offset;
  }
  local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(8, 30, 0, 0);
  return local.getTime() - offset;
}
