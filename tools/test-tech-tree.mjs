import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,existsSync,readdirSync } from 'node:fs';
import { filterTechTree,techTreeRelations,orderedCosts,layoutTechTree,uniqueUnitNodes,civilizationBonusSections,fullwidthChinesePunctuation } from '../public/tech-tree.js';
import { armorClassNames } from '../public/tech-tree-classes.js';
import { allowedPlayerColors,randomPlayerColor,colorPortrait } from '../public/tech-tree-player-colors.js';
import { civilizationTechTreeUrl } from '../public/civilizations.js';
import { portraitColors,portraitAssetUrl } from '../public/tech-tree-fixed-portraits.js';
import { civilizationPinyin } from '../public/civilization-pinyin.js';
import { civilizationMatches } from '../public/civilization-combobox.js';

const load = path => JSON.parse(readFileSync(new URL(`../public/tech-tree-data/${path}`,import.meta.url),'utf8'));
const manifest=load('manifest.json'),entities=load('entities.json'),overrides=load('description-overrides.json'),chinese=load('civs/chinese.json');

test('every civilization supports full pinyin and initials search',()=>{
  assert.deepEqual(Object.keys(civilizationPinyin).sort(),manifest.civilizations.map(civ=>civ.id).sort());
  for(const civ of manifest.civilizations) {
    const choice={value:civ.id,label:`${civ.name} · ${civ.englishName}`,search:civ.id};
    const syllables=civilizationPinyin[civ.id].split(' ');
    assert.ok(civilizationMatches(choice,syllables.join('')),`${civ.id}: full pinyin`);
    assert.ok(civilizationMatches(choice,syllables.map(part=>part[0]).join('')),`${civ.id}: initials`);
  }
  assert.ok(civilizationMatches({value:'cumans',label:'库曼 · Cumans',search:'cumans'},'ku man'));
  assert.ok(civilizationMatches({value:'jurchens',label:'女真',search:'Jurchens'},'nuzhen'));
});

test('Chinese descriptions use fullwidth punctuation while numeric values stay intact',()=>{
  assert.equal(fullwidthChinesePunctuation('射程 +1, 伤害 +0.5; 移动速度 +25% (城堡)'),'射程 +1， 伤害 +0.5； 移动速度 +25% （城堡）');
  assert.equal(fullwidthChinesePunctuation('己方&同盟方 [上限 5 个]。'),'己方＆同盟方 ［上限 5 个］。');
  assert.equal(fullwidthChinesePunctuation('HP/min +0.5'),'HP/min +0.5');
});

test('wrapped civilization bonus text remains one bullet',()=>{
  const malians=manifest.civilizations.find(civ=>civ.id==='malians');
  const bonus=civilizationBonusSections(malians.description).sections[0].lines;
  assert.equal(bonus.length,3);
  assert.equal(bonus[2],'• 兵营单位在封建/城堡/帝王时代的远程护甲 +1/+2/+3');
  for(const civ of manifest.civilizations){
    const lines=civilizationBonusSections(civ.description).sections[0].lines;
    assert.ok(lines.every(line=>line.startsWith('•')),`${civ.id}: continuation became a separate bonus`);
  }
});

test('regional units called out as unique appear in the banner once',()=>{
  const cases=[['varangians','Unit:2703'],['muisca','Unit:2586'],['aztecs','Unit:753'],['mayans','Unit:753']];
  for(const [civ,entity] of cases){
    const nodes=uniqueUnitNodes(load(`civs/${civ}.json`));
    assert.equal(nodes.filter(node=>node.entity===entity).length,1,`${civ}: ${entity}`);
  }
  assert.equal(uniqueUnitNodes(chinese).some(node=>node.entity==='Unit:753'),false);
});

test('Cuman Mercenaries does not add a second Kipchak portrait',()=>{
  const cumans=load('civs/cumans.json');
  assert.deepEqual(uniqueUnitNodes(cumans,entities).map(node=>node.entity),['Unit:1231']);
  assert.ok(cumans.nodes.some(node=>node.entity==='Unit:1260' && node.parent==='Tech_690_82'));
});

test('cross-building Chemistry unlocks survive upgrades without applying to every gunpowder unit',()=>{
  for(const civ of manifest.civilizations){
    const tree=load(`civs/${civ.id}.json`);
    for(const entity of ['Unit:5','Unit:36','Unit:420','Tech:64','Building:236','Unit:691']){
      const node=tree.nodes.find(n=>n.entity===entity);
      if(node) assert.ok(techTreeRelations(tree,node.key).prerequisites.some(n=>n.entity==='Tech:47'),`${civ.id}: ${entity}`);
    }
  }
  const bohemians=load('civs/bohemians.json');
  const hand=bohemians.nodes.find(n=>n.entity==='Unit:5');
  assert.equal(hand.age,3);
  assert.equal(techTreeRelations(bohemians,hand.key).prerequisites.find(n=>n.entity==='Tech:47').age,3);
  const turks=load('civs/turks.json'),janissary=turks.nodes.find(n=>n.entity==='Unit:46');
  assert.equal(techTreeRelations(turks,janissary.key).prerequisites.length,0);
});

test('Mounted Crossbowman upgrades to Heavy Mounted Crossbowman in every relevant tree',()=>{
  let linked=0;
  for(const civ of manifest.civilizations){
    const tree=load(`civs/${civ.id}.json`);
    const base=tree.nodes.find(node=>node.entity==='Unit:2700');
    const heavy=tree.nodes.find(node=>node.entity==='Unit:2701');
    if(!heavy)continue;
    assert.ok(base,`${civ.id}: missing base unit`);
    assert.equal(techTreeRelations(tree,heavy.key).parent?.key,base.key,`${civ.id}: missing upgrade link`);
    linked++;
  }
  assert.equal(linked,15);
});

test('fixed portraits cover every displayed unique unit and China stays player 4 yellow',()=>{
  assert.equal(portraitColors.chinese,4);
  for(const civ of manifest.civilizations){
    assert.ok([1,2,3,4,5,6,8].includes(portraitColors[civ.id]));
    for(const node of uniqueUnitNodes(load(`civs/${civ.id}.json`))){
      const path=portraitAssetUrl(node.icon,civ.id).split('?')[0];
      const png=readFileSync(new URL(`../public${path}`,import.meta.url));
      assert.equal(png.subarray(1,4).toString(),'PNG');
      assert.equal(png.readUInt32BE(16),256);
      assert.equal(png.readUInt32BE(20),256);
      assert.equal(png[25],6,'RGBA transparency is retained');
    }
  }
});

test('all civilization trees have valid entities, prerequisites, ages and local icons',()=>{
  assert.equal(manifest.civilizations.length,56);
  assert.equal(Object.keys(entities).length,486);
  for (const civ of manifest.civilizations) {
    const tree=load(`civs/${civ.id}.json`),keys=new Set(tree.nodes.map(node=>node.key)),groups=new Set(tree.groups.map(group=>group.id));
    assert.equal(keys.size,tree.nodes.length,`${civ.id}: duplicate node`);
    assert.ok(civ.description && civ.name);
    for (const node of tree.nodes) {
      assert.ok(entities[node.entity],`${civ.id}: ${node.entity}`);
      assert.ok(groups.has(node.group));
      assert.ok([1,2,3,4].includes(node.age),`${civ.id}: invalid age ${node.age}`);
      assert.ok(!node.parent || keys.has(node.parent));
      assert.ok(existsSync(new URL(`../public${node.icon}`,import.meta.url)),node.icon);
      if (node.unique && node.available && node.entity.startsWith('Unit:')) {
        const portrait=node.icon.replace('/Unit/','/portraits-png/');
        assert.ok(existsSync(new URL(`../public${portrait}`,import.meta.url)),portrait);
        const png=readFileSync(new URL(`../public${portrait}`,import.meta.url));
        assert.equal(png.subarray(1,4).toString(),'PNG');
        assert.equal(png.readUInt32BE(16),256);
        assert.equal(png.readUInt32BE(20),256);
        assert.equal(png[25],6,'PNG includes a true alpha channel');
        const fixed=portraitAssetUrl(node.icon,civ.id).split('?')[0];
        assert.ok(existsSync(new URL(`../public${fixed}`,import.meta.url)),fixed);
      }
      assert.equal(entities[node.entity].civilizations.includes(civ.id),node.available,`${civ.id}: inconsistent availability ${node.key}`);
    }
  }
});

test('Chinese archer chain is connected and unavailable Hand Cannoneer remains inspectable',()=>{
  assert.equal(entities['Unit:4'].stats.HP,30);
  assert.equal(entities['Unit:4'].stats.Cost.Gold,45);
  assert.equal(techTreeRelations(chinese,'Unit_24_87').parent.entity,'Unit:4');
  assert.ok(techTreeRelations(chinese,'Unit_24_87').children.some(node=>node.entity==='Unit:492'));
  const handcannon=chinese.nodes.find(node=>node.entity==='Unit:5');
  assert.equal(handcannon.available,false);
  assert.ok(filterTechTree(chinese,entities,{query:entities['Unit:5'].name}).nodes.includes(handcannon));
  assert.equal(filterTechTree(chinese,entities,{query:entities['Unit:5'].name,unavailable:false}).nodes.length,0);
});

test('category, age and bilingual search combine without changing civilization availability',()=>{
  const result=filterTechTree(chinese,entities,{category:'military',age:2,query:'archer',unavailable:false});
  assert.ok(result.nodes.some(node=>node.entity==='Unit:4'));
  assert.ok(result.nodes.every(node=>node.age===2 && node.available));
  assert.equal(filterTechTree(chinese,entities,{query:'完全不存在的单位'}).nodes.length,0);
  const gold=filterTechTree(chinese,entities,{category:'economy'});
  assert.ok(gold.nodes.some(node=>node.entity==='Building:562'));
});

test('imported display text contains no HTML or unresolved game substitutions',()=>{
  for (const item of [...Object.values(entities),...manifest.civilizations]) {
    assert.doesNotMatch(item.description,/<[^>]+>|‹[^›]*›/);
    assert.match(item.name,/[\u3400-\u9fff]/,`${item.englishName}: missing Chinese name`);
  }
  for (const [kind,count] of Object.entries(manifest.counts)) assert.equal(Object.values(entities).filter(entity=>entity.type===kind).length,count);
  assert.ok(readdirSync(new URL('../public/tech-tree-data/civs',import.meta.url)).length>=manifest.civilizations.length);
});

test('every attack and armour class has a concrete name, including current naval classes',()=>{
  for (const entity of Object.values(entities)) for (const field of ['Attacks','Armours']) for (const value of entity.stats[field] || []) {
    assert.ok(armorClassNames[value.Class],`${entity.name}: missing class ${value.Class}`);
    assert.doesNotMatch(armorClassNames[value.Class],/类别\s*\d|未使用的护甲\s*\d/);
  }
  assert.equal(armorClassNames[39],'龙脉');
  assert.equal(armorClassNames[41],'喷火船');
  assert.equal(armorClassNames[60],'远程战船');
  assert.deepEqual(orderedCosts({Gold:30,Stone:40,Food:20,Wood:10}),[['Wood',10],['Food',20],['Gold',30],['Stone',40]]);
});

test('archer and skirmisher upgrades stay in their original separate columns; naval rows do not overlap',()=>{
  const layout=layoutTechTree(chinese,filterTechTree(chinese,entities));
  const archer=layout.groups.find(group=>group.id==='building-87');
  const byId=new Map(archer.nodes.map(node=>[node.key,node]));
  assert.equal(byId.get('Unit_4_87').column,byId.get('Unit_24_87').column);
  assert.equal(byId.get('Unit_7_87').column,byId.get('Unit_6_87').column);
  assert.notEqual(byId.get('Unit_4_87').column,byId.get('Unit_6_87').column);
  const dock=layout.groups.find(group=>group.id==='building-45');
  assert.equal(dock.columns,7);
  assert.equal(new Set(dock.nodes.map(node=>`${node.row}:${node.column}`)).size,dock.nodes.length);
  assert.equal(dock.nodes.find(node=>node.key==='Unit_691_45').column,dock.nodes.find(node=>node.key==='Unit_420_45').column);
  assert.ok(!dock.nodes.some(node=>node.entity===dock.building),'building belongs in header');
});

test('Chinese header shows unique unit icons once per line, without elite duplicates or regional units',()=>{
  assert.deepEqual(uniqueUnitNodes(chinese).map(node=>node.entity),['Unit:73','Unit:1302']);
});

test('Konnik variants from Castle and Krepost show one portrait despite distinct game IDs',()=>{
  const bulgarians=load('civs/bulgarians.json');
  const variants=bulgarians.nodes.filter(node=>node.entity==='Unit:1225' || node.entity==='Unit:1254');
  assert.equal(variants.length,2);
  assert.equal(variants[0].icon,variants[1].icon);
  const unique=uniqueUnitNodes(bulgarians);
  assert.equal(unique.length,1);
  assert.equal(entities[unique[0].entity].englishName,'Konnik');
});

test('random player colours include orange and exclude grey; the shader only tints the player mask',()=>{
  assert.deepEqual(allowedPlayerColors,[1,2,3,4,5,6,8]);
  assert.deepEqual(Array.from({length:7},(_,i)=>randomPlayerColor(()=>(i+.5)/7)),allowedPlayerColors);
  const input=new Uint8ClampedArray(256*256*4);
  input.set([60,90,120,255,60,90,120,0]);
  const red=colorPortrait(input,2);
  assert.deepEqual(Array.from(red.slice(0,4)),[60,90,120,255]);
  assert.deepEqual(Array.from(red.slice(4,8)),[60,0,0,255]);
  assert.deepEqual(Array.from(input.slice(4,8)),[60,90,120,0],'source is not mutated');
  assert.throws(()=>colorPortrait(input,9));
});

test('statistics civilization links resolve to an actual technology tree',()=>{
  assert.equal(civilizationTechTreeUrl('Chinese'),'/tech-tree?civ=chinese');
  assert.equal(civilizationTechTreeUrl('bulgarians'),'/tech-tree?civ=bulgarians');
});

test('portrait rendering uses PNG transparency without guessing from dark foreground colours',()=>{
  const input=new Uint8ClampedArray(256*256*4),cutout=new Uint8ClampedArray(input.length);
  input.set([28,28,28,255,8,9,10,255]);cutout.set([0,0,0,0,8,9,10,255]);
  const result=colorPortrait(input,2,cutout);
  assert.equal(result[3],0);
  assert.deepEqual(Array.from(result.slice(4,8)),[8,9,10,255]);
});

test('special economy buildings are explicitly classified as economy',()=>{
  const cases={poles:1734,portuguese:1021,hindustanis:1754,khitans:1889,incas:2556};
  for(const [civ,id] of Object.entries(cases)){
    const tree=load(`civs/${civ}.json`),node=tree.nodes.find(node=>node.entity===`Building:${id}`);
    assert.ok(node,`${civ}: missing building ${id}`);
    assert.equal(tree.groups.find(group=>group.id===node.group).category,'economy');
  }
});

test('requested civilization wording and Varangian upgrade lines are preserved',()=>{
  const required={
    armenians:'骡车科技提供的效率 +40%',aztecs:'军事单位（僧侣除外）训练时间 -13%',
    bengalis:'最小/最大招降时间 +3/+1',britons:'靶场生产和研究时间 -9.09%',
    burgundians:'圣物每分钟生产 30 食物',jurchens:'重型火箭推车科技木材费用 -75%',
    gurjaras:'15*ln(驻扎动物总食物量/200+1)',spanish:'炮舰弹道速度增加到 7',
    varangians:'维京长船和大型投石战舰攻击间隔 -13%',wu:'军事建筑、城堡和码头建造完成后获得 55 食物',
  };
  for(const [id,text] of Object.entries(required)){
    const description=overrides[`Civilization:${id}`]||manifest.civilizations.find(civ=>civ.id===id).description;
    assert.ok(description.includes(text),`${id}: missing ${text}`);
  }
  assert.equal(entities['Unit:75'].name,'剑士');
  assert.ok(overrides['Tech:513'].includes('溅射范围 +0.5，具有 5 溅射伤害'));
  assert.equal(Object.values(entities).some(entity=>`${entity.name}\n${entity.description}`.includes('蝎式弩')),false);
  const varangians=load('civs/varangians.json');
  assert.equal(varangians.nodes.find(node=>node.entity==='Unit:2704').parent,'Unit_2703_12');
  assert.equal(varangians.nodes.find(node=>node.entity==='Unit:533').parent,'Unit_250_45');
});

test('October balance update keeps regular and elite unit changes distinct',()=>{
  const champi=entities['Unit:2550'];
  assert.equal(champi.stats.Attacks.find(attack=>attack.Class===8).Amount,2);
  assert.equal(champi.stats.Attacks.find(attack=>attack.Class===30).Amount,2);

  assert.deepEqual(entities['Unit:873'].stats.Cost,{Food:70,Gold:80});
  assert.equal(entities['Unit:873'].stats.HP,220);
  assert.deepEqual(entities['Unit:875'].stats.Cost,{Food:70,Gold:80});
  assert.equal(entities['Unit:875'].stats.HP,270);

  assert.equal(entities['Unit:2569'].stats.Speed,1.45);
  assert.equal(entities['Unit:2571'].stats.Speed,1.5);
});
