import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const path=name=>resolve(root,'public/tech-tree-data',name);
const read=name=>JSON.parse(readFileSync(path(name),'utf8'));
const manifest=read('manifest.json');
const entities=read('entities.json');
const overrides=read('description-overrides.json');
const normalize=value=>String(value).normalize('NFKC').replace(/[\s“”"'()（）]/g,'').toLowerCase();
const aliases={
  '山寨':'山城堡','Malon (突袭)':'突袭','草药医学':'草药学','环球探险':'环游世界','文德尔之遗':'文德尔传承',
};
const labelOf=line=>line.slice(2,line.indexOf(' (')>0?line.indexOf(' ('):undefined).trim();
let synchronized=0;

for(const civ of manifest.civilizations){
  let lines=(overrides[`Civilization:${civ.id}`]||civ.description).split('\n');
  if(civ.id==='jurchens'){
    const headings=lines.map((line,index)=>line==='独特单位：'?index:-1).filter(index=>index>=0);
    if(headings.length>1) lines[headings[1]]='独特科技：';
  }
  const start=lines.indexOf('独特科技：');
  const end=lines.indexOf('团队加成：',start+1);
  if(start<0||end<0) throw new Error(`Missing unique technology section: ${civ.id}`);
  const positions=lines.map((line,index)=>index>start&&index<end&&line.startsWith('• ')?index:-1).filter(index=>index>=0);
  const tree=read(`civs/${civ.id}.json`);
  const keys=[...new Set(tree.nodes.filter(node=>node.unique&&node.entity.startsWith('Tech:')).map(node=>node.entity))];
  if(positions.length!==keys.length) throw new Error(`Unique technology count mismatch: ${civ.id} (${positions.length}/${keys.length})`);
  const remaining=new Set(keys),assigned=new Map();
  for(const position of positions){
    const label=labelOf(lines[position]);
    const target=aliases[label]||label;
    const key=keys.find(candidate=>remaining.has(candidate)&&normalize(entities[candidate]?.name)===normalize(target));
    if(key){assigned.set(position,key);remaining.delete(key);}
  }
  for(const position of positions.filter(position=>!assigned.has(position))){
    const key=[...remaining][0];
    assigned.set(position,key);remaining.delete(key);
  }
  for(const position of positions){
    const key=assigned.get(position),label=labelOf(lines[position]);
    const detail=(overrides[key]||entities[key]?.description||'').split('\n').slice(1).join('\n').trim().replace(/[。]$/,'');
    if(!detail) throw new Error(`Missing technology detail: ${key}`);
    const next=`• ${label} (${detail})`;
    if(lines[position]!==next){lines[position]=next;synchronized++;}
  }
  civ.description=lines.join('\n');
  overrides[`Civilization:${civ.id}`]=civ.description;
}

writeFileSync(path('manifest.json'),JSON.stringify(manifest));
writeFileSync(path('description-overrides.json'),JSON.stringify(overrides,null,2)+'\n');
console.log(`Synchronized ${synchronized} unique-technology summaries across ${manifest.civilizations.length} civilizations.`);
