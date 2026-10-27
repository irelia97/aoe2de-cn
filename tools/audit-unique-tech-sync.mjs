import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=name=>JSON.parse(readFileSync(resolve(root,'public/tech-tree-data',name),'utf8'));
const manifest=read('manifest.json');
const entities=read('entities.json');
const overrides=read('description-overrides.json');
const normalize=value=>String(value).normalize('NFKC').replace(/[，；。:：、,.\s（）()]/g,'').replace(/攻击速度\+(\d+)%/g,'攻击间隔-$1%').replace(/训练速度\+(\d+)%/g,'训练时间-$1%');
const aliases={'加固堡垒':'强化堡垒','山寨':'山城堡','Malon':'突袭','草药医学':'草药学','环球探险':'环游世界','文德尔之遗':'文德尔传承'};
const lineEffect=line=>{
  const start=line.indexOf('('),end=line.lastIndexOf(')');
  return start>=0&&end>start?line.slice(start+1,end):'';
};
const details=[];
for(const civ of manifest.civilizations){
  const description=overrides[`Civilization:${civ.id}`]||civ.description;
  const lines=description.split('\n');
  const start=lines.indexOf('独特科技：');
  const end=lines.indexOf('团队加成：',start+1);
  const summaryLines=lines.slice(start+1,end).filter(line=>line.startsWith('• '));
  const tree=read(`civs/${civ.id}.json`);
  const keys=[...new Set(tree.nodes.filter(node=>node.unique&&node.entity.startsWith('Tech:')).map(node=>node.entity))];
  const unmatched=new Set(keys);
  for(const summary of summaryLines){
    const summaryName=summary.slice(2).split(' (')[0].trim();
    let key=keys.find(candidate=>unmatched.has(candidate)&&normalize(entities[candidate]?.name)===normalize(aliases[summaryName]||summaryName));
    if(!key) key=[...unmatched][0];
    if(!key){details.push({civ:civ.name,type:'mapping',summary});continue;}
    unmatched.delete(key);
    const detail=(overrides[key]||entities[key]?.description||'').split('\n').slice(1).join('\n').trim();
    const summaryEffect=lineEffect(summary);
    if(normalize(detail)!==normalize(summaryEffect)) details.push({civ:civ.name,type:'effect',key,name:summaryName,summary:summaryEffect,detail});
  }
  for(const key of unmatched) details.push({civ:civ.name,type:'missing-summary',key,name:entities[key]?.name});
  if(summaryLines.length!==keys.length) details.push({civ:civ.name,type:'count',summaryCount:summaryLines.length,treeCount:keys.length});
}
console.log(JSON.stringify({civilizations:manifest.civilizations.length,issues:details.length,details},null,2));
