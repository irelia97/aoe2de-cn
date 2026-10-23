import { spawn } from 'node:child_process';

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:rm|dm|ew|cm)[_-]/, '')
    .replace(/[^a-z0-9]+/g, '');
}

const mapNamesZh = new Map(Object.entries({
  "Arabia": "阿拉伯半岛",
  "Archipelago": "群岛",
  "Baltic": "波罗的海",
  "Black Forest": "黑森林",
  "Coastal": "沿海",
  "Continental": "大陆",
  "Crater Lake": "火山湖",
  "Fortress": "堡垒",
  "Gold Rush": "淘金潮",
  "Highland": "高地",
  "Islands": "岛屿",
  "Mediterranean": "地中海",
  "Migration": "迁移",
  "Rivers": "河流",
  "Team Islands": "团队岛屿",
  "Full Random": "完全随机地图",
  "Scandinavia": "斯堪的纳维亚",
  "Socotra": "索科特拉岛",
  "Mongolia": "蒙古",
  "Salt Marsh": "盐碱沼泽",
  "Yucatan": "尤卡坦",
  "Arena": "竞技场",
  "King of the Hill": "占山为王",
  "Oasis": "绿洲",
  "Ghost Lake": "幽灵湖",
  "Random Land Map": "随机陆地地图",
  "Execute On Load": "加载时执行",
  "Nomad": "游牧",
  "Blind Random": "绝对随机地图",
  "Hidden": "隐藏",
  "Objectives": "任务",
  "Hints": "提示",
  "Scouts": "侦察",
  "Acropolis": "雅典卫城",
  "Budapest": "布达佩斯",
  "Cenotes": "岩坑池地",
  "City of Lakes": "百湖之城",
  "Golden Pit": "金矿谷",
  "Hideout": "藏身之处",
  "Hill Fort": "山寨",
  "Lombardia": "伦巴第",
  "Steppe": "干草原",
  "Valley": "峡谷",
  "MegaRandom": "超级随机",
  "Hamburger": "汉堡包",
  "CtR Random": "争夺圣物随机地图",
  "CtR Monsoon": "争夺圣物雨季沼泽",
  "CtR Pyramid Descent": "争夺圣物决战金字塔之巅",
  "CtR Spiral": "争夺圣物漩涡迷航",
  "Golden Swamp": "金沼泽",
  "Four Lakes": "四片湖泊",
  "Land Nomad": "陆地游牧",
  "BR Battle On Ice": "大逃杀冰上战斗",
  "BR El Dorado": "大逃杀黄金国",
  "BR Fall of Axum": "大逃杀阿克苏姆的衰落",
  "BR Fall of Rome": "大逃杀罗马的衰落",
  "BR Majapahit Empire": "大逃杀满者伯夷帝国",
  "Amazon Tunnel": "亚马逊隧道",
  "Coastal Forest": "沿海森林",
  "African Clearing": "非洲林中空地",
  "Atacama": "阿塔卡马",
  "Seize The Mountain": "攻占山头",
  "Crater": "弹坑",
  "Crossroads": "十字路口",
  "Michi": "开道",
  "Team Moats": "团队护城河",
  "Volcanic Island": "火山岛",
  "Acclivity": "上坡",
  "Eruption": "火山喷发",
  "Frigid Lake": "酷寒之湖",
  "Greenland": "格陵兰",
  "Lowland": "低地",
  "Marketplace": "市场",
  "Meadow": "草地",
  "Mountain Range": "山脉",
  "Northern Isles": "北方群岛",
  "Ring Fortress": "环形要塞",
  "Runestones": "符文石群",
  "Aftermath": "余波荡漾",
  "Enclosed": "与世隔绝",
  "Haboob": "哈布风暴",
  "Kawasan": "卡瓦森",
  "Land Madness": "癫狂之地",
  "Sacred Springs": "圣泉",
  "Wade": "浅滩",
  "Morass": "沼泽",
  "Shoals": "浅滩",
  "Cliffbound": "紧邻悬崖",
  "Isthmus": "地峡",
  "Dunesprings": "沙丘泉",
  "Golden Stream": "金色溪流",
  "Mountain Dunes": "山地沙丘",
  "River Divide": "河流分叉口",
  "Sandrift": "流沙",
  "Shrubland": "灌木丛",
  "The Passage": "走廊",
  "Hollow Woodlands": "山谷林地",
  "Karsts": "喀斯特地貌",
  "Glade": "林间空地",
  "Fortified Clearing": "强化空地",
  "QS Arabia": "QS 阿拉伯",
  "QS Fortified Clearing": "QS 强化空地",
  "QS Glade": "QS 林中空地",
  "QS Nomad": "QS 游牧",
  "Canals": "运河",
  "Capricious": "变幻莫测",
  "Dingos": "澳洲野犬",
  "Graveyards": "坟墓",
  "Metropolis": "大都市",
  "Moats": "护城河",
  "Paradise Island": "天堂岛",
  "Pilgrims": "朝圣者",
  "Prairie": "大草原",
  "Seasons": "四季",
  "Sherwood Forest": "雪伍德森林",
  "": "",
  "Shipwreck": "船只遗骸",
  "Team Glaciers": "团队冰川",
  "": "",
  "Stranded": "孤岛求生",
  "Pregame Cinematic": "游戏片头过场动画",
  "Victory Cinematic": "胜利过场动画",
  "Loss Cinematic": "失败过场动画",
  "Scenario Instruction Map": "场景指南地图",
  "QS Runestones": "QS 符文石群",
  "QS Arena": "QS 竞技场",
  "QS Black Forest": "QS 黑森林",
  "Great Wall": "长城",
  "Sardis": "萨迪斯",
  "Aquarena": "水上竞技场",
  "Forest Breach": "森林缺口",
  "Border Dispute": "边境纷争",
  "Graupel": "霰雪",
  "Chaos Pit": "混沌之坑",
  "Mired": "泥沼",
  "Murkwood": "黑雾林",
  "Crownwood": "克朗伍德",
  "Dorothea Quarry": "多罗西亚采石场",
  "Glacis": "格拉西斯",
  "Hengehold": "亨格霍尔德",
  "Loch Ness": "尼斯湖",
  "Rampart": "壁垒",
  "Stonefront": "石阵防线",
  "Thames": "泰晤士河",
  "Vulpine": "狐影林",
  "Arabian Desert": "阿拉伯沙漠",
}).filter(([name]) => name).map(([name, label]) => [normalizeKey(name), label]));

const serverNamesZh = new Map(Object.entries({
  australia: '澳大利亚',
  brazilsouth: '巴西南部',
  eastasia: '东亚',
  koreacentral: '韩国中部',
  southeastasia: '东南亚',
  southafricanorth: '南非北部',
  uksouth: '英国南部',
  ukwest: '英国西部',
  westeurope: '西欧',
  centralindia: '印度中部',
  westindia: '印度西部',
  westus: '美国西部',
  westus2: '美国西部2',
  eastus: '美国东部',
  eastus2: '美国东部2',
  centralus: '美国中部'
}));

function translated(value, names, fallback) {
  const raw = String(value || '').trim();
  return names.get(normalizeKey(raw)) || raw || fallback;
}

function splitMessage(message, limit) {
  const chunks = [];
  let current = '';
  for (const token of message.split(/\s+/).filter(Boolean)) {
    if (token.length > limit) {
      if (current) chunks.push(current);
      current = '';
      for (let offset = 0; offset < token.length; offset += limit) chunks.push(token.slice(offset, offset + limit));
      continue;
    }
    const candidate = current ? `${current} ${token}` : token;
    if (candidate.length <= limit) current = candidate;
    else { chunks.push(current); current = token; }
  }
  if (current) chunks.push(current);
  return chunks;
}

function matchId(match) {
  return String(match?.matchId ?? match?.id ?? '');
}

export function createRealtimeDanmakuNotifier(deps) {
  const {
    statePath,
    readFile,
    writeFile,
    renameFile = null,
    execFileAsync,
    pythonExecutable,
    scriptPath,
    playwrightBrowsersPath,
    watchers = [],
    spawnImpl = spawn,
    residentSender = null
  } = deps;
  const prepared = new Map();
  const preparationTasks = new Map();
  const notificationTasks = new Map();
  let browserQueue = Promise.resolve();
  async function acquireBrowser() {
    const previous = browserQueue;
    let release;
    browserQueue = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  let statePromise;
  let saving = Promise.resolve();

  async function prepareMatch(match, endedProfileId = null) {
    if ((!endedProfileId && match.finished) || match.abandoned || !match.players || match.players.length < 2) return;
    if (residentSender) { residentSender.start().catch(error => console.warn('[danmaku] resident preparation:',error.message)); return; }
    const state = await loadState();
    const ids = new Set(match.players.map(player => String(player.profileId ?? player.id)));
    for (const watcher of watchers.filter(item => ids.has(String(item.profileId)) && (!endedProfileId || String(item.profileId) === String(endedProfileId)))) {
      const suffix = endedProfileId ? `:ended:${endedProfileId}` : '';
      const key = `${watcher.platform}:${watcher.room}:${matchId(match)}${suffix}`;
      const stateKey = `${watcher.platform}:${watcher.room}:${watcher.profileId}${endedProfileId ? `:ended:${matchId(match)}` : ''}`;
      if (String(state[stateKey]?.lastMatchId || '') === matchId(match)) continue;
      if (prepared.has(key) || preparationTasks.has(key)) continue;
      const preparing = (async () => {
      const release = await acquireBrowser();
      try {
      const child = spawnImpl(pythonExecutable, [scriptPath, '--platform', watcher.platform, 'send', '--room', String(watcher.room), '--message-stdin', '--message-wait', endedProfileId ? '180' : '60'], {
        env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath }, stdio: ['pipe','pipe','pipe']
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.stdin.on('error', () => {});
      const entry = { child };
      const timer = setTimeout(() => child.kill(), endedProfileId ? 210000 : 90000);
      entry.result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve({stdout}) : reject(Object.assign(new Error(stderr || `Prepared browser exited ${code}`), {stdout})));
      }).finally(() => {
        release();
        clearTimeout(timer);
        if (prepared.get(key) === entry) prepared.delete(key);
      });
      entry.result.catch(() => {});
      prepared.set(key, entry);
      } catch (error) { release(); throw error; }
      })();
      preparationTasks.set(key, preparing);
      preparing.finally(() => { if (preparationTasks.get(key) === preparing) preparationTasks.delete(key); }).catch(() => {});
      await preparing;
    }
  }

  function cancelPreparedEnd(match, profileId) {
    if (residentSender) return;
    for (const watcher of watchers.filter(item => String(item.profileId) === String(profileId))) {
      const key = `${watcher.platform}:${watcher.room}:${matchId(match)}:ended:${profileId}`;
      const entry = prepared.get(key);
      if (entry) { prepared.delete(key); entry.child.kill(); }
    }
  }

  async function loadState() {
    if (!statePromise) {
      statePromise = readFile(statePath, 'utf8')
        .then(text => JSON.parse(text))
        .catch(() => ({}));
    }
    return statePromise;
  }

  async function saveState(state) {
    const task = saving.then(async () => {
      const path = renameFile ? `${statePath}.tmp` : statePath;
      await writeFile(path, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
      if (renameFile) await renameFile(path, statePath);
    });
    saving = task.catch(() => {});
    await task;
  }

  function formatPlayer(player) {
    const name = String(player?.name || '未知玩家').trim();
    const numericRating = Number(player?.rating);
    return `${name}(${Number.isFinite(numericRating) && numericRating > 0 ? numericRating : '-'})`;
  }

  function formatMessage(match, profileId) {
    const players = [...(Array.isArray(match?.players) ? match.players : [])]
      .sort((left, right) => Number(String(left?.profileId ?? left?.id) !== profileId) - Number(String(right?.profileId ?? right?.id) !== profileId));
    const map = translated(match?.mapName || match?.map || match?.rms, mapNamesZh, '未知地图');
    const server = translated(match?.server, serverNamesZh, '未知服务器');
    return `${formatPlayer(players[0])} vs ${formatPlayer(players[1])}，${map}，${server}`;
  }

  async function processMatch(match, completion = null, targetWatcher = null) {
    const id = matchId(match);
    if (!id) return;
    if ((!completion && match?.finished) || match?.abandoned || !Array.isArray(match?.players) || match.players.length < 2) return;
    const profileIds = new Set(match.players.map(player => String(player?.profileId ?? player?.id ?? '')));
    const matchedWatchers = watchers.filter(watcher => (!targetWatcher || watcher === targetWatcher) && profileIds.has(String(watcher.profileId)) && (!completion || String(watcher.profileId) === String(completion.profileId)));
    if (!matchedWatchers.length) return;
    const state = await loadState();
    for (const watcher of matchedWatchers) {
      const legacyKey = `${watcher.platform}:${watcher.room}:${watcher.profileId}`;
      const stateKey = completion ? `${legacyKey}:ended:${id}`
        : residentSender?.noRetry ? `${legacyKey}:started:${id}` : legacyKey;
      if (!completion && String(state[legacyKey]?.lastMatchId || '') === id) continue;
      if (String(state[stateKey]?.lastMatchId || '') === id) continue;
      if (residentSender?.noRetry && String(state[stateKey]?.attemptedMatchId || '') === id) continue;
      const opening = !completion && residentSender?.formatStart
        ? await residentSender.formatStart(match, String(watcher.profileId)) : null;
      const message = completion?.message || opening?.join('，') || formatMessage(match, String(watcher.profileId));
      const limit = residentSender?.messageLimit || (watcher.platform === 'bilibili' ? 80 : 50);
      const separator = completion ? message.indexOf('，') : -1;
      const parts = separator >= 0 ? [message.slice(0, separator), message.slice(separator + 1)] : [message];
      const chunks = opening || parts.flatMap(part => splitMessage(part, limit));
      const previous = state[stateKey] || {};
      let nextChunk = String(previous.pendingMatchId || '') === id ? Number(previous.nextChunk || 0) : 0;
      state[stateKey] = { ...previous, pendingMatchId: id, nextChunk, message };
      await saveState(state);
      for (let attempt = 0; nextChunk < chunks.length; attempt += 1) {
        const offset = nextChunk;
        const remaining = chunks.slice(offset);
        const args = [scriptPath, '--platform', watcher.platform, 'send', '--room', String(watcher.room), '--message', remaining[0]];
        for (const message of remaining.slice(1)) args.push('--next-message', message);
        try {
          const preparedKey = `${watcher.platform}:${watcher.room}:${id}${completion ? `:ended:${completion.profileId}` : ''}`;
          if (attempt === 0 && preparationTasks.has(preparedKey)) await preparationTasks.get(preparedKey);
          const entry = attempt === 0 ? prepared.get(preparedKey) : null;
          if (entry) {
            prepared.delete(preparedKey);
            entry.child.stdin.end(JSON.stringify(remaining) + '\n');
          }
          const release = entry ? null : await acquireBrowser();
          let output;
          try {
            if (residentSender?.noRetry) {
              state[stateKey] = { ...state[stateKey], attemptedMatchId: id };
              await saveState(state);
            }
            output = await (residentSender ? residentSender.send(remaining) : entry ? entry.result : execFileAsync(pythonExecutable, args, {
            timeout: 90_000, maxBuffer: 1024 * 1024,
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath }
          })); } finally { release?.(); }
          const { stdout = '' } = output;
          if (stdout.trim()) console.log(`[danmaku] ${stdout.trim()}`);
          nextChunk = chunks.length;
        } catch (error) {
          // The child flushes one receipt for each acknowledged message.
          // On partial failure resume after those receipts, never at chunk 0.
          let acknowledged = 0;
          for (const line of String(error.stdout || '').split('\n')) {
            const receipt = /^DANMAKU_SENT (.+)$/.exec(line.trim());
            if (!receipt) continue;
            try {
              if (JSON.parse(receipt[1]).index === acknowledged) acknowledged += 1;
            } catch {}
          }
          nextChunk = Math.min(chunks.length, offset + acknowledged);
          state[stateKey] = { ...state[stateKey], nextChunk };
          await saveState(state);
          if (nextChunk === chunks.length) break;
          if (residentSender?.noRetry) {
            state[stateKey] = { ...state[stateKey], lastMatchId: id, failedAt: new Date().toISOString() };
            await saveState(state);
            error.terminal = true;
            throw error;
          }
          if (/返回码\s*356/.test(String(error.message))) throw error;
          if (attempt >= 3) throw error;
          console.warn(`[danmaku] send failed for match ${id}; retry ${attempt + 1}/3 from chunk ${nextChunk + 1} in 5s: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
        state[stateKey] = { ...state[stateKey], nextChunk };
        await saveState(state);
      }
      state[stateKey] = { lastMatchId: id, message, sentAt: new Date().toISOString() };
      await saveState(state);
      console.log(`[danmaku] ${completion ? 'matchEnded' : 'matchAdded'} ${id} -> ${watcher.platform}:${watcher.room}: ${message}`);
    }
  }

  function enqueue(match, completion = null) {
    const ids = new Set((match?.players || []).map(player => String(player.profileId ?? player.id)));
    const tasks = watchers.filter(watcher => ids.has(String(watcher.profileId)) && (!completion || String(watcher.profileId) === String(completion.profileId))).map(watcher => {
      // Browser acquisition already serializes room work. A second queue here
      // can deadlock behind a prepared browser that is waiting to be consumed.
      const key = `${watcher.platform}:${watcher.room}:${watcher.profileId}:${completion ? 'ended' : 'started'}:${matchId(match)}`;
      if (notificationTasks.has(key)) return notificationTasks.get(key);
      const task = Promise.resolve().then(() => processMatch(match, completion, watcher))
        .finally(() => notificationTasks.delete(key));
      const settled = task.catch(error => console.warn(`[danmaku] ${completion ? 'matchEnded' : 'matchAdded'} notification failed:`, error.message));
      const result = completion ? task : settled;
      notificationTasks.set(key, result);
      return result;
    });
    return Promise.all(tasks);
  }

  function handleMatchAdded(match) {
    return enqueue(match);
  }

  function handleMatchEnded(match, profileId, message) {
    return enqueue(match, { profileId, message });
  }
  return { handleMatchAdded, handleMatchEnded, prepareMatch, prepareMatchEnded: (match, profileId) => prepareMatch(match, String(profileId)), cancelPreparedEnd };
}
