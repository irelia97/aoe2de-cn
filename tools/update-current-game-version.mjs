import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const version = process.argv[2];
if (!/^\d+$/.test(version || '')) {
  throw new Error('Usage: node tools/update-current-game-version.mjs <numeric-version>');
}

const manifestPath = resolve(import.meta.dirname, '../public/tech-tree-data/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.gameVersion = version;
manifest.patchUrl = `https://www.ageofempires.com/news/age-of-empires-ii-definitive-edition-update-${version}/`;
writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
console.log(`Updated current game version to ${version}.`);
