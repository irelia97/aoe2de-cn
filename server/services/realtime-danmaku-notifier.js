function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:rm|dm|ew|cm)[_-]/, '')
    .replace(/[^a-z0-9]+/g, '');
}

const mapNamesZh = new Map(Object.entries({
  arabia: '阿拉伯半岛',
  arabiandesert: '阿拉伯沙漠',
  arena: '竞技场',
  blackforest: '黑森林',
  fourlakes: '四片湖泊',
  goldenpit: '金矿谷',
  goldrush: '淘金潮',
  hideout: '藏身之处',
  landnomad: '陆地游牧',
  megarandom: '超级随机',
  nomad: '游牧',
  runestones: '符文石群'
}));

const serverNamesZh = new Map(Object.entries({
  australia: '澳大利亚',
  brazilsouth: '巴西南部',
  eastasia: '东亚',
  koreacentral: '韩国中部',
  southeastasia: '东南亚',
  southafricanorth: '南非北部',
  uksouth: '英国南部',
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
    execFileAsync,
    pythonExecutable,
    scriptPath,
    playwrightBrowsersPath,
    watchers = []
  } = deps;
  let queue = Promise.resolve();
  let statePromise;

  async function loadState() {
    if (!statePromise) {
      statePromise = readFile(statePath, 'utf8')
        .then(text => JSON.parse(text))
        .catch(() => ({}));
    }
    return statePromise;
  }

  async function saveState(state) {
    await writeFile(statePath, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
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

  async function processMatch(match) {
    const id = matchId(match);
    if (!id) return;
    if (match?.finished || match?.abandoned || !Array.isArray(match?.players) || match.players.length !== 2) return;
    const profileIds = new Set(match.players.map(player => String(player?.profileId ?? player?.id ?? '')));
    const matchedWatchers = watchers.filter(watcher => profileIds.has(String(watcher.profileId)));
    if (!matchedWatchers.length) return;
    const state = await loadState();
    for (const watcher of matchedWatchers) {
      const stateKey = `${watcher.platform}:${watcher.room}:${watcher.profileId}`;
      if (String(state[stateKey]?.lastMatchId || '') === id) continue;
      const message = formatMessage(match, String(watcher.profileId));
      const limit = watcher.platform === 'bilibili' ? 80 : 50;
      const chunks = splitMessage(message, limit);
      const previous = state[stateKey] || {};
      let nextChunk = String(previous.pendingMatchId || '') === id ? Number(previous.nextChunk || 0) : 0;
      state[stateKey] = { ...previous, pendingMatchId: id, nextChunk, message };
      await saveState(state);
      for (let index = nextChunk; index < chunks.length; index += 1) {
        let sent = false;
        let lastError;
        // One initial attempt followed by at most three retries.
        for (let attempt = 0; attempt <= 3; attempt += 1) {
          try {
            const { stdout = '' } = await execFileAsync(pythonExecutable, [
              scriptPath,
              '--platform', watcher.platform,
              'send',
              '--room', String(watcher.room),
              '--message', chunks[index]
            ], {
              timeout: 90_000,
              maxBuffer: 1024 * 1024,
              env: {
                ...process.env,
                PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath
              }
            });
            if (stdout.trim()) console.log(`[danmaku] ${stdout.trim()}`);
            sent = true;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              console.warn(`[danmaku] send failed for match ${id}; retry ${attempt + 1}/3 in 5s: ${error.message}`);
              await new Promise(resolve => setTimeout(resolve, 5000));
            } else {
              console.warn(`[danmaku] send failed for match ${id} after 3 retries: ${error.message}`);
            }
          }
        }
        if (!sent) throw lastError || new Error('弹幕发送失败');
        nextChunk = index + 1;
        state[stateKey] = { ...state[stateKey], nextChunk };
        await saveState(state);
        if (index + 1 < chunks.length) await new Promise(resolve => setTimeout(resolve, 2000));
      }
      state[stateKey] = { lastMatchId: id, message, sentAt: new Date().toISOString() };
      await saveState(state);
      console.log(`[danmaku] matchAdded ${id} -> ${watcher.platform}:${watcher.room}: ${message}`);
    }
  }

  function handleMatchAdded(match) {
    queue = queue.then(() => processMatch(match)).catch(error => {
      console.warn('[danmaku] matchAdded notification failed:', error.message);
    });
    return queue;
  }

  return { handleMatchAdded };
}
