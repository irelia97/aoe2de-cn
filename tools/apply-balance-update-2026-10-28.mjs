import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const entitiesPath = resolve(import.meta.dirname, '../public/tech-tree-data/entities.json');
const entities = JSON.parse(readFileSync(entitiesPath, 'utf8'));

function unit(id, englishName) {
  const entity = entities[`Unit:${id}`];
  if (!entity || entity.englishName !== englishName) {
    throw new Error(`Missing expected unit Unit:${id} (${englishName})`);
  }
  return entity;
}

function setBonusDamage(entity, armourClass, amount) {
  const attack = entity.stats.Attacks.find(item => item.Class === armourClass);
  if (!attack) throw new Error(`${entity.englishName} is missing attack class ${armourClass}`);
  attack.Amount = amount;
}

const champiScout = unit(2550, 'Champi Scout');
setBonusDamage(champiScout, 8, 2); // Scout Cavalry line
setBonusDamage(champiScout, 30, 2); // Camel Scout

for (const [id, name, hp] of [
  [873, 'Elephant Archer', 220],
  [875, 'Elite Elephant Archer', 270],
]) {
  const entity = unit(id, name);
  entity.stats.Cost.Food = 70;
  entity.stats.Cost.Gold = 80;
  entity.stats.HP = hp;
}

unit(2569, 'Bolas Rider').stats.Speed = 1.45;

writeFileSync(entitiesPath, `${JSON.stringify(entities)}\n`);
console.log('Applied the 2026-10-28 balance update.');
