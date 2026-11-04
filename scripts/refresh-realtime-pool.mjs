import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realtimePinnedProfileIds, realtimeExcludedProfileIds } from '../server/services/realtime-player-names.js';
import { activityCutoff, personalActivity } from '../server/services/realtime-pool-activity.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, '.cache');
const sourcePath = join(root, 'config', 'players_pool.txt');
const outputPath = join(cacheDir, 'realtime-profile-pool.json');
const cutoff = activityCutoff();
let previous;
try { previous = JSON.parse(await readFile(outputPath, 'utf8')); } catch {}

const source = await readFile(sourcePath, 'utf8');
const baseIds = [...source.matchAll(/—\s*(\d+)/g)].map(match => match[1]).filter(Boolean);
const uniqueBaseIds = [...new Set(baseIds)].filter(id=>!realtimeExcludedProfileIds.has(id));
const results = [];
let cursor = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= uniqueBaseIds.length) return;
    const id = uniqueBaseIds[index];
    try {
      // Same persisted account data used by /api/profile-accounts. The fresh
      // official check below covers main accounts even if this cache is absent.
      const data = JSON.parse(await readFile(join(cacheDir, 'aoe2recs-profiles', `${id}.json`), 'utf8'));
      let accounts = Array.isArray(data.profile?.accounts) ? data.profile.accounts : [];
      // Ask the existing endpoint to refresh stale identity/account data using
      // its shared background cache, without blocking on upstream outages.
      if (Date.now() - Number(data.savedAt || 0) >= 48 * 60 * 60_000) {
        try {
          const response = await fetch(`http://127.0.0.1:3000/api/profile-accounts?id=${id}`, { signal: AbortSignal.timeout(5000) });
          const refreshed = await response.json();
          if (response.ok && Array.isArray(refreshed.accounts)) accounts = refreshed.accounts;
        } catch {}
      }
      results.push({ id, accounts });
    } catch (error) {
      results.push({ id, error: error.message || String(error) });
    }
  }
}

await Promise.all(Array.from({ length: 1 }, worker));

const candidates = new Set([...uniqueBaseIds, ...realtimePinnedProfileIds, ...(previous?.candidateIds || previous?.ids || [])].map(String).filter(id=>!realtimeExcludedProfileIds.has(id)));
const references = JSON.parse(await readFile(join(root, 'map', 'aoc-player-links.json'), 'utf8'));
for (const player of references.players || []) {
  const ids = (player.rl || []).map(String).filter(id=>/^\d+$/.test(id));
  if (ids.some(id=>uniqueBaseIds.includes(id))) for (const id of ids) if (!realtimeExcludedProfileIds.has(id)) candidates.add(id);
}
const lastTimes = new Map();
const selected = new Set();
let skippedVoobly = 0;
let skippedOld = 0;
let skippedUnknownTime = 0;

for (const result of results) {
  for (const account of result.accounts || []) {
    const id = String(account.id || '').trim();
    if (!/^\d+$/.test(id)) continue;
    if (realtimeExcludedProfileIds.has(id)) continue;
    const platform = String(account.platform || '').toLowerCase();
    if (platform === 'voobly') {
      skippedVoobly++;
      continue;
    }
    const last = Number(account.last || 0);
    candidates.add(id);
    if (last > (lastTimes.get(id) || 0)) lastTimes.set(id, last);
  }
}

// Supplement the account.last shown in the profile with fresh ranked activity.
// Never fetch lobby matches. Failed batches leave the current pool unchanged.
const candidateIds = [...candidates];
for (let offset = 0; offset < candidateIds.length; offset += 40) {
  let times;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const batch = candidateIds.slice(offset, offset + 40).map(Number);
      const response = await fetch('https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat?title=age2&profile_ids=' + encodeURIComponent(JSON.stringify(batch)), { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`Activity lookup failed: ${response.status}`);
      times = personalActivity(await response.json());
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  for (const [id, time] of times) if (time > (lastTimes.get(id) || 0)) lastTimes.set(id, time);
  console.log(`Activity checked ${Math.min(offset + 40, candidateIds.length)}/${candidateIds.length}`);
  await new Promise(resolve => setTimeout(resolve, 1000));
}
for (const id of candidateIds) {
  const last = lastTimes.get(id) || 0;
  if (!last) skippedUnknownTime++;
  else if (last < cutoff) skippedOld++;
  else selected.add(id);
}
if (!selected.size) throw new Error('Refusing to replace listener pool with an empty result');

await mkdir(cacheDir, { recursive: true });
const payload = {
  updatedAt: new Date().toISOString(),
  cutoff,
  sourceIds: uniqueBaseIds,
  candidateIds,
  activityWindow: '45 days',
  accountActivity: candidateIds.map(id=>({profileId:id,lastMatchTime:lastTimes.get(id)||null,active:selected.has(id)})),
  ids: [...selected],
  stats: {
    sourceCount: uniqueBaseIds.length,
    candidateCount: candidateIds.length,
    selectedCount: selected.size,
    skippedVoobly,
    skippedOld,
    skippedUnknownTime,
    missingAccountCache: results.filter(result => result.error).length,
    failed: 0
  }
};
await writeFile(`${outputPath}.tmp`, JSON.stringify(payload, null, 2) + '\n', 'utf8');
await rename(`${outputPath}.tmp`, outputPath);
console.log(JSON.stringify(payload.stats));
