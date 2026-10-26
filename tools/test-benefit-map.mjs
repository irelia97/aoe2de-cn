import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { benefitTechAliases, compactEnglish } from '../public/tech-tree.js';

const entities=JSON.parse(readFileSync(new URL('../public/tech-tree-data/entities.json',import.meta.url)));
const source=JSON.parse(readFileSync(new URL('../public/tech-tree-data/benefit-techs.json',import.meta.url)));
const compact=value=>String(value || '').replace(/\s+/g,'');
const entriesByName=new Set(source.entries.map(entry=>`${entry.kind}:${compact(entry.name)}`));
const entriesByEnglish=new Set(source.entries.filter(entry=>entry.englishName).map(entry=>`${entry.kind}:${compactEnglish(entry.englishName)}`));
const techNames=new Set(Object.values(entities).filter(entity=>entity.type==='Tech').map(entity=>compact(entity.name)));

test('all Seicing pages were collected without failures',()=>{
  assert.equal(source.entries.length,212);
  assert.deepEqual(source.failures,[]);
});

test('every referenced technology resolves to a local game technology',()=>{
  const missing=[...new Set(source.entries.flatMap(entry=>entry.benefits.map(item=>compact(item.tech))))]
    .filter(name=>!techNames.has(benefitTechAliases[name] || name));
  assert.deepEqual(missing,[]);
});

test('every playable unit and building resolves directly or through its base elite unit',()=>{
  const used=new Set();
  for(const filename of readdirSync(new URL('../public/tech-tree-data/civs/',import.meta.url))) {
    const tree=JSON.parse(readFileSync(new URL(`../public/tech-tree-data/civs/${filename}`,import.meta.url)));
    tree.nodes.filter(node=>node.available).forEach(node=>used.add(node.entity));
  }
  const missing=[...used].map(key=>entities[key]).filter(entity=>entity && ['Unit','Building'].includes(entity.type)).filter(entity=>{
    const chinese=compact(entity.name), english=compactEnglish(entity.englishName);
    return !entriesByName.has(`${entity.type}:${chinese}`)
      && !entriesByEnglish.has(`${entity.type}:${english}`)
      && !(entity.type==='Unit' && entriesByName.has(`Unit:${chinese.replace(/^精锐/,'')}`))
      && !(entity.type==='Unit' && entriesByEnglish.has(`Unit:${english.replace(/^elite/,'')}`));
  }).map(entity=>`${entity.type}:${compact(entity.name)}`);
  assert.deepEqual(missing,[]);
});
