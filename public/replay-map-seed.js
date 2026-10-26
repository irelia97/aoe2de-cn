// DE lobby layout: mgz/header/lobby.py. The Replay.random_seed fields are RNG
// state, not the random-map seed shown in the game's lobby/statistics.
// Search by independently decoded lobby settings, then validate chat framing
// and the complete versioned trailer. Ambiguous/unsupported data fails closed.
export function readLobbyMapSeed(header, summary) {
  const major = Number(summary?.header?.version_major);
  if (![66, 67, 68].includes(major)) return null;
  const settings = summary?.header?.game_settings;
  if (!settings) return null;
  if (['reveal_map','fog_of_war','map_size','population_limit','game_type','lock_teams']
    .some(key => settings[key] == null)) return null;
  const fields = [settings.reveal_map, settings.fog_of_war, settings.map_size,
    settings.population_limit, settings.game_type, settings.lock_teams].map(Number);
  if (fields.some(value => !Number.isInteger(value) || value < 0)
    || fields.slice(0,4).some(value => value > 0xffffffff)
    || fields[4] > 255 || fields[5] > 1 || fields[1] > 1) return null;
  const bytes = header instanceof Uint8Array ? header : new Uint8Array(header);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const candidates = [];
  for (let offset = Math.max(0, bytes.length - 1024 * 1024); offset + 18 + 10 + 4 + 4 + 23 <= bytes.length; offset++) {
    if (view.getUint32(offset,true) !== fields[0] || view.getUint32(offset+4,true) !== fields[1]
      || view.getUint32(offset+8,true) !== fields[2] || view.getUint32(offset+12,true) !== fields[3]
      || bytes[offset+16] !== fields[4] || bytes[offset+17] !== fields[5]) continue;
    let cursor = offset + 18;
    // Treaty, cheats-used and versioned lobby padding precede pre-game chat.
    if (bytes[cursor] !== Number(settings.treaty_length || 0)) continue;
    cursor += 10;
    const chats = view.getUint32(cursor,true); cursor += 4;
    if (chats > 1024) continue;
    let valid = true;
    for (let i=0; i<chats; i++) {
      if (cursor + 4 > bytes.length) { valid=false; break; }
      const size = view.getUint32(cursor,true); cursor += 4;
      if (size > 65536 || cursor + size > bytes.length
        || (size && bytes[cursor+size-1] !== 0)) { valid=false; break; }
      cursor += size;
    }
    if (!valid || cursor + 4 > bytes.length) continue;
    const trailer = bytes.length - cursor - 4;
    // Current DE variants have 23 or 24 trailer bytes after the signed seed.
    if (trailer !== 23 && trailer !== 24) continue;
    candidates.push(view.getInt32(cursor,true));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export async function extractReplayMapSeed(input, summary) {
  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length < 9) return null;
    const size = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0,true);
    if (size <= 8 || size > bytes.length) return null;
    const reader = new Blob([bytes.slice(8,size)]).stream()
      .pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const chunks = []; let total = 0;
    try {
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 64 * 1024 * 1024) { await reader.cancel(); return null; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const header = new Uint8Array(total); let offset=0;
    for (const chunk of chunks) { header.set(chunk,offset); offset+=chunk.length; }
    return readLobbyMapSeed(header,summary);
  } catch { return null; }
}
