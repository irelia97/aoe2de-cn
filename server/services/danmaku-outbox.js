import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function queueDanmakuMatch(directory, match) {
  const id = String(match.id ?? match.matchId ?? '');
  if (!/^\d+$/.test(id) || match.finished || match.abandoned) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(match), { mode: 0o600 });
  await rename(temporary, target);
}
