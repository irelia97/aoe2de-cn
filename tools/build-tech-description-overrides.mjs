import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: node tools/build-tech-description-overrides.mjs <diff.txt>');

const root = resolve(import.meta.dirname, '..');
const entities = JSON.parse(readFileSync(resolve(root, 'public/tech-tree-data/entities.json'), 'utf8'));
const lines = readFileSync(input, 'utf8').trim().split(/\r?\n/);
const aliases = {
  '采石法': '石矿开采',
  '曼尼普尔骑兵': '曼尼普尔马',
  '征召': '征招',
  '预热射击': '加热射击',
  '库曼雇佣军': '库曼雇佣兵',
  '大篷车': '篷车',
  '配重': '配重块',
  '弩匣': '弩箭匣',
  '燃烧剂': '燃烧弹',
  'Malon': '突袭',
};
const normalized = value => String(value).replace(/[\s“”"']/g, '').toLowerCase();
const uniqueTechLabel = line => line.startsWith('• Malon (突袭) (') ? 'Malon (突袭)' : line.slice(2).split(' (')[0];
const byName = new Map(Object.entries(entities)
  .filter(([, entity]) => entity.type === 'Tech')
  .map(([key, entity]) => [normalized(entity.name), key]));
const overrides = {};
const absent = [];
const incomplete = [];
const repeated = [];

for (const line of lines) {
  const match = /^(\d+)\s+"?(.*?)"?$/.exec(line.trim());
  if (!match) throw new Error(`Invalid diff row: ${line}`);
  const [, stringId, raw] = match;
  let name;
  let body;
  if (stringId === '8059') {
    name = '弹射器';
    body = raw.replace(/^研究弹射器\s*/, '');
  } else {
    const text = raw.replace(/^研究\s*/, '');
    const offset = text.startsWith('Malon (突袭)') ? 'Malon (突袭)'.length : 0;
    const open = text.search(/[（(]/);
    const bodyOpen = offset ? text.slice(offset).search(/[（(]/) + offset : open;
    if (bodyOpen < 0) throw new Error(`No description body for ${stringId}`);
    name = offset ? 'Malon' : text.slice(0, bodyOpen).trim();
    body = text.slice(bodyOpen + 1).replace(/[)）]$/, '').trim();
  }
  if (stringId === '508024') {
    body = '骑马弩兵射程/视野/搜索范围 +1, 对步兵伤害 +2';
  }
  if (!body || /\+\s*$/.test(body)) {
    incomplete.push({ stringId, name });
    continue;
  }
  const key = byName.get(normalized(aliases[name] || name));
  if (!key) {
    absent.push({ stringId, name });
    continue;
  }
  if (key in overrides) repeated.push({ stringId, name, key });
  const heading = entities[key].description.split('\n')[0];
  overrides[key] = `${heading}\n${body}`;
}

const arrowUpgradeEffect = '弓兵单位、掷矛手、远程战船、远程防御工事等的攻击力/射程/视野 +1；城镇中心的攻击力 +1。';
for (const key of ['Tech:199', 'Tech:200', 'Tech:201']) {
  overrides[key] = `${entities[key].description.split('\n')[0]}\n${arrowUpgradeEffect}`;
}
const archerArmorTarget = '射手类、骑射手类、火枪手类、特殊骑兵类单位';
for (const key of ['Tech:211', 'Tech:212']) {
  overrides[key] = `${entities[key].description.split('\n')[0]}\n${archerArmorTarget}护甲 +1/盾牌 +1`;
}
overrides['Tech:219'] = `${entities['Tech:219'].description.split('\n')[0]}\n${archerArmorTarget}护甲 +1/盾牌 +2`;
overrides['Tech:1404'] = '研究环球探险\n将整个地图设置为已探索状态，船只训练时间 -25%';

const target = resolve(root, 'public/tech-tree-data/description-overrides.json');
const manifest = JSON.parse(readFileSync(resolve(root, 'public/tech-tree-data/manifest.json'), 'utf8'));
let updatedCivilizations = 0;
let updatedUniqueTechnologies = 0;
for (const civilization of manifest.civilizations) {
  const lines = civilization.description.split('\n');
  let section = lines.indexOf('独特科技：');
  if (section < 0 && civilization.id === 'jurchens') {
    section = lines.indexOf('独特单位：', lines.indexOf('独特单位：') + 1);
    if (section >= 0) lines[section] = '独特科技：';
  }
  if (section < 0) throw new Error(`Missing unique technology section: ${civilization.id}`);
  const end = lines.indexOf('团队加成：', section + 1);
  if (end < 0) throw new Error(`Missing team bonus section: ${civilization.id}`);
  const positions = lines.map((line, index) => line.startsWith('• ') && index > section && index < end ? index : -1).filter(index => index >= 0);
  const tree = JSON.parse(readFileSync(resolve(root, `public/tech-tree-data/civs/${civilization.id}.json`), 'utf8'));
  const uniqueKeys = [...new Set(tree.nodes.filter(node => node.unique && node.entity.startsWith('Tech:')).map(node => node.entity))];
  if (positions.length !== uniqueKeys.length) throw new Error(`Unique technology count mismatch: ${civilization.id}`);
  const assigned = new Map();
  const remaining = new Set(uniqueKeys);
  for (const position of positions) {
    const label = uniqueTechLabel(lines[position]);
    const key = uniqueKeys.find(candidate => remaining.has(candidate) && normalized(entities[candidate].name) === normalized(label));
    if (key) { assigned.set(position, key); remaining.delete(key); }
  }
  const unmatched = positions.filter(position => !assigned.has(position));
  if (unmatched.length !== remaining.size) throw new Error(`Ambiguous unique technology mapping: ${civilization.id}`);
  for (const [index, position] of unmatched.entries()) assigned.set(position, [...remaining][index]);
  for (const position of positions) {
    const key = assigned.get(position);
    if (!overrides[key]) continue;
    const label = uniqueTechLabel(lines[position]);
    const effect = overrides[key].split('\n').slice(1).join('\n');
    const updated = `• ${label} (${effect})`;
    if (lines[position] !== updated) { lines[position] = updated; updatedUniqueTechnologies++; }
  }
  const description = lines.join('\n');
  if (description !== civilization.description) {
    overrides[`Civilization:${civilization.id}`] = description;
    updatedCivilizations++;
  }
}
writeFileSync(target, JSON.stringify(overrides, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ rows: lines.length, updatedTechnologies: Object.keys(overrides).filter(key => key.startsWith('Tech:')).length, updatedCivilizations, updatedUniqueTechnologies, absent, incomplete, repeated }, null, 2));
