const effectiveTypes = new Set(['Transform','DeQueue','Build','Move','Gatherpoint','Interact','Order','Stance','DeAttackMove','Patrol','Research','Delete','Wall','Sell','Formation','AttackGround','BackToWork','Buy']);

export function collectEffectiveActionTimes(full, players) {
  const times = new Map(players.map(p=>[String(p.player_number),[]]));
  const recent = new Map();
  for (const chapter of full?.chapters || []) for (const op of chapter.operations || []) {
    const action=op.Action;
    if (!action?.action_data) continue;
    const time=Number(action.world_time);
    if (!Number.isFinite(time) || time < 0) continue;
    for (const [type,value] of Object.entries(action.action_data)) {
      if (!effectiveTypes.has(type) || !value || !times.has(String(value.player_id))) continue;
      const key=`${value.player_id}|${type}|${JSON.stringify(value)}`;
      const previous=recent.get(key);
      if (previous != null && time >= previous && time-previous <= 300) {
        // Match the existing summary's villager auto-queue handling.
        if(type==='DeQueue' && Number(value.unit_id)===83)recent.set(key,time);
        continue;
      }
      recent.set(key,time);
      times.get(String(value.player_id)).push(time);
    }
  }
  for (const actions of times.values()) actions.sort((a,b)=>a-b);
  return times;
}

function upperBound(times, value) {
  let low=0,high=times.length;
  while(low<high) { const middle=(low+high)>>>1; if(times[middle]<=value)low=middle+1;else high=middle; }
  return low;
}

export function rollingEapm(times, time) {
  if (time <= 0) return 0;
  const count=upperBound(times,time)-upperBound(times,Math.max(-1,time-60000));
  return count;
}

export function globalEapmAt(times, time) {
  return time > 0 ? upperBound(times,time)*60000/Math.max(time,1000) : 0;
}

export function replayEapmStats(times, duration) {
  let left=0,peak=0;
  for(let right=0;right<times.length;right++) {
    while(left<=right && times[left]<=times[right]-60000)left++;
    peak=Math.max(peak,right-left+1);
  }
  const elapsed=Math.max(Number(duration)||times.at(-1)||0,1000);
  return {peak,global:times.length*60000/elapsed};
}

export function createReplayEapm(target, full, players, duration, colors) {
  const actions=collectEffectiveActionTimes(full,players);
  const end=Math.max(Number(duration)||0,...[...actions.values()].map(a=>a.at(-1)||0),1000);
  const step=5000;
  const samples=players.map(player=>{
    const times=actions.get(String(player.player_number)) || [];
    const points=[];
    for(let time=0;time<end;time+=step)points.push([time,rollingEapm(times,time)]);
    points.push([end,rollingEapm(times,end)]);
    return {player,times,points,stats:replayEapmStats(times,Number(duration)||end)};
  });
  const maximum=Math.max(100,...samples.map(s=>s.stats.peak));
  const ceiling=Math.ceil(maximum/50)*50;
  target.innerHTML='<h4>eAPM 变化</h4><p class="replay-eapm-note">每 5 秒采样，统计过去 60 秒有效操作。开局前 60 秒为累计操作数；曲线显示已播放区间。</p><svg viewBox="0 0 300 240" role="img" aria-label="玩家 eAPM 随时间变化曲线"></svg><div class="replay-eapm-values"></div>';
  const svg=target.querySelector('svg'), values=target.querySelector('.replay-eapm-values');
  const ns='http://www.w3.org/2000/svg';
  const node=(name,attrs={})=>{const n=document.createElementNS(ns,name);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,String(v));svg.append(n);return n;};
  const x=time=>36+time/end*250,y=value=>202-value/ceiling*184;
  for(let i=0;i<=4;i++) {
    const value=ceiling*i/4;
    node('line',{x1:36,x2:286,y1:y(value),y2:y(value),class:'replay-eapm-grid'});
    node('text',{x:30,y:y(value)+3,'text-anchor':'end'}).textContent=String(Math.round(value));
  }
  for(const time of [0,end/2,end]) {
    node('text',{x:x(time),y:224,'text-anchor':time===0?'start':time===end?'end':'middle'}).textContent=`${Math.floor(time/60000)}:${String(Math.floor(time/1000)%60).padStart(2,'0')}`;
  }
  const paths=samples.map(sample=>{
    const colorId=Number(sample.player.color_id);
    const color=`var(--replay-chat-color-${colorId}, ${colors(colorId)})`;
    const path=node('path',{fill:'none',stroke:color,'stroke-width':1.8,'vector-effect':'non-scaling-stroke'});
    const row=document.createElement('div'),name=document.createElement('strong');
    row.className='replay-eapm-player';row.style.color=color;name.textContent=sample.player.displayName || sample.player.name;name.title=name.textContent;
    const stats=document.createElement('div');stats.className='replay-eapm-stats';
    let value,globalValue;
    for(const [key,label,number,title] of [
      ['current','当前 eAPM',0,'当前时间之前 60 秒内的有效操作数'],
      ['peak','最高 eAPM',sample.stats.peak,'整场录像中，任意连续 60 秒的最高有效操作数'],
      ['global','全局 eAPM',0,'截至播放时刻的有效操作总数 ÷ 已播放游戏时长（分钟）']
    ]) {
      const cell=document.createElement('div'),caption=document.createElement('small'),numberNode=document.createElement('span');
      cell.title=title;cell.dataset.stat=key;caption.textContent=label;numberNode.textContent=number.toFixed(1);cell.append(caption,numberNode);stats.append(cell);
      if(key==='current')value=numberNode;
      if(key==='global')globalValue=numberNode;
    }
    row.append(name,stats);values.append(row);
    return {sample,path,value,globalValue};
  });
  const cursor=node('line',{x1:36,x2:36,y1:14,y2:205,class:'replay-eapm-cursor'});
  let previous=-1;
  return time=>{
    const second=Math.floor(time/1000);if(second===previous)return;previous=second;
    const now=Math.min(end,Math.max(0,time));
    cursor.setAttribute('x1',x(now));cursor.setAttribute('x2',x(now));
    for(const {sample,path,value,globalValue}of paths) {
      const points=sample.points.filter(p=>p[0]<=now);
      const current=rollingEapm(sample.times,now);
      points.push([now,current]);
      path.setAttribute('d',points.map(([time,eapm],i)=>`${i?'L':'M'}${x(time).toFixed(2)},${y(eapm).toFixed(2)}`).join(' '));
      value.textContent=current.toFixed(1);
      globalValue.textContent=globalEapmAt(sample.times,now).toFixed(1);
    }
    target.dataset.time=String(now);
  };
}
