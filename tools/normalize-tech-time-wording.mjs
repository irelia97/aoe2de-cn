import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const paths=['entities.json','manifest.json','description-overrides.json'].map(name=>resolve(root,'public/tech-tree-data',name));
const timeReduction=speed=>{
  const exact=Number(speed)/(100+Number(speed))*100;
  const common=new Map([[25,20],[33,25],[50,33],[100,50]]);
  return String(common.get(Number(speed))??Number(exact.toFixed(2)));
};
const normalize=value=>value
  .replace(/(训练和研究|生产和研究|训练|研究)速度\s*\+\s*(\d+(?:\.\d+)?)%/g,(_,scope,speed)=>`${scope}时间 -${timeReduction(speed)}%`)
  .replace(/(生产和研究|生产|研究)效率\s*\+\s*(\d+(?:\.\d+)?)%/g,(_,scope,speed)=>`${scope}时间 -${timeReduction(speed)}%`)
  .replace(/(铁匠铺|大学)工作速度\s*\+\s*(\d+(?:\.\d+)?)%/g,(_,building,speed)=>`${building}研究时间 -${timeReduction(speed)}%`)
  .replace(/攻击速度\s*\+\s*(\d+(?:\.\d+)?)%/g,(_,speed)=>`攻击间隔 -${timeReduction(speed)}%`);
let replacements=0;
for(const file of paths){
  const before=readFileSync(file,'utf8');
  const after=normalize(before);
  replacements+=(before.match(/(?:(训练和研究|生产和研究|训练|研究)速度|(生产和研究|生产|研究)效率|(铁匠铺|大学)工作速度|攻击速度)\s*\+\s*\d+(?:\.\d+)?%/g)||[]).length;
  writeFileSync(file,after);
}
console.log(`Normalized ${replacements} training/research speed phrases.`);
