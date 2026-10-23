import { replayObjectNames } from './replay-object-names.js?v=1';
const buildingNames = { 50:'农田',68:'磨坊',70:'住房',72:'木墙',84:'市场',103:'铁匠铺',117:'石墙',155:'垛墙',199:'渔网',209:'大学',276:'世界奇观',487:'城门',562:'伐木场',584:'采矿营地',598:'哨站',792:'木城门' };

export function collectMapEvents(full, map, { units = {}, techs = {}, buildings = {}, chat = [], selfDeletes = [] } = {}) {
  const events = [];
  for (const event of map?.events || []) {
    const name = buildings[event.unit]?.name || buildingNames[event.unit] || replayObjectNames[event.unit] || `建筑 ${event.unit}`;
    events.push({ time:event.time, player:event.player, kind:'建造', text:`建造${name}`, position:[event.x,event.y] });
  }
  const researchTimes = new Map();
  for (const chapter of full?.chapters || []) for (const op of chapter.operations || []) {
    const action = op.Action;
    if (!action?.action_data) continue;
    const time = Number(action.world_time) || 0;
    const queue = action.action_data.DeQueue;
    if (queue && Number(queue.amount) > 0) {
      const name = units[queue.unit_id]?.name || replayObjectNames[queue.unit_id] || `单位 ${queue.unit_id}`;
      events.push({ time, player:queue.player_id, kind:'生产', text:`排队生产${name} × ${Number(queue.amount)}` });
    }
    const research = action.action_data.Research;
    if (research) {
      const key = JSON.stringify([research.player_id,research.technology_type,[...(research.building_ids || [research.building_id])].sort((a,b)=>a-b)]);
      const previous = researchTimes.get(key);
      researchTimes.set(key,time);
      if (previous != null && time >= previous && time-previous <= 1000) continue;
      const name = techs[research.technology_type]?.name || `科技 ${research.technology_type}`;
      events.push({ time, player:research.player_id, kind:'研究', text:`开始研究${name}` });
    }
  }
  for (const message of chat) events.push({ time:Number(message.time) || 0, player:message.playerId, kind:'聊天', text:String(message.text || '') });
  for (const item of selfDeletes) {
    const name=buildings[item.unit]?.name || buildingNames[item.unit] || replayObjectNames[item.unit] || `建筑 ${item.unit}`;
    events.push({time:item.time,player:item.player,kind:'自毁',text:item.matched ? `自毁${name}（对象 #${item.objectId}）` : `自毁对象 #${item.objectId}（未关联地图建筑）`});
  }
  return events.filter(e => Number.isFinite(e.time) && e.time >= 0).sort((a,b)=>a.time-b.time);
}

export function mapEventEndAt(events, time) {
  let low = 0, high = events.length;
  while (low < high) {
    const middle = (low+high) >>> 1;
    if (events[middle].time <= time) low=middle+1; else high=middle;
  }
  return low;
}

export function createMapEventFeed(target, events, players, colors) {
  target.innerHTML = '<div class="replay-map-feed-heading"><h4>玩家事件</h4><span></span></div><p class="replay-map-feed-note">截至播放时间的最近 80 条记录。生产、研究和建造均为下达指令。</p><div class="replay-map-feed-list" aria-label="当前时间前的玩家事件"></div>';
  const list = target.querySelector('.replay-map-feed-list'), count = target.querySelector('.replay-map-feed-heading span');
  const byNumber = new Map(players.map(p=>[String(p.player_number),p]));
  let renderedEnd = -1;
  return time => {
    const end = mapEventEndAt(events,time);
    if (end === renderedEnd) return;
    const previousEnd = renderedEnd;
    renderedEnd = end;
    count.textContent = `${end} 条`;
    const incremental = previousEnd > 0 && end > previousEnd && end-previousEnd < 80;
    if (!incremental) list.replaceChildren();
    if (!end) { const empty=document.createElement('p'); empty.className='replay-map-feed-empty'; empty.textContent='当前时间暂无事件'; list.append(empty); return; }
    const fragment = document.createDocumentFragment();
    for (let i=end-1;i>=Math.max(incremental ? previousEnd : 0,end-80);i--) {
      const event=events[i], player=byNumber.get(String(event.player));
      const card=document.createElement('article'); card.className='replay-map-event'; card.dataset.time=String(event.time); card.dataset.kind=event.kind;
      const colorId=Number(player?.color_id);
      card.style.setProperty('--event-player-color',player ? `var(--replay-chat-color-${colorId}, ${colors(colorId)})` : 'var(--text)');
      const heading=document.createElement('div'); heading.className='replay-map-event-heading';
      const clock=document.createElement('time'), seconds=Math.floor(event.time/1000);
      clock.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
      const who=document.createElement('strong'); who.textContent=player?.displayName || player?.name || '系统';who.title=who.textContent;
      const kind=document.createElement('span'); kind.textContent=event.kind;
      heading.append(clock,who,kind);
      const text=document.createElement('p'); text.textContent=event.text;
      if (event.kind === '聊天') text.className='replay-map-event-chat';
      card.append(heading,text); fragment.append(card);
    }
    list.prepend(fragment);
    while (list.childElementCount > 80) list.lastElementChild.remove();
    list.scrollTop=0;
  };
}
