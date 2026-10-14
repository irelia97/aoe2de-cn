import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cacheDir = join(root, '.cache');
const sourcePath = join(root, 'try.txt');
const outputPath = join(cacheDir, 'realtime-profile-pool.json');
const cutoff = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

const source = await readFile(sourcePath, 'utf8');
const baseIds = [...source.matchAll(/—\s*(\d+)/g)].map(match => match[1]).filter(Boolean);
const uniqueBaseIds = [...new Set(baseIds)];
const results = [];
let cursor = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= uniqueBaseIds.length) return;
    const id = uniqueBaseIds[index];
    try {
      const response = await fetch('http://127.0.0.1:3000/api/profile-accounts?id=' + encodeURIComponent(id), {
        signal: AbortSignal.timeout(45_000)
      });
      const data = await response.json();
      results.push({ id, accounts: Array.isArray(data.accounts) ? data.accounts : [] });
    } catch (error) {
      results.push({ id, error: error.message || String(error) });
    }
  }
}

await Promise.all(Array.from({ length: 1 }, worker));

const selected = new Set(uniqueBaseIds);
let accountCount = 0;
let skippedVoobly = 0;
let skippedOld = 0;
let skippedUnknownTime = 0;

for (const result of results) {
  for (const account of result.accounts || []) {
    const id = String(account.id || '').trim();
    if (!/^\d+$/.test(id)) continue;
    const platform = String(account.platform || '').toLowerCase();
    if (platform === 'voobly') {
      skippedVoobly++;
      continue;
    }
    const last = Number(account.last || 0);
    if (!last) {
      skippedUnknownTime++;
      continue;
    }
    if (last < cutoff) {
      skippedOld++;
      continue;
    }
    selected.add(id);
    accountCount++;
  }
}

await mkdir(cacheDir, { recursive: true });
const payload = {
  updatedAt: new Date().toISOString(),
  cutoff,
  sourceIds: uniqueBaseIds,
  ids: [...selected],
  stats: {
    sourceCount: uniqueBaseIds.length,
    accountCount,
    selectedCount: selected.size,
    skippedVoobly,
    skippedOld,
    skippedUnknownTime,
    failed: results.filter(result => result.error).length
  }
};
await writeFile(outputPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(payload.stats));
