import { replayBuildingObjectIds, replayObjectNames } from './replay-object-names.js?v=2';

export const productionPulseDuration = 120000;
export function collectProductionPulses(full) {
  const events=[], recent=new Map();
  for(const chapter of full?.chapters || []) for(const op of chapter.operations || []) {
    const action=op.Action, time=Number(action?.world_time);
    if(!Number.isFinite(time) || time<0)continue;
    const queue=action?.action_data?.DeQueue, research=action?.action_data?.Research;
    if(research){
      const key=`research:${research.player_id}:${research.technology_type}:${JSON.stringify(research.building_ids || [research.building_id])}`;
      const previous=recent.get(key);recent.set(key,time);
      if(previous==null || time<previous || time-previous>1000)events.push({time,player:Number(research.player_id),unit:Number(research.technology_type),kind:'tech',amount:1});
    }
    if(!queue || !(Number(queue.amount)>0) || replayBuildingObjectIds.has(Number(queue.unit_id)))continue;
    const key=`unit:${JSON.stringify(queue)}`, previous=recent.get(key);
    recent.set(key,time);
    if(previous!=null && time>=previous && time-previous<=300)continue;
    events.push({time,player:Number(queue.player_id),unit:Number(queue.unit_id),kind:'unit',amount:Number(queue.amount)});
  }
  return events.sort((a,b)=>a.time-b.time);
}

export function visibleProductionPulses(events,time) {
  let low=0,high=events.length;
  while(low<high){const mid=(low+high)>>>1;if(events[mid].time<=time)low=mid+1;else high=mid;}
  const grouped=new Map();
  for(let i=low-1;i>=0 && events[i].time>time-productionPulseDuration;i--){
    const event=events[i],key=`${event.player}:${event.kind || 'unit'}:${event.unit}`,item=grouped.get(key);
    if(item)item.amount+=event.amount;
    else grouped.set(key,{...event,opacity:Math.min(1,(productionPulseDuration-time+event.time)/(productionPulseDuration*.8))});
  }
  return [...grouped.values()];
}

export function createProductionPulses(target,full,players,colors,units={},techs={}) {
  const events=collectProductionPulses(full),rows=new Map();
  target.title='单位生产与科技研究指令；图标按游戏时间逐渐淡出，不代表生产或研究完成';
  for(const player of players){
    const row=document.createElement('div');row.className='replay-production-row';
    row.style.setProperty('--production-player-color',colors(player.color_id));
    const name=document.createElement('span');name.className='replay-production-player';name.textContent=player.name;name.title=player.displayName || player.name;
    const icons=document.createElement('div');icons.className='replay-production-icons';row.append(name,icons);target.append(row);
    rows.set(Number(player.player_number),{row,icons,nodes:new Map()});row.hidden=true;
  }
  return time=>{
    const visible=visibleProductionPulses(events,time),active=new Set();
    for(const event of visible){
      const entry=rows.get(event.player);if(!entry)continue;
      const key=`${event.player}:${event.kind || 'unit'}:${event.unit}`;active.add(key);
      let node=entry.nodes.get(key);
      if(!node){
        node=document.createElement('span');node.className='replay-production-unit';node.dataset.unit=String(event.unit);node.dataset.kind=event.kind;
        const info=(event.kind==='tech'?techs:units)[event.unit],name=info?.name || (event.kind==='tech'?`科技 ${event.unit}`:replayObjectNames[event.unit] || `单位 ${event.unit}`);
        const fallback=document.createElement('span');fallback.className='replay-production-fallback';fallback.textContent=name.slice(0,2);node.append(fallback);
        if(info?.icon){const image=document.createElement('img');image.src=info.icon;image.alt=name;image.onerror=()=>image.remove();node.append(image);}
        const count=document.createElement('b');node.append(count);entry.nodes.set(key,node);entry.icons.append(node);
      }
      node.style.opacity=String(event.opacity);node.querySelector('b').textContent=event.kind==='tech'?'研':event.amount>1?`×${event.amount}`:'';
      node.title=event.kind==='tech' ? `${techs[event.unit]?.name || `科技 ${event.unit}`}：开始研究` : `${units[event.unit]?.name || replayObjectNames[event.unit] || event.unit}：最近 2 分钟排队 ${event.amount}`;
    }
    for(const [player,entry] of rows){
      for(const [key,node] of entry.nodes)if(!active.has(key)){node.remove();entry.nodes.delete(key);}
      entry.row.hidden=!entry.nodes.size;
    }
  };
}
