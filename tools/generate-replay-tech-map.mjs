import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', path.sep);
const dataUrl = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/data.json';
const localeUrl = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/data/locales/zh/strings.json';
const treeIndexUrl = 'https://api.github.com/repos/SiegeEngineers/aoe2techtree/contents/data/trees';
const iconBase = 'https://raw.githubusercontent.com/SiegeEngineers/aoe2techtree/master/img/Tech';

const request = async (url) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'AOE2DE-CN-replay-map-generator' } });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return response;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError;
};
const json = async (url) => (await request(url)).json();
const binary = async (url) => Buffer.from(await (await request(url)).arrayBuffer());

const [data, zh, treeFiles] = await Promise.all([json(dataUrl), json(localeUrl), json(treeIndexUrl)]);
const techs = new Map();

for (const property of Object.values(data.data.Tech)) {
  const id = Number(property.ID);
  if (!Number.isFinite(id)) continue;
  techs.set(id, {
    id,
    name: zh[String(property.LanguageNameId)] || property.internal_name || `科技 ${id}`,
    internal_name: property.internal_name || '',
    picture_index: null,
  });
}

const trees = await Promise.all(treeFiles.filter((item) => item.name.endsWith('.json')).map((file) => json(file.download_url)));
const unitNodes = new Map();
for (const tree of trees) {
  for (const item of tree.units_techs || []) {
    if (item.use_type === 'Unit' && !unitNodes.has(Number(item.node_id))) {
      unitNodes.set(Number(item.node_id), item);
    }
    if (!['Research', 'UniqueTech'].includes(item.node_type)) continue;
    const id = Number(item.node_id);
    if (!Number.isFinite(id)) continue;
    const entry = techs.get(id) || { id, name: zh[String(item.name_string_id)] || item.name || `科技 ${id}`, internal_name: '' };
    if (entry.picture_index == null && Number.isFinite(Number(item.picture_index))) entry.picture_index = Number(item.picture_index);
    if (zh[String(item.name_string_id)]) entry.name = zh[String(item.name_string_id)];
    else if (!entry.name || entry.name === `科技 ${id}`) entry.name = item.name || entry.name;
    techs.set(id, entry);
  }
}

// Unit upgrades are stored separately from ordinary technologies in the source data.
for (const [unitId, upgrade] of Object.entries(data.data.unit_upgrades || {})) {
  const id = Number(upgrade.ID);
  const node = unitNodes.get(Number(unitId));
  if (!Number.isFinite(id) || techs.has(id) || !node || !Number.isInteger(node.picture_index)) continue;
  const unit = data.data.Unit[unitId];
  techs.set(id, {
    id,
    name: zh[String(node.name_string_id)] || zh[String(unit?.LanguageNameId)] || upgrade.internal_name || `科技 ${id}`,
    internal_name: upgrade.internal_name || '',
    picture_index: node.picture_index,
    icon_type: 'Unit',
    upgraded_unit_id: Number(unitId),
  });
}

const iconDir = path.join(root, 'public', 'assets', 'replay-tech-icons');
await mkdir(iconDir, { recursive: true });
// Local game exports cover historical, scenario and hidden technologies omitted by the web tree.
try {
  const supplement = JSON.parse(await readFile(path.join(root, 'config', 'replay-game-tech-supplement.json'), 'utf8'));
  for (const item of Object.values(supplement.technologies)) {
    const existing = techs.get(item.id);
    if (!existing || (existing.picture_index == null && item.picture_index != null)) {
      techs.set(item.id, item);
    } else {
      existing.name = item.name;
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const icons = new Map();
const gameIcons = new Set();
for (const item of techs.values()) {
  const type = item.icon_type || 'Tech';
  const index = item.picture_index;
  if (!Number.isInteger(index)) continue;
  if (type === 'GameTech') {
    await readFile(path.join(iconDir, `game-${index}.png`));
    gameIcons.add(index);
    continue;
  }
  const filename = type === 'Unit' ? `unit-${index}.png` : `${index}.png`;
  icons.set(filename, `${iconBase.replace(/Tech$/, type)}/${index}.png`);
}
await Promise.all([...icons].map(async ([filename, url]) => {
  await writeFile(path.join(iconDir, filename), await binary(url));
}));

for (const item of techs.values()) {
  item.icon = Number.isInteger(item.picture_index)
    ? `/assets/replay-tech-icons/${item.icon_type === 'Unit' ? 'unit-' : item.icon_type === 'GameTech' ? 'game-' : ''}${item.picture_index}.png`
    : '';
}

const output = Object.fromEntries([...techs.entries()].sort(([a], [b]) => a - b));
await writeFile(path.join(root, 'public', 'replay-tech-map.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`generated ${Object.keys(output).length} technologies and ${icons.size + gameIcons.size} referenced icons`);
