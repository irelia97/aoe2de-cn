import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(process.argv[2] || '.');
const cache = join(root, '.cache');
const pointerPath = join(cache, 'profile-index-current.json');
const pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
if (!/^profile-index-[\w-]+\.sqlite$/.test(pointer.filename || '')) throw new Error('缓存索引文件名无效');
const source = join(cache, pointer.filename);
const filename = `profile-index-${Date.now()}-${randomUUID()}.sqlite`;
const target = join(cache, filename);
const pointerTemp = `${pointerPath}.tmp`;

await copyFile(source, target);
const database = new DatabaseSync(target);
try {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='profile_bigram'").get()) {
    database.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE profile_bigram(term TEXT NOT NULL, profile_rowid INTEGER NOT NULL, PRIMARY KEY(term, profile_rowid)) WITHOUT ROWID; WITH RECURSIVE grams(profile_rowid, normalized, position, last_position) AS (SELECT rowid, lower(substr(name,1,80)), 1, length(substr(name,1,80))-1 FROM profiles WHERE length(name)>=2 UNION ALL SELECT profile_rowid, normalized, position+1, last_position FROM grams WHERE position<last_position) INSERT OR IGNORE INTO profile_bigram(term,profile_rowid) SELECT substr(normalized,position,2),profile_rowid FROM grams;");
  }
  database.prepare("INSERT OR REPLACE INTO profile_meta(key,value) VALUES('searchIndexVersion','2')").run();
} catch (error) {
  database.close();
  throw error;
}
database.close();
await writeFile(pointerTemp, JSON.stringify({ ...pointer, filename, searchIndexVersion:2 }), 'utf8');
await rename(pointerTemp, pointerPath);
console.log(JSON.stringify({ source:pointer.filename, filename, searchIndexVersion:2 }));
