let realtimeChatTimer = null;
let realtimeChatBound = false;
let realtimeChatLastKey = '';
let realtimeChatRestorePromise = null;
function realtimeChatStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function realtimeChatSave(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
let realtimeScheduleCheckedAt = 0;
let realtimeScheduleMatches = [];
async function refreshRealtimeSchedulePreview() {
  const panel = document.querySelector('#realtimeSchedulePreview');
  if (!panel || !/^\/realtime\/?$/.test(location.pathname)) return;
  const { qualifiesForSchedule, scheduleTierLabel } = await import('/realtime-schedule.js?v=7');
  if (panel.dataset.collapseBound !== '1') {
    panel.dataset.collapseBound = '1';
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-schedule-toggle]');
      const content = panel.querySelector('.realtime-schedule-content');
      if (!button || !content) return;
      content.hidden = !content.hidden;
      button.setAttribute('aria-expanded', String(!content.hidden));
      const action = content.hidden ? '展开赛事' : '收起赛事';
      button.setAttribute('aria-label', action);
      button.title = action;
      button.textContent = content.hidden ? '⌄' : '⌃';
      realtimeChatSave('aoe2-realtime-schedule-collapsed', content.hidden ? '1' : '0');
    });
  }
  if (Date.now() - realtimeScheduleCheckedAt > 60000) {
    realtimeScheduleCheckedAt = Date.now();
    try {
      const response = await fetch('/api/events', { cache:'no-store' });
      if (response.ok) {
        const data = await response.json();
        const now = Date.now();
        const retained = realtimeScheduleMatches.filter(match => match.timestamp*1000 <= now && match.timestamp*1000 > now-15*60*1000);
        // Recently started fixtures can move out of upcoming before the
        // preview's fifteen-minute retention window has elapsed.
        realtimeScheduleMatches = [...new Map([...retained,...(data.completed || []),...(data.upcoming || [])].map(match => [String(match.id || `${match.tournament?.url || match.tournament?.name}:${match.timestamp}:${(match.opponents || []).map(p=>p.name).join('|')}`), match])).values()];
      }
    } catch {}
  }
  const now = Date.now();
  const matches = realtimeScheduleMatches;
  const ongoing = matches.filter(match => match.status === 'ongoing' && qualifiesForSchedule(match)).sort((a,b)=>a.timestamp-b.timestamp);
  const upcoming = matches.filter(match => match.status !== 'ongoing' && match.timestamp*1000 > now-15*60*1000 && match.timestamp*1000 < now+24*60*60*1000 && qualifiesForSchedule(match)).sort((a,b)=>a.timestamp-b.timestamp);
  const fixtureMarkup = (match, includeTime) => {
    const tournament = match.tournament;
    const name = tournament.round ? `${tournament.mainName || tournament.name} - ${tournament.round}` : tournament.name;
    const time = new Date(match.timestamp*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
    const bo = Number(match.bestOf);
    const key = String(match.id || `${match.tournament?.url || match.tournament?.name}:${match.timestamp}:${(match.opponents || []).map(p=>p.name).join('|')}`);
    const score = Array.isArray(match.score) && match.score.some(value => String(value ?? '').trim() !== '') ? `｜${match.score.map(value=>escapeHtml(String(value ?? ''))).join('–')}` : '';
    return `<div class="realtime-schedule-fixture" data-schedule-key="${escapeHtml(key)}">${includeTime ? `<time>${escapeHtml(time)}</time> ` : ''}${escapeHtml(scheduleTierLabel(match))}｜${escapeHtml(name)}｜${Number.isInteger(bo)&&bo>0?`BO${bo}｜`:''}${(match.opponents||[]).slice(0,2).map(p=>escapeHtml(p.name||'待定')).join(' vs ')}${score}</div>`;
  };
  const sectionMarkup = (title, matches, empty, includeTime) => `<div class="realtime-event-section"><h3 data-schedule-key="${escapeHtml(title)}">${escapeHtml(title)}</h3>${matches.length ? matches.map(match=>fixtureMarkup(match,includeTime)).join('') : `<div class="realtime-event-empty">${escapeHtml(empty)}</div>`}</div>`;
  panel.hidden = false;
  panel.setAttribute('aria-label', '赛事');
  const collapsed = realtimeChatStored('aoe2-realtime-schedule-collapsed') === '1';
  const action = collapsed ? '展开赛事' : '收起赛事';
  const markup = `<div class="realtime-schedule-heading"><h3>赛事</h3><button type="button" class="realtime-schedule-toggle" data-schedule-toggle aria-label="${action}" title="${action}" aria-controls="realtimeScheduleContent" aria-expanded="${!collapsed}">${collapsed ? '⌄' : '⌃'}</button></div><div class="realtime-schedule-content" id="realtimeScheduleContent"${collapsed ? ' hidden' : ''}>${sectionMarkup('正在进行中的比赛',ongoing,'暂无正在进行中的比赛',false)}${sectionMarkup('比赛预告',upcoming,'未来24小时暂无比赛预告',true)}</div>`;
  if (panel.realtimeScheduleMarkup !== markup) {
    const savedSelection = realtimeStatusSelection(panel);
    panel.innerHTML = markup;
    panel.realtimeScheduleMarkup = markup;
    restoreRealtimeStatusSelection(panel, savedSelection);
  }
}
function renderRealtimeChat(messages) {
  const box = document.querySelector('#realtimeChatMessages');
  if (!box) return;
  const items = (Array.isArray(messages) ? messages : []).filter(item => !(item.kind === 'system' && /^未来(?:12|24)小时(?:比赛预告|暂无)/.test(String(item.content || ''))));
  const key = JSON.stringify(items.map(item => [item.id, item.author, item.uid, item.content]));
  if (key === realtimeChatLastKey) return;
  const stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 45;
  realtimeChatLastKey = key;
  box.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'realtime-chat-empty';
    empty.textContent = '暂无发言，欢迎开始交流。';
    box.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `realtime-chat-item${item.kind === 'system' ? ' is-system' : ''}`;
    const time = document.createElement('time');
    time.dateTime = new Date(item.createdAt).toISOString();
    time.textContent = new Date(item.createdAt).toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
    const author = document.createElement('strong');
    author.textContent = item.kind === 'system' ? '系统' : `${item.author || '游客'}(#${item.uid || '?'})`;
    const content = document.createElement('span');
    const message = String(item.content || '');
    content.textContent = item.kind === 'system' && /赛事(?:开始|结束)[:：]/.test(message)
      ? message.replace(/([:：])(?=\S)/, '$1 ').replace(/\s*[|｜│]\s*/g, ' │ ')
      : message;
    row.append(time, author, content);
    if (item.kind === 'system' && item.url && !/已结束直播/.test(String(item.content || ''))) {
      try {
        const url = new URL(item.url);
        if (url.protocol === 'https:' && /(^|\.)(bilibili\.com|douyu\.com|douyin\.com|twitch\.tv|youtube\.com|kick\.com)$/.test(url.hostname)) {
          const link = document.createElement('a');
          link.href = url.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = '观看直播';
          row.append(link);
        }
      } catch {}
    }
    box.append(row);
  }
  if (stickToBottom) box.scrollTop = box.scrollHeight;
}
function updateRealtimeChatViewer(viewer) {
  if (!viewer) return;
  const name = document.querySelector('#realtimeChatName');
  const identity = document.querySelector('#realtimeChatIdentity');
  const save = document.querySelector('#realtimeChatSaveName');
  const canRename = !viewer.canRenameAt || Date.now() >= viewer.canRenameAt;
  name.readOnly = !canRename;
  if (!canRename || name.dataset.dirty !== '1') name.value = viewer.nickname;
  if (!canRename) delete name.dataset.dirty;
  identity.textContent = `${viewer.nickname}(#${viewer.uid})${canRename ? ' · 可修改昵称' : ` · 下次可修改：${new Date(viewer.canRenameAt).toLocaleString('zh-CN', { hour12: false })}`}`;
  save.hidden = !canRename;
}
async function restoreRealtimeChatNickname(viewer) {
  const stored = realtimeChatStored('aoe2-realtime-chat-name');
  const name = document.querySelector('#realtimeChatName');
  if (!viewer || viewer.canRenameAt || !stored || stored === viewer.nickname || name?.dataset.dirty === '1') return viewer;
  if (realtimeChatRestorePromise) return realtimeChatRestorePromise;
  realtimeChatRestorePromise = (async () => {
    try {
      const response = await fetch('/api/realtime/chat/nickname', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: stored }) });
      if (!response.ok) return viewer;
      const result = await response.json();
      return result.viewer || viewer;
    } catch { return viewer; }
  })().finally(() => { realtimeChatRestorePromise = null; });
  return realtimeChatRestorePromise;
}
async function loadRealtimeChat() {
  if (!/^\/realtime\/?$/.test(location.pathname) || document.querySelector('#realtimeChatBody')?.hidden) return;
  try {
    const response = await fetch('/api/realtime/chat', { cache: 'no-store' });
    if (!response.ok) throw new Error('聊天记录暂时无法读取');
    const data = await response.json();
    const viewer = await restoreRealtimeChatNickname(data.viewer);
    updateRealtimeChatViewer(viewer);
    if (viewer?.canRenameAt) realtimeChatSave('aoe2-realtime-chat-name', viewer.nickname);
    renderRealtimeChat(data.messages);
  } catch {
    if (!realtimeChatLastKey) document.querySelector('#realtimeChatMessages').textContent = '聊天记录暂时无法读取，稍后自动重试。';
  }
}
function startRealtimeChat() {
  if (!realtimeChatBound) {
    realtimeChatBound = true;
    const toggle = document.querySelector('#realtimeChatToggle');
    const body = document.querySelector('#realtimeChatBody');
    const form = document.querySelector('#realtimeChatForm');
    const name = document.querySelector('#realtimeChatName');
    const message = document.querySelector('#realtimeChatMessage');
    const status = document.querySelector('#realtimeChatStatus');
    const saveName = document.querySelector('#realtimeChatSaveName');
    name.value = realtimeChatStored('aoe2-realtime-chat-name') || `游客${Math.floor(1000 + Math.random() * 9000)}`;
    body.hidden = realtimeChatStored('aoe2-realtime-chat-collapsed') === '1';
    toggle.setAttribute('aria-expanded', String(!body.hidden));
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      toggle.setAttribute('aria-expanded', String(!body.hidden));
      realtimeChatSave('aoe2-realtime-chat-collapsed', body.hidden ? '1' : '0');
      if (!body.hidden) loadRealtimeChat();
    });
    name.addEventListener('input', () => { name.dataset.dirty = '1'; });
    saveName.addEventListener('click', async () => {
      saveName.disabled = true;
      status.textContent = '正在保存昵称……';
      try {
        const response = await fetch('/api/realtime/chat/nickname', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '保存失败');
        delete name.dataset.dirty;
        updateRealtimeChatViewer(result.viewer);
        realtimeChatSave('aoe2-realtime-chat-name', result.viewer.nickname);
        status.textContent = '昵称已保存';
        await loadRealtimeChat();
      } catch (error) { status.textContent = error.message || '保存失败，请稍后重试'; }
      finally { saveName.disabled = false; }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = document.querySelector('#realtimeChatSend');
      button.disabled = true;
      status.textContent = '正在发送……';
      try {
        const response = await fetch('/api/realtime/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.value, message: message.value }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '发送失败');
        delete name.dataset.dirty;
        updateRealtimeChatViewer(result.viewer);
        realtimeChatSave('aoe2-realtime-chat-name', result.viewer.nickname);
        message.value = '';
        status.textContent = '已发送';
        await loadRealtimeChat();
      } catch (error) { status.textContent = error.message || '发送失败，请稍后重试'; }
      finally { button.disabled = false; }
    });
  }
  clearInterval(realtimeChatTimer);
  loadRealtimeChat();
  realtimeChatTimer = setInterval(loadRealtimeChat, 5000);
}
function realtimeElapsed(started) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(started || 0));
  if (!seconds) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}
function updateRealtimeCardClocks() {
  document.querySelectorAll('#realtimePlayers time[data-started]').forEach(clock => {
    const label = realtimeElapsed(clock.dataset.started);
    if (clock.textContent !== label) clock.textContent = label;
  });
}
function realtimeServerName(value) {
  const text = String(value || '').trim().toLowerCase();
  const names = { chilecentral: '智利中部', ukwest: '英国西部', uksouth: '英国南部', koreacentral: '韩国中部', centralindia: '印度中部', southcentralus: '美国中南部', eastus: '美国东部', eastus2: '美国东部 2', westus: '美国西部', westus2: '美国西部 2', westus3: '美国西部 3', japaneast: '日本东部', southeastasia: '东南亚', australiaeast: '澳大利亚东部', australiasoutheast: '澳大利亚东南部', brazilsouth: '巴西南部', westeurope: '西欧', northeurope: '北欧' };
  return names[text] || (text ? text : '未知服务器');
}
function realtimeCivIconMarkup(value) {
  const slug = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(slug)) return '<span class="realtime-civ-icon">♙</span>';
  return '<img class="realtime-civ-icon" src="https://backend.cdn.aoe2companion.com/public/aoe2/de/civilizations/' + slug + '.png" alt="" loading="lazy" onerror="this.hidden=true">';
}
function realtimePlayerColor(value, index) {
  const palette = ["#3b6eff", "#e12d39", "#35c759", "#f0d90b", "#18c8d8", "#a855f7", "#8b8b8b", "#f28c28"];
  const color = Number(value);
  return palette[color > 0 ? color - 1 : index] || "#6d7884";
}
function realtimePlatformIconMarkup(platform) {
  const key = String(platform || '').trim().toLowerCase();
  if (key === 'douyin') return '<span class="realtime-platform-icon realtime-platform-icon-douyin" aria-hidden="true">♪</span>';
  const icons = { twitch: 'twitch.svg', youtube: 'youtube.svg', youtube_live: 'youtube.svg', bilibili: 'bilibili.svg', douyu: 'douyu.png', kick: 'kick.svg' };
  const file = icons[key];
  return file ? `<span class="realtime-platform-icon realtime-platform-icon-${escapeHtml(key)}" aria-hidden="true"><img src="/assets/icons/${file}" alt=""></span>` : '';
}
function realtimeStateIsActive(state) {
  return state?.status === 'game' && state.match;
}
function realtimeStatusActivity(state) {
  if (state?.status === 'lobby') {
    const label = `大厅房间 ${escapeHtml(realtimeLobbyDisplayName(state.lobby?.name))}`;
    const id = String(state.lobby?.id || '');
    const text = /^[1-9]\d*$/.test(id) ? `<a class="realtime-lobby-join" href="aoe2de://0/${id}" title="在游戏内加入大厅房间">${label}</a>` : `<span>${label}</span>`;
    return `<span class="realtime-status-activity is-lobby"><span aria-hidden="true">🏠</span>${text}</span>`;
  }
  if (state?.status === 'cancelled') {
    const players = state.cancellation?.players || [];
    const opponent = players.find(p => String(p.profileId) !== String(state.profileId));
    const label = players.length === 2 ? `逃跑 vs ${opponent?.name || '未知对手'}` : players.length > 2 ? '逃跑 TG' : '逃跑';
    return `<span class="realtime-status-activity is-cancelled"><span class="realtime-escape-icon" aria-hidden="true">🐕</span><span>${escapeHtml(label)}</span></span>`;
  }
  if (state?.queue && ['queueing', 'matched'].includes(state.status)) {
    const queue = state.queue;
    const players = queue.players || [];
    let label;
    const queueKey = escapeHtml(`${state.profileId}:${queue.id || ''}`);
    let icon = `<i class="realtime-queue-spinner" data-queue-key="${queueKey}" aria-hidden="true"></i>`;
    if (state.status === 'queueing') {
      const teammates = players.filter(p => String(p.profileId) !== String(state.profileId));
      const teammateNames = teammates.map(p => p.name || `玩家 ${p.profileId || '未知'}`).join(' + ');
      label = players.length <= 1 ? '队列中' : `TG 队列中(${teammateNames})`;
    } else {
      const own = players.find(p => String(p.profileId) === String(state.profileId));
      const opponents = players.filter(p => String(p.profileId) !== String(state.profileId) && (!own || p.team !== own.team));
      const leader = [...opponents].sort((a, b) => (b.rating1v1 ?? -1) - (a.rating1v1 ?? -1))[0];
      const slug = String(queue.mapImageUrl || '').split('/').pop()?.replace(/\.png(?:\?.*)?$/, '') || '';
      const map = queue.mapName ? mapDisplayName(queue.mapName) : slug ? mapDisplayName(slug) : '未知地图';
      const teamGame = players.length > 2;
      label = `${teamGame ? 'TG ' : ''}${map} vs ${leader?.name || '未知对手'}${teamGame ? '队' : ''}`;
      const matchedAt = Date.parse(queue.matchedAt || '');
      const elapsed = Number.isFinite(matchedAt) ? Math.max(0, (Date.now() - matchedAt) / 1000) % 5 : 0;
      icon = `<svg class="realtime-match-hourglass" style="--hourglass-delay:-${elapsed}s" viewBox="0 0 16 20" aria-label="匹配成功，等待开始" role="img"><path d="M2 1h12M2 19h12M3 1v4c0 2 2 3 5 5-3 2-5 3-5 5v4M13 1v4c0 2-2 3-5 5 3 2 5 3 5 5v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 4h8L8 9ZM5 18h6l-3-3Z" fill="currentColor"/></svg>`;
    }
    return `<span class="realtime-status-activity realtime-queue-activity is-${state.status}">${icon}<span>${escapeHtml(label)}</span></span>`;
  }
  if (!realtimeStateIsActive(state)) return '';
  const match = state.match;
  const map = mapDisplayName(match.map || '未知地图');
  const players = Array.isArray(match.players) ? match.players : [];
  const own = players.find(player => String(player.profileId) === String(state.profileId));
  const leaderboard = String(match.leaderboard || '').toUpperCase();
  const teamIds = new Set(players.map(player => String(player.team ?? '')).filter(Boolean));
  const oneVsOne = leaderboard.includes('1V1') || (players.length === 2 && teamIds.size === 2);
  const teamGame = leaderboard.includes('TG') || players.length > 2;
  let label = map;
  if (!leaderboard || leaderboard === 'UNRANKED') {
    label = `${map} 大厅局`;
  } else if (teamGame) {
    label = `${map} TG`;
  }
  if (oneVsOne) {
    const opponent = players.find(player => String(player.profileId) !== String(state.profileId) && (!own || String(player.team) !== String(own.team))) || players.find(player => String(player.profileId) !== String(state.profileId));
    if (opponent) label = `${label} vs ${opponent.name || `玩家 ${opponent.profileId || ''}`}`;
  }
  return `<span class="realtime-status-activity is-game"><a class="realtime-status-live-link" href="aoe2de://1/${encodeURIComponent(String(match.id || null))}" title="在游戏内观战"><span class="realtime-game-icon" aria-hidden="true">◉</span><span class="realtime-game-label">${escapeHtml(label)}</span></a></span>`;
}
function alignRealtimeStatusActivity() {
  document.querySelectorAll('.realtime-status-activity').forEach(activity => {
    const link = activity.querySelector('.realtime-status-live-link');
    const meta = activity.querySelector('.realtime-status-match-meta');
    if (!link || !meta) return;
    activity.classList.add('is-wrapped');
    activity.style.removeProperty('width');
  });
}
window.addEventListener('resize', alignRealtimeStatusActivity);
document.fonts?.ready.then(alignRealtimeStatusActivity);
function playerTeamMarkup(value, stripAffixes = false) {
  const name = String(value || '').trim();
  const teams = new Map([
    ['ankr',[null,'ANKR']],
    ['blacksails',[null,'BLACKSAILS']],
    ['darkside',[null,'DarkSidE']],
    ['gaberianss',[null,'Gaberianss']],
    ['kyo all fallen',[null,'Kyo_All_Fallen']],
    ['lingyuan',[null,'LingYuan']],
    ['rulers of rome',['RoR','Rulers_of_Rome']],
    ['salzz',[null,'SalzZ']],
    ['suomi',[null,'Suomi']],
    ['the amigos',[null,'The_Amigos']],
    ['uxmal esports',[null,'Uxmal_Esports']],
    ['wonders',[null,'Wonders']],
    ['team vitality',['Vitality','Team%20Vitality']],
    ['onimaru esports',['Oni','Onimaru%20Esports']],
    ['cn zhongsheng',['CNZS','CN%20ZhongSheng']],
    ['white wolf palace',['WWP','White%20Wolf%20Palace']],
    ['vietnam legends',['Vietnam','Vietnam%20Legends']],
    ['nocturna esports',['NOC','Nocturna%20eSports']],
    ['old school',['OS+','Old%20School']],
    ['taiwan aoe gamer',['TAG','Taiwan%20Aoe%20Gamer']]
  ]);
  const team = teams.get(name.toLowerCase().replace(/\s+/g,' '));
  const displayName = stripAffixes ? name.replace(/^(?:(?:team|esports|the)\b\s*)+|(?:\s*\b(?:team|esports|the))+$/gi, '').trim() : name;
  const teamPath = team?.[1] || (name ? `Special:Search?search=${encodeURIComponent(name)}` : '');
  const label = team?.[0] || displayName;
  return teamPath ? `<a class="player-team-link" href="https://liquipedia.net/ageofempires/${teamPath}" title="${escapeHtml(name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>` : escapeHtml(displayName);
}
function bindRealtimeStatusColumns() {
  const panel = document.querySelector('#realtimeStatusPanel');
  if (!panel || panel.dataset.columnsBound) return;
  panel.dataset.columnsBound = '1';
  const storageKey = 'aoe2de:realtime-hidden-columns';
  let hidden;
  try { hidden = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch {}
  const columns = new Set((Array.isArray(hidden) ? hidden : []).filter(key => ['team', 'live'].includes(key)));
  const table = panel.querySelector('.realtime-status-table');
  let measuredWidth = 0;
  function apply() {
    panel.classList.toggle('hide-team', columns.has('team'));
    panel.classList.toggle('hide-live', columns.has('live'));
    const weights = [8, 18, columns.has('team') ? 0 : 12, 30, columns.has('live') ? 0 : 32];
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const foldedWidth = columns.size * 48;
    panel.style.setProperty('--realtime-table-min-width', `${Math.round(1050 * total / 100 + foldedWidth)}px`);
    measuredWidth = Math.max(panel.clientWidth, parseFloat(getComputedStyle(table).minWidth) || 0);
    if (measuredWidth) panel.querySelectorAll('thead th').forEach((cell, index) => {
      cell.style.width = weights[index] ? `${(measuredWidth - foldedWidth) * weights[index] / total}px` : '48px';
    });
    panel.querySelectorAll('[data-toggle-realtime-column]').forEach(button => {
      const key = button.dataset.toggleRealtimeColumn;
      const folded = columns.has(key), name = { team:'战队', live:'直播' }[key];
      button.setAttribute('aria-expanded', String(!folded));
      button.setAttribute('aria-label', `${folded ? '展开' : '收起'}${name}列`);
      button.title = `${folded ? '展开' : '收起'}${name}列`;
    });
    alignRealtimeStatusActivity();
  }
  panel.addEventListener('click', event => {
    const button = event.target.closest('[data-toggle-realtime-column]');
    if (!button) return;
    const key = button.dataset.toggleRealtimeColumn;
    if (columns.has(key)) columns.delete(key); else columns.add(key);
    try { localStorage.setItem(storageKey, JSON.stringify([...columns])); } catch {}
    apply();
    button.focus({ preventScroll:true });
  });
  apply();
  new ResizeObserver(() => {
    const width = Math.max(panel.clientWidth, parseFloat(getComputedStyle(table).minWidth) || 0);
    if (panel.clientWidth && width !== measuredWidth) apply();
  }).observe(panel);
}
bindRealtimeStatusColumns();
function realtimeStatusSelection(target) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !target.contains(selection.anchorNode) || !target.contains(selection.focusNode)) return null;
  const endpoint = (node, offset) => {
    const cell = (node.nodeType === 1 ? node : node.parentElement).closest('td, [data-schedule-key]');
    if (!cell) return null;
    const range = document.createRange();
    range.selectNodeContents(cell);
    range.setEnd(node, offset);
    return { key: cell.dataset.scheduleKey ?? cell.parentElement.dataset.statusKey, column: cell.cellIndex, offset: range.toString().length };
  };
  const anchor = endpoint(selection.anchorNode, selection.anchorOffset);
  const focus = endpoint(selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus, text: selection.toString() } : null;
}
function restoreRealtimeStatusSelection(target, saved) {
  if (!saved) return;
  const endpoint = point => {
    const row = [...(target.rows || [])].find(row => row.dataset.statusKey === point.key);
    const cell = point.column === undefined
      ? [...target.querySelectorAll('[data-schedule-key]')].find(item => item.dataset.scheduleKey === point.key)
      : row?.cells[point.column];
    if (!cell) return null;
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    let remaining = point.offset;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (remaining <= node.length) return [node, remaining];
      remaining -= node.length;
    }
    return null;
  };
  const anchor = endpoint(saved.anchor), focus = endpoint(saved.focus);
  if (!anchor || !focus) return;
  const range = document.createRange();
  range.setStart(...anchor);
  range.setEnd(...focus);
  if (range.collapsed) { range.setStart(...focus); range.setEnd(...anchor); }
  if (range.toString() !== saved.text) return;
  window.getSelection()?.setBaseAndExtent(...anchor, ...focus);
}
function renderRealtimeStatus(states) {
  const target = document.querySelector('#realtimeStatusRows');
  if (!target) return;
  const savedSelection = realtimeStatusSelection(target);
  const spinnerPhases = new Map([...target.querySelectorAll('.realtime-queue-spinner')].map(icon => {
    const animation = icon.getAnimations()[0];
    return [icon.dataset.queueKey, { startTime:animation?.startTime, currentTime:animation?.currentTime }];
  }));
  const visible = (Array.isArray(states) ? states : []).filter(state => realtimeStateIsActive(state) || state?.status === 'lobby' || state?.status === 'cancelled' || state?.queue || state?.live?.url || Number(state?.graceUntil) > Date.now());
  const identityMap = new Map();
  const priority = state => [
    realtimeStateIsActive(state) || state?.queue || state?.status === 'lobby' || state?.status === 'cancelled' ? 3 : state?.live?.url ? 2 : 1,
    Number(state?.match?.started || 0),
    Number(state?.player?.rating || 0)
  ];
  for (const state of visible) {
    const key = String(state.identity || state.profileId || '');
    const current = identityMap.get(key);
    if (!current) {
      identityMap.set(key, state);
      continue;
    }
    const nextPriority = priority(state);
    const currentPriority = priority(current);
    if (nextPriority[0] > currentPriority[0]
      || (nextPriority[0] === currentPriority[0] && nextPriority[1] > currentPriority[1])
      || (nextPriority[0] === currentPriority[0] && nextPriority[1] === currentPriority[1] && nextPriority[2] > currentPriority[2])) {
      identityMap.set(key, state);
    }
  }
  const ratingForSort = state => {
    const rating = Number(state?.player?.rating);
    return Number.isFinite(rating) && rating > 0 ? rating : -1;
  };
  const list = [...identityMap.values()].sort((a, b) => ratingForSort(b) - ratingForSort(a));
  if (!list.length) { target.innerHTML = '<tr><td colspan="5">暂无选手</td></tr>'; return; }
  target.innerHTML = list.map(state => {
    const player = state.player || {};
    const activity = realtimeStatusActivity(state);
    const numericRating = Number(player.rating);
    const rating = player.rating !== null && player.rating !== undefined && Number.isFinite(numericRating) ? numericRating.toLocaleString('zh-CN') : '—';
    const name = escapeHtml(player.name || `玩家 ${state.profileId || ''}`);
    const team = playerTeamMarkup(player.team, true);
    const live = state.live?.url ? `<a class="realtime-status-stream-link" href="${escapeHtml(state.live.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(state.live.title || '正在直播')}">${realtimePlatformIconMarkup(state.live.platform)}${escapeHtml(state.live.title || '正在直播')}</a>` : '';
    return `<tr data-status-key="${escapeHtml(String(state.identity || state.profileId || ''))}"><td>${rating}</td><td><a class="realtime-status-player" title="${name}" href="/profile/${encodeURIComponent(String(state.identity || state.profileId || ''))}">${countryFlag(player.country)}<span>${name}</span></a></td><td>${team}</td><td class="${activity ? 'realtime-status-active' : ''}">${activity}</td><td>${live}</td></tr>`;
  }).join('');
  for (const icon of target.querySelectorAll('.realtime-queue-spinner')) {
    const previous = spinnerPhases.get(icon.dataset.queueKey);
    const animation = icon.getAnimations()[0];
    if (!previous || !animation) continue;
    if (previous.startTime != null) animation.startTime = previous.startTime;
    else if (previous.currentTime != null) animation.currentTime = previous.currentTime;
  }
  alignRealtimeStatusActivity();
  restoreRealtimeStatusSelection(target, savedSelection);
}
function renderRealtimeCards(payload) {
  const container=document.querySelector('#realtimePlayers');
  const statusPanel=document.querySelector('#realtimeStatusPanel');
  const loading=document.querySelector('#realtimeLoading');
  const updated=document.querySelector('#realtimeUpdated');
  if (!container) return;
  const states=Array.isArray(payload?.states)?payload.states:[];
  renderRealtimeStatus(states);
  if (loading) loading.hidden=true;
  if (statusPanel) statusPanel.hidden=false;
  container.hidden=false;
  const matchAverageRating = state => {
    const participants=state?.lobby?.players || state?.match?.players;
    const ratings=(Array.isArray(participants)?participants:[]).filter(player=>player.ratingMode==='rm_1v1').map(player=>Number(player.rating)).filter(rating=>Number.isFinite(rating)&&rating>0);
    return ratings.length?ratings.reduce((sum,rating)=>sum+rating,0)/ratings.length:-Infinity;
  };
  const games=[...new Map(states.filter(realtimeStateIsActive).map(state=>[String(state.match.id||state.profileId),state])).values()];
  const lobbies=[...new Map(states.filter(state=>state.status==='lobby' && state.lobby).map(state=>[String(state.lobby.id),state])).values()];
  const cards=[...games,...lobbies].sort((a,b)=>Number(Boolean(b.match?.tournament || b.match?.event || b.match?.eventName))-Number(Boolean(a.match?.tournament || a.match?.event || a.match?.eventName))||matchAverageRating(b)-matchAverageRating(a)||Number(b.match?.started||0)-Number(a.match?.started||0));
  if (updated) updated.textContent=payload?.checkedAt?`更新于 ${new Date(payload.checkedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:'等待更新';
  if (!games.length && !lobbies.length) {
    const emptyMarkup='<div class="realtime-empty"><div class="realtime-empty-icon">◌</div><h3>当前没有检测到进行中的对局</h3><p>检测池中的玩家均未返回正在进行的最新对局。</p></div>';
    if (container.realtimeCardsMarkup !== emptyMarkup) container.innerHTML=emptyMarkup;
    container.realtimeCardsMarkup=emptyMarkup;
    return;
  }
  const markup=cards.map(state=>{
    if (state.status==='lobby') {
      const lobby=state.lobby;
      const players=Array.isArray(lobby.players)?lobby.players:[];
      const rows=players.map((player,index)=>realtimePlayerRow(player,index)).join('');
      const title = `大厅房间 ${escapeHtml(realtimeLobbyDisplayName(lobby.name))}`;
      const heading = /^[1-9]\d*$/.test(String(lobby.id || '')) ? `<a class="realtime-lobby-join" href="aoe2de://0/${lobby.id}" title="在游戏内加入大厅房间">${title}</a>` : title;
      return `<article class="realtime-match-card"><div class="realtime-match-top"><span aria-hidden="true">🏠</span><strong>${heading}</strong></div><div class="realtime-match-players">${rows}</div><div class="realtime-match-tags"><span>🏠 大厅房间</span><span>◇ ${escapeHtml(mapDisplayName(lobby.map || '未知地图'))}</span><span>▣ ${escapeHtml(realtimeServerName(lobby.server || ''))}</span></div></article>`;
    }
    const match=state.match;
    const players=Array.isArray(match.players)?match.players:[];
    const groups=realtimeGroupedPlayers(match);
    const rows=groups?groups.map(([team,members])=>`<div class="realtime-team-group"><span class="realtime-team-label">队伍 ${escapeHtml(team)}</span>${members.map(({player,index})=>realtimePlayerRow(player,index)).join('')}</div>`).join(''):players.map((player,index)=>realtimePlayerRow(player,index)).join('');
    const leaderboardTag=`<span>⚔ ${escapeHtml(realtimeLeaderboardLabel(match.leaderboard))}</span>`;
    const activity='游戏中';
    const watch=`<a class="realtime-watch-link" href="aoe2de://1/${encodeURIComponent(String(match.id||null))}" title="在游戏内观战" aria-label="在游戏内观战">👁</a>`;
    const rawMapName = String(match.map || '').trim();
    const displayedMapName = mapDisplayName(rawMapName || '未知地图');
    const knownMap = Boolean(rawMapName) && (displayedMapName !== rawMapName || Object.values(mapNamesZh).includes(rawMapName));
    const mapImage = knownMap ? aoe2MapImageUrl(rawMapName) : '';
    const mapImageMarkup = mapImage ? `<img class="realtime-map-thumbnail" src="${escapeHtml(`${mapImage}?v=rgba`)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<article class="realtime-match-card"><div class="realtime-match-top"><span class="realtime-match-live-dot"></span><strong>${escapeHtml(displayedMapName)}</strong>${mapImageMarkup}<time data-started="${Number(match.started)||0}"></time>${watch}</div><div class="realtime-match-players${groups?' is-team-game':''}">${rows}</div><div class="realtime-match-tags"><span>● ${activity}</span>${leaderboardTag}<span>▣ ${escapeHtml(realtimeServerName(match.server||''))}</span></div></article>`;
  }).join('');
  if (container.realtimeCardsMarkup !== markup) container.innerHTML=markup;
  container.realtimeCardsMarkup=markup;
  updateRealtimeCardClocks();
}

function showRealtimeLoading() {
  const loading = document.querySelector('#realtimeLoading');
  const statusPanel = document.querySelector('#realtimeStatusPanel');
  const container = document.querySelector('#realtimePlayers');
  if (loading) loading.hidden = false;
  if (statusPanel) statusPanel.hidden = true;
  if (container) container.hidden = true;
}
function showRealtimeError() {
  const container = document.querySelector('#realtimePlayers');
  const loading = document.querySelector('#realtimeLoading');
  if (!container) return;
  if (loading) loading.hidden = true;
  container.hidden = false;
  container.innerHTML = '<div class="realtime-empty"><div class="realtime-empty-icon">!</div><h3>实时对局暂时无法更新</h3><p>稍后会自动重试。</p></div>';
  container.realtimeCardsMarkup = null;
}

function startRealtimePolling() {
  realtimePolling.start();
  startRealtimeChat();
}
