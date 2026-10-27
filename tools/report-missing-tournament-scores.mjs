import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root=resolve(import.meta.dirname,'..');
const cache=JSON.parse(readFileSync(resolve(root,'.cache/liquipedia-tournament-results.json'),'utf8'));
const labels={s:'S 级',a:'A 级',b:'B 级',c:'C 级',show:'表演赛',qualifier:'资格赛'};
const output=['# 缺少最终比分的赛事','','生成时间：2026-10-27（北京时间）',''];
let total=0;
let scored=0;
for(const [category,data] of Object.entries(cache.categories)){
  scored+=data.rows.filter(row=>row.score).length;
  const rows=data.rows.filter(row=>row.winner&&row.runnerUp&&row.winner!=='TBD'&&row.runnerUp!=='TBD'&&!row.score);
  total+=rows.length;
  output.push(`## ${labels[category]}（${rows.length} 场）`,'');
  if(!rows.length) output.push('无。','');
  else for(const row of rows) output.push(`- ${row.year} · [${row.name}](${row.url})：${row.winner} vs ${row.runnerUp}`);
  output.push('');
}
output.splice(4,0,`共 ${total} 场。当前页面已有 ${scored} 场最终比分。`,'');
mkdirSync(resolve(root,'reports'),{recursive:true});
writeFileSync(resolve(root,'reports/tournament-missing-scores.md'),output.join('\n'),'utf8');
console.log(`Wrote ${total} missing-score rows.`);
