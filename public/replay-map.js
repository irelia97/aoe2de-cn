import { createProductionPulses } from './replay-production-pulses.js?v=2';
import { replayTerrainColors, replayFishObjectIds } from './replay-terrain-colors.js?v=3';
import { collectMapEvents, createMapEventFeed } from './replay-map-events.js?v=4';
import { resolveBuildingLifecycle } from './replay-building-lifecycle.js?v=1';
import { createReplayEapm } from './replay-eapm.js?v=7';
import { createMapPlayerLegend } from './replay-player-ages.js?v=3';
export const replayBuildingIcons = {
  "109": {
    "name": "城镇中心",
    "icon": "/assets/replay-building-icons/town-center-de.png"
  },
  "79": {
    "name": "瞭望箭塔",
    "icon": "/assets/replay-building-icons/watch-tower-de.png"
  },
  "234": {
    "name": "警戒箭塔",
    "icon": "/assets/replay-building-icons/guard-tower-de.png"
  },
  "235": {
    "name": "大型箭塔",
    "icon": "/assets/replay-building-icons/keep-de.png"
  },
  "236": {
    "name": "炮塔",
    "icon": "/assets/replay-building-icons/bombard-tower-de.png"
  },
  "1251": {
    "name": "营垒",
    "icon": "/assets/replay-building-icons/krepost-de.png"
  },
  "1806": {
    "name": "强化教堂",
    "icon": "/assets/replay-building-icons/fortified-church-de.png"
  },
  "1665": {
    "name": "塔楼",
    "icon": "/assets/replay-building-icons/donjon-de.png"
  },
  "82": {
    "name": "城堡",
    "icon": "/assets/replay-building-icons/castle-de.png"
  },
  "45": {
    "name": "船坞",
    "icon": "/assets/replay-building-icons/dock-de.png"
  },
  "12": {
    "name": "兵营",
    "icon": "/assets/replay-building-icons/barracks-de.png"
  },
  "101": {
    "name": "马厩",
    "icon": "/assets/replay-building-icons/stable-de.png"
  },
  "87": {
    "name": "靶场",
    "icon": "/assets/replay-building-icons/archery-range-de.png"
  },
  "49": {
    "name": "攻城武器厂",
    "icon": "/assets/replay-building-icons/siege-workshop-de.png"
  },
  "104": {
    "name": "修道院",
    "icon": "/assets/replay-building-icons/monastery-de.png"
  },
  "71": {
    "name": "城镇中心",
    "icon": "/assets/replay-building-icons/town-center-de.png"
  },
  "621": {
    "name": "城镇中心",
    "icon": "/assets/replay-building-icons/town-center-de.png"
  }
};


export function extractReplayMap(full) {
  const header = full?.chapters?.[0]?.zheader;
  const map = header?.map_info;
  if (!map || !map.size_x || !Array.isArray(map.tiles)) return null;
  const data = { width: map.size_x, height: map.size_y, tiles: map.tiles.map(t => [t.terrain_type, t.elevation]), events: [] };
  let time = 0;
  for (const chapter of full.chapters || []) for (const op of chapter.operations || []) {
    if (op.Sync) time += Number(op.Sync.time_increment) || 0;
    const action = op.Action;
    if (!action) continue;
    for (const kind of ['Build', 'Wall']) {
      const command = action.action_data?.[kind];
      if (!command?.data) continue;
      const bytes = Uint8Array.from(command.data);
      const view = new DataView(bytes.buffer);
      if (bytes.length < 16) continue;
      const event = kind === 'Build'
        ? { x: view.getFloat32(4, true), y: view.getFloat32(8, true), unit: view.getUint32(12, true) }
        : { x: view.getUint16(4, true), y: view.getUint16(6, true), endX: view.getUint16(8, true), endY: view.getUint16(10, true), unit: view.getUint32(12, true) };
      if (event.x < 0 || event.y < 0 || event.x >= data.width || event.y >= data.height) continue;
      if (kind === 'Wall' && (event.endX >= data.width || event.endY >= data.height)) continue;
      data.events.push({ ...event, kind, player: command.player_id, time: Number(action.world_time) || time });
    }
  }
  data.events.sort((a, b) => a.time - b.time);
  return data;
}

export function layoutBuildingIcons(markers, width, height) {
  const placed = [], seen = new Set();
  const size = 16, step = 17;
  for (const { marker, point: [anchorX, anchorY] } of markers) {
    const key = `${marker.player}:${marker.unit}:${Math.round(marker.x * 4)}:${Math.round(marker.y * 4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const offsets = [[0,0]];
    for (const ring of [1,2]) for (const [x,y] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) offsets.push([x*step*ring,y*step*ring]);
    const candidate = offsets.map(([dx,dy]) => ({x:anchorX+dx,y:anchorY+dy})).find(p =>
      p.x >= size/2 && p.x <= width-size/2 && p.y >= size/2 && p.y <= height-size/2 &&
      placed.every(other => Math.abs(p.x-other.x) >= (size+other.size)/2+1 || Math.abs(p.y-other.y) >= (size+other.size)/2+1));
    placed.push({ marker, anchorX, anchorY, x:candidate?.x ?? anchorX, y:candidate?.y ?? anchorY, size:candidate ? size : 12 });
  }
  return placed;
}

let dispose = () => {};
export function renderReplayMap(root, full, players, duration, colors, eventLabels = {}) {
  dispose();
  const data = full?.mapData || extractReplayMap(full);
  root.replaceChildren();
  if (!data?.tiles?.length) {
    root.textContent = '此录像未提供可读取的地图地形。';
    return;
  }
  root.innerHTML = '<canvas width="760" height="430" aria-label="录像地图"></canvas><div class="replay-map-controls"><button type="button" data-play>播放</button><input type="range" min="0" step="1" value="0" aria-label="地图播放时间"><output>00:00</output><select aria-label="播放速度"><option value="8">8 倍速</option><option value="16" selected>16 倍速</option><option value="32">32 倍速</option><option value="64">64 倍速</option></select></div><div class="replay-map-layers"><label><input type="checkbox" data-initial checked>开局建筑与资源</label><label><input type="checkbox" data-build checked>显示建造建筑</label></div><div class="replay-map-legend"></div><p class="replay-map-note">标记表示建造指令；已关联对象 ID 的建筑自毁后会移除。未定位的自毁指令仅记录，不移除其它建筑。此图不模拟单位移动、战斗摧毁或战争迷雾。开局物体始终显示初始位置，不随时间移动。</p>';
  const stage = document.createElement('div'); stage.className='replay-map-stage';
  stage.append(...root.childNodes);
  const sidebar = document.createElement('aside'); sidebar.className='replay-map-feed';
  const eapm = document.createElement('aside'); eapm.className='replay-eapm';
  const layout = document.createElement('div'); layout.className='replay-map-layout'; layout.append(eapm,stage,sidebar); root.append(layout);
  const lifecycle = resolveBuildingLifecycle(full,data);
  const feedEvents = collectMapEvents(full,data,{ ...eventLabels, buildings:replayBuildingIcons, selfDeletes:lifecycle.events });
  const updateFeed = createMapEventFeed(sidebar,feedEvents,players,colors);
  const canvas = root.querySelector('canvas'), ctx = canvas.getContext('2d');
  const range = root.querySelector('input[type=range]'), output = root.querySelector('output'), play = root.querySelector('[data-play]');
  const build = root.querySelector('[data-build]'), initial = root.querySelector('[data-initial]');
  if (!data.initialObjects?.length) root.querySelector('.replay-map-note').append(' 此录像的初始物体未能读取；本地文件目前仅支持地形和指令。');
  const limit = [...data.events,...feedEvents].reduce((max, item) => Math.max(max, item.time), Math.max(Number(duration) || 0, 1000));
  const updateEapm = createReplayEapm(eapm,full,players,Number(duration)||limit,colors,eventLabels.gameSpeed);
  range.max = String(limit);
  const palette = new Map(players.map(p => [Number(p.player_number), colors(p.color_id)]));
  const legend = root.querySelector('.replay-map-legend');
  const viewport=document.createElement('div');viewport.className='replay-map-viewport';
  const queueNote=document.createElement('p');queueNote.className='replay-map-queue-note';
  queueNote.textContent='左上角图标代表队列中的单位和下达研究指令的科技，不代表实际拥有的单位或已完成的科技';
  canvas.before(viewport);viewport.append(canvas,legend,queueNote);
  const production=document.createElement('div');production.className='replay-map-production';viewport.append(production);
  const updateProduction=createProductionPulses(production,full,players,colors,eventLabels.units,eventLabels.techs);
  const legendRows=Math.ceil(players.length/(players.length>4?2:1));
  if(players.length>4)legend.classList.add('is-multicolumn');
  canvas.height=430+Math.max(0,legendRows-2)*24;
  const updatePlayerLegend=createMapPlayerLegend(legend,full,players,colors,eventLabels.settings);
  const terrain = document.createElement('canvas'); terrain.width = data.width; terrain.height = data.height;
  const tctx = terrain.getContext('2d');
  for (let i = 0; i < data.tiles.length; i++) {
    const [type] = data.tiles[i];
    tctx.fillStyle = replayTerrainColors[type] || replayTerrainColors[0];
    tctx.fillRect(i % data.width, Math.floor(i / data.width), 1, 1);

  }
  const scale = Math.min(720 / (data.width + data.height), 390 / ((data.width + data.height) / 2));
  let hits = [];
  const images = new Map();
  for (const source of new Set(Object.values(replayBuildingIcons).map(item => item.icon))) {
    const image = new Image();
    image.onload = () => { if (root.isConnected) draw(); };
    image.src = source; images.set(source, image);
  }
  const selection = document.createElement('p'); selection.className = 'replay-map-selection'; selection.textContent = '悬停或点击建筑图标查看名称'; stage.append(selection);
  function point(x, y) { return [canvas.width / 2 - data.height * scale + (x + y) * scale, 18 + data.width * scale / 2 + (y - x) * scale / 2]; }
  function inspect(event) {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
    const hit = hits.map(h => ({...h, distance: Math.hypot(h.x - x, h.y - y)})).filter(h => h.distance <= h.size / 2 + 2).sort((a,b) => a.distance - b.distance)[0];
    const text = hit ? hit.label : '悬停或点击建筑图标查看名称';
    canvas.title = hit ? text : ''; canvas.style.cursor = hit ? 'help' : ''; selection.textContent = text;
  }
  canvas.onmousemove = inspect; canvas.onclick = inspect;
  function draw() {
    const time = Number(range.value);
    updateFeed(time);
    updateEapm(time);
    updatePlayerLegend(time);
    updateProduction(time);
    const icons = [];
    hits = [];
    ctx.resetTransform(); ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Rotate world coordinates 90 degrees counterclockwise before projection.
    ctx.setTransform(scale, -scale / 2, scale, scale / 2, canvas.width / 2 - data.height * scale, 18 + data.width * scale / 2);
    ctx.imageSmoothingEnabled = false; ctx.drawImage(terrain, 0, 0);
    if (initial.checked) for (const o of data.initialObjects || []) {
      if ((lifecycle.initialDeletedAt.get(o.instance) ?? Infinity) <= time) continue;
      if (o.x < 0 || o.y < 0 || o.x >= data.width || o.y >= data.height) continue;
      if (Number(o.player) === 0) {
        const fish = replayFishObjectIds.has(Number(o.id));
        if (!fish && ![66,102].includes(Number(o.id))) continue;
        ctx.fillStyle = fish ? '#ffffff' : Number(o.id) === 66 ? '#ffd438' : '#e1e5ec';
        if (fish) { ctx.beginPath(); ctx.arc(o.x,o.y,.45,0,Math.PI*2); ctx.fill(); }
        else {
          ctx.fillRect(o.x-.8,o.y-.8,1.6,1.6);
          ctx.strokeStyle = '#252923'; ctx.lineWidth = .25; ctx.strokeRect(o.x-.8,o.y-.8,1.6,1.6);
        }
        continue;
      }
      // Only starting buildings are shown; omit villagers, scouts and other units.
      if (o.classId !== 80) continue;
      // Town-center wings, foundations and graphics are not separate buildings.
      if ([618,619,620,890,1649].includes(o.id) || [20,30].includes(o.classId)) continue;
      ctx.fillStyle = palette.get(Number(o.player)) || '#fff';
      if (o.classId === 80 && Number(o.player) > 0) {
        if (replayBuildingIcons[o.id]) icons.push({...o, unit: o.id, initial: true});
        const size = o.id === 109 ? 4 : 2.5;
        ctx.fillRect(o.x - size / 2, o.y - size / 2, size, size);
        ctx.strokeStyle = '#151515'; ctx.lineWidth = .45;
        ctx.strokeRect(o.x - size / 2, o.y - size / 2, size, size);
        if (o.id === 109) { ctx.strokeStyle = '#fff4ce'; ctx.lineWidth = .3; ctx.strokeRect(o.x - 1.4, o.y - 1.4, 2.8, 2.8); }
      } else if ([10,70,80].includes(o.classId)) {
        const size = Number(o.player) > 0 ? .9 : .65;
        ctx.fillRect(o.x - size / 2, o.y - size / 2, size, size);
      }
    }
    if (build.checked) for (const [eventIndex,e] of data.events.entries()) {
      if (e.time > time) break;
      if ((lifecycle.eventDeletedAt.get(eventIndex) ?? Infinity) <= time) continue;
      ctx.strokeStyle = ctx.fillStyle = palette.get(Number(e.player)) || '#fff';
      ctx.lineWidth = .8;
      if (e.kind === 'Wall') { ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.endX + .5, e.endY + .5); ctx.stroke(); }
      else { if (replayBuildingIcons[e.unit]) icons.push(e); ctx.fillRect(e.x - 1, e.y - 1, 2, 2); ctx.strokeStyle = '#111'; ctx.lineWidth = .25; ctx.strokeRect(e.x - 1, e.y - 1, 2, 2); }
    }
    ctx.resetTransform();
    const placed = layoutBuildingIcons(icons.map(marker => ({ marker, point: point(marker.x, marker.y) })), canvas.width, canvas.height);
    // Draw connectors before buttons so leaders never cross over icon faces.
    for (const item of placed) if (item.x !== item.anchorX || item.y !== item.anchorY) {
      ctx.strokeStyle = palette.get(Number(item.marker.player)) || '#fff'; ctx.lineWidth = .7;
      ctx.beginPath(); ctx.moveTo(item.anchorX, item.anchorY); ctx.lineTo(item.x, item.y); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(item.anchorX - 1, item.anchorY - 1, 2, 2);
    }
    for (const item of placed) {
      const { marker, x, y, size } = item;
      const info = replayBuildingIcons[marker.unit];
      const image = images.get(info.icon);
      ctx.fillStyle = '#171b17'; ctx.fillRect(x-size/2, y-size/2, size, size);
      if (image?.complete && image.naturalWidth) {
        ctx.imageSmoothingEnabled = true; ctx.drawImage(image, x-size/2+1, y-size/2+1, size-2, size-2);
      }
      const ownerColor = palette.get(Number(marker.player)) || '#fff';
      // A dark outer edge keeps the game color visible against every terrain.
      ctx.strokeStyle = '#080b0d'; ctx.lineWidth = 4;
      ctx.strokeRect(x-size/2, y-size/2, size, size);
      ctx.strokeStyle = ownerColor; ctx.lineWidth = 2;
      ctx.strokeRect(x-size/2, y-size/2, size, size);
      const ownerPlayer = players.find(p => Number(p.player_number) === Number(marker.player));
      const owner = ownerPlayer?.displayName || ownerPlayer?.name || `玩家 ${marker.player}`;
      const seconds = Math.floor((marker.time || 0) / 1000);
      const when = marker.initial ? '开局建筑' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')} 建造指令`;
      hits.push({x, y, size, label: `${info.name} · ${owner} · ${when} · (${marker.x.toFixed(1)}, ${marker.y.toFixed(1)})`});
    }
    canvas.dataset.buildingIcons = String(hits.length);
    const seconds = Math.floor(time / 1000);
    output.textContent = `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
  }
  let frame = 0, running = false, previous = 0;
  function stop() { running = false; cancelAnimationFrame(frame); play.textContent = '播放'; }
  function tick(now) {
    if (!running) return;
    if (!root.isConnected || root.closest('[hidden]')) return stop();
    range.value = String(Math.min(limit, Number(range.value) + (now - previous) * Number(root.querySelector('select').value)));
    previous = now; draw();
    if (Number(range.value) >= limit) stop(); else frame = requestAnimationFrame(tick);
  }
  play.onclick = () => {
    if (running) return stop();
    if (Number(range.value) >= limit) range.value = '0';
    running = true; previous = performance.now(); play.textContent = '暂停'; frame = requestAnimationFrame(tick);
  };
  range.oninput = draw; build.onchange = draw; initial.onchange = draw;
  let legendWidth=0,legendHeight=0;
  const resizeObserver=new ResizeObserver(()=>{
    const width=viewport.getBoundingClientRect().width;
    const heightOfLegend=legend.offsetHeight;
    if(!width || (Math.abs(width-legendWidth)<.5 && heightOfLegend===legendHeight))return;
    legendWidth=width;legendHeight=heightOfLegend;
    // Reserve enough black space under the map even on narrow screens.
    const height=Math.max(430+Math.max(0,legendRows-2)*24,Math.ceil(380+(heightOfLegend+38)*760/width));
    if(canvas.height!==height){canvas.height=height;draw();}
  });
  resizeObserver.observe(viewport);
  resizeObserver.observe(legend);
  dispose = () => {stop();resizeObserver.disconnect();};
  draw();
}
