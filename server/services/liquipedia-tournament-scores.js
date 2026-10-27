const clean = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/&(?:#95|lowbar);/gi,'_').replace(/[^\p{L}\p{N}]+/gu,'');

function matchTemplates(source) {
  const text=String(source || ''),templates=[];
  for (const found of text.matchAll(/\{\{Match\b/gi)) {
    let depth=0,end=found.index;
    for (let index=found.index;index<text.length-1;index++) {
      const pair=text.slice(index,index+2);
      if (pair==='{{') {depth++;index++;continue;}
      if (pair==='}}') {depth--;index++;if(depth===0){end=index+1;break;}}
    }
    if (end>found.index) templates.push(text.slice(found.index,end));
  }
  return templates;
}
function templateScore(template) {
  const direct1=template.match(/\|\s*score1\s*=\s*(\d+)/i)?.[1];
  const direct2=template.match(/\|\s*score2\s*=\s*(\d+)/i)?.[1];
  if (direct1 != null && direct2 != null) return [Number(direct1),Number(direct2)];
  const opponent1=template.match(/\|\s*opponent1\s*=\s*([^\n\r]+)/i)?.[1] || '';
  const opponent2=template.match(/\|\s*opponent2\s*=\s*([^\n\r]+)/i)?.[1] || '';
  const nested1=opponent1.match(/\|\s*score\s*=\s*(\d+)/i)?.[1];
  const nested2=opponent2.match(/\|\s*score\s*=\s*(\d+)/i)?.[1];
  if (nested1 != null && nested2 != null) return [Number(nested1),Number(nested2)];
  let first=0,second=0;
  for (const match of template.matchAll(/\|\s*winner\s*=\s*([12])\b/gi)) match[1]==='1' ? first++ : second++;
  return first+second ? [first,second] : null;
}

export function tournamentFinalScore(wikitext,winner,runnerUp) {
  const winnerKey=clean(winner),runnerKey=clean(runnerUp);
  if (!winnerKey || !runnerKey || /^(?:tbd|待定)$/.test(winnerKey+runnerKey)) return '';
  const candidates=[];
  for (const [index,template] of matchTemplates(wikitext).entries()) {
    const opponent1=template.match(/\|\s*opponent1\s*=\s*([^\n\r]+)/i)?.[1] || '';
    const opponent2=template.match(/\|\s*opponent2\s*=\s*([^\n\r]+)/i)?.[1] || '';
    const first=clean(opponent1),second=clean(opponent2);
    const orientation=first.includes(winnerKey)&&second.includes(runnerKey) ? 1 : first.includes(runnerKey)&&second.includes(winnerKey) ? -1 : 0;
    if (!orientation) continue;
    const score=templateScore(template);
    if (!score) continue;
    const ordered=orientation===1?score:[score[1],score[0]];
    if (ordered[0] <= ordered[1]) continue;
    candidates.push({score:ordered,total:ordered[0]+ordered[1],index});
  }
  candidates.sort((left,right)=>right.total-left.total || right.index-left.index);
  return candidates.length ? `${candidates[0].score[0]}–${candidates[0].score[1]}` : '';
}

