const body = document.querySelector('#leaderboardBody');
const ladderChoices = document.querySelector('#ladderChoices');
const countryFilter = document.querySelector('#countryFilter');
let currentRows = [];
let currentPage = 1;
let selectedLadder = 3;
let selectedCountry = 'all';
const leaderboardData = new Map();
const leaderboardRequests = new Map();
const leaderboardRetryAt = new Map();
const fmt = new Intl.NumberFormat('zh-CN');
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const themePreference = window.matchMedia('(prefers-color-scheme: light)');
const themeTabs = document.querySelector('#themeTabs');
function applyTheme(theme, persist = true) {
  const selected = ['light', 'dark', 'auto'].includes(theme) ? theme : 'auto';
  const resolved = selected === 'auto' ? (themePreference.matches ? 'light' : 'dark') : selected;
  document.documentElement.dataset.theme = selected;
  document.documentElement.dataset.resolvedTheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#e9e7df' : '#101310');
  themeTabs?.querySelectorAll('[data-theme-value]').forEach(button => {
    const active = button.dataset.themeValue === selected;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (persist) {
    try { localStorage.setItem('aoe2de:theme', selected); } catch { /* Local storage may be disabled. */ }
  }
}
themeTabs?.addEventListener('click', event => {
  const button = event.target.closest('[data-theme-value]');
  if (button) applyTheme(button.dataset.themeValue);
});
themePreference.addEventListener('change', () => {
  if (document.documentElement.dataset.theme === 'auto') applyTheme('auto', false);
});
applyTheme(document.documentElement.dataset.theme || 'auto', false);
const lazyDetails = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const row = entry.target;
    lazyDetails.unobserve(row);
    loadRowDetails(row);
  }
}, { rootMargin: '350px 0px' });

function countryFlag(code) {
  code = normalizeCountryCode(code);
  if (!code || code.length !== 2) return '🌐';
  return [...code.toUpperCase()].map(c => String.fromCodePoint(c.charCodeAt(0) + 127397)).join('');
}
function normalizeCountryCode(code) {
  const normalized = String(code || '').toUpperCase();
  return ['TW', 'HK', 'MO'].includes(normalized) ? 'CN' : normalized;
}
function countryName(code) {
  code = normalizeCountryCode(code);
  if (!code || code.length !== 2) return '未知地区';
  try { return countryNames.of(code.toUpperCase()) || '未知地区'; } catch { return '未知地区'; }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function repairMojibake(value) {
  const original = String(value ?? '');
  const points = [...original].map(character => character.codePointAt(0));
  if (!points.length || points.some(point => point > 0xff)) return original;
  try {
    const repaired = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(points));
    return /\p{Script=Han}/u.test(repaired) && !/\p{Script=Han}/u.test(original) ? repaired : original;
  } catch {
    return original;
  }
}
function formatTimeAgo(timestamp) {
  const playedAt = Number(timestamp);
  if (!Number.isFinite(playedAt) || playedAt <= 0) return null;
  const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000 - playedAt));
  if (secondsAgo < 60) return '刚刚';
  if (secondsAgo < 3600) return `${Math.floor(secondsAgo / 60)} 分钟前`;
  if (secondsAgo < 86400) return `${Math.floor(secondsAgo / 3600)} 小时前`;
  if (secondsAgo < 30 * 86400) return `${Math.floor(secondsAgo / 86400)} 天前`;
  if (secondsAgo < 365 * 86400) return `${Math.floor(secondsAgo / (30 * 86400))} 个月前`;
  return `${Math.floor(secondsAgo / (365 * 86400))} 年前`;
}
async function fetchJsonWithRetries(url, options = {}) {
  let retries = 0;
  while (true) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (retries >= 5) throw error;
      retries += 1;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
function rowMarkup(row, displayRank = Number(row.rank)) {
  const totalGames = Number(row.wins) + Number(row.losses);
  const totalRate = totalGames ? (Number(row.wins) / totalGames * 100).toFixed(1) : null;
  const rank = Number(displayRank);
  const medal = rank <= 3 ? ` medal-${rank}` : '';
  const streak = Number(row.streak || 0);
  const countryCode = normalizeCountryCode(row.country);
  const country = countryName(countryCode);
  const avatar = `<span class="avatar" title="${escapeHtml(row.name)} 的 Steam 头像" data-avatar="${escapeHtml(row.steamId || '')}"><span class="avatar-fallback">${escapeHtml((row.name || '?').slice(0, 1).toUpperCase())}</span></span>`;
  const lastMatch = formatTimeAgo(row.lastMatchDate);
  const lastMatchTitle = Number(row.lastMatchDate) > 0 ? new Date(Number(row.lastMatchDate) * 1000).toLocaleString('zh-CN') : '接口未提供上次比赛时间';
  const trophy = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v3h3v3a5 5 0 0 1-5 5h-.7a6 6 0 0 1-3.8 2.9V20h4v2H8.5v-2h4v-3.1A6 6 0 0 1 8.7 14H8a5 5 0 0 1-5-5V6h3V3Zm0 5H5v1a3 3 0 0 0 2.2 2.9A8 8 0 0 1 6 8Zm12 0a8 8 0 0 1-1.2 3.9A3 3 0 0 0 19 9V8h-1ZM8 5v3a4 4 0 0 0 8 0V5H8Z"/></svg>';
  return `<tr class="player-row" data-profile="${row.profileId}" data-steam="${escapeHtml(row.steamId || '')}" data-ladder="${selectedLadder}"><td><span class="rank${medal}">${rank <= 3 ? `<span class="medal-mark" title="第${rank}名奖杯">${trophy}</span>` : ''}${rank}</span></td><td><div class="country-cell" title="${escapeHtml(country)}"><span class="flag">${countryFlag(countryCode)}</span><span class="country-name">${escapeHtml(country)}</span></div></td><td><div class="player">${avatar}<a class="player-name" href="https://www.aoe2companion.com/players/${encodeURIComponent(row.profileId)}" target="_blank" rel="noreferrer">${escapeHtml(row.name)}</a></div></td><td><div class="rating-stack"><span class="rating">${fmt.format(row.rating)}</span><span class="peak-rating">最高 ${fmt.format(row.highestRating ?? row.rating)}</span></div></td><td><span class="record"><b>${fmt.format(row.wins)}</b><i>/</i>${fmt.format(row.losses)}</span></td><td><span class="rating">${totalRate === null ? '—' : `${totalRate}%`}</span></td><td><span class="streak${streak > 0 ? ' positive' : streak < 0 ? ' negative' : ''}">${streak > 0 ? '+' : ''}${streak}</span></td><td><span class="last-match-time" title="${escapeHtml(lastMatchTitle)}">${lastMatch || '暂无数据'}</span></td></tr>`;
}
async function loadRowDetails(row) {
  const avatar = row.querySelector('.avatar');
  const steamId = row.dataset.steam;
  if (steamId) {
    fetchJsonWithRetries(`/api/avatar?steamId=${encodeURIComponent(steamId)}`).then(data => {
      if (!avatar?.isConnected) return;
      if (!data) {
        return;
      }
      if (data.avatar) {
        const image = document.createElement('img');
        image.src = data.avatar;
        image.alt = '';
        image.loading = 'lazy';
        image.onerror = () => image.remove();
        avatar.replaceChildren(image);
      }
    }).catch(() => {
    });
  }
}
function renderRows(rows) {
  currentRows = rows;
  updateCountryFilterOptions(rows);
  currentPage = Math.min(currentPage, Math.max(1, Math.ceil(rows.length / 100)));
  renderPage();
}
function updateCountryFilterOptions(rows) {
  const countries = new Map();
  for (const code of ['CN', 'VN', 'US', 'CA', 'BR', 'AR']) countries.set(code, countryName(code));
  for (const row of rows) {
    const code = normalizeCountryCode(row.country);
    if (code.length === 2) countries.set(code, countryName(code));
  }
  if (selectedCountry !== 'all' && !countries.has(selectedCountry)) countries.set(selectedCountry, countryName(selectedCountry));
  const priority = ['CN', 'VN', 'US', 'CA', 'BR', 'AR'];
  const options = [...countries].sort((a, b) => {
    const aPriority = priority.indexOf(a[0]);
    const bPriority = priority.indexOf(b[0]);
    if (aPriority >= 0 || bPriority >= 0) return (aPriority < 0 ? Infinity : aPriority) - (bPriority < 0 ? Infinity : bPriority);
    return a[1].localeCompare(b[1], 'zh-CN');
  });
  countryFilter.innerHTML = `<option value="all">全部国家</option>${options.map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`).join('')}`;
  countryFilter.value = selectedCountry;
}
function renderPage() {
  const filteredRows = selectedCountry === 'all'
    ? currentRows
    : currentRows.filter(row => normalizeCountryCode(row.country) === selectedCountry);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / 100));
  currentPage = Math.min(currentPage, pageCount);
  const startIndex = (currentPage - 1) * 100;
  const pageRows = filteredRows.slice(startIndex, startIndex + 100);
  body.innerHTML = pageRows.length ? pageRows.map((row, index) => rowMarkup(row, selectedCountry === 'all' ? row.rank : startIndex + index + 1)).join('') : `<tr><td colspan="8" class="loading">${currentRows.length ? '该国籍暂无上榜玩家' : '暂无榜单数据'}</td></tr>`;
  const renderedRows = [...body.querySelectorAll('.player-row')];
  renderedRows.forEach(row => lazyDetails.observe(row));
  const start = filteredRows.length ? startIndex + 1 : 0;
  const end = Math.min(startIndex + pageRows.length, filteredRows.length);
  document.querySelector('#resultRange').textContent = `显示 ${start}–${end} / ${filteredRows.length}`;
  const pagination = document.querySelector('#pagination');
  pagination.innerHTML = `<button class="page-arrow" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''} aria-label="上一页">‹</button>${Array.from({ length: pageCount }, (_, i) => `<button class="page-number${i + 1 === currentPage ? ' selected' : ''}" data-page="${i + 1}" aria-current="${i + 1 === currentPage ? 'page' : 'false'}">${i + 1}</button>`).join('')}<button class="page-arrow" data-page="${currentPage + 1}" ${currentPage === pageCount ? 'disabled' : ''} aria-label="下一页">›</button>`;
  pagination.querySelectorAll('button:not(:disabled)').forEach(button => button.addEventListener('click', () => {
    currentPage = Number(button.dataset.page);
    renderPage();
    document.querySelector('.table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
countryFilter.addEventListener('change', () => {
  selectedCountry = countryFilter.value;
  currentPage = 1;
  renderPage();
});
function setError(message) {
  body.innerHTML = `<tr><td colspan="8" class="error-state"><span class="error-icon">!</span><div><b>暂时无法获取天梯数据</b><small>${escapeHtml(message)}</small></div><button id="retryBtn">重试</button></td></tr>`;
  document.querySelector('#retryBtn')?.addEventListener('click', loadLeaderboard);
}
function displayLeaderboard(data) {
  renderRows(data.rows);
  document.querySelector('#statLadder').textContent = data.label;
  document.querySelector('#boardType').textContent = data.label;
  document.querySelector('#statPlayers').textContent = fmt.format(data.total);
  document.querySelector('#statUpdated').textContent = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(data.updatedAt));
}
async function loadLeaderboard(force = false) {
  const ladderId = selectedLadder;
  const cached = leaderboardData.get(ladderId);
  if (cached) {
    displayLeaderboard(cached.data);
    if (!force && cached.expiresAt > Date.now()) return;
  } else if (!currentRows.length) {
    body.innerHTML = '<tr><td colspan="8" class="loading"><span class="loader"></span>正在加载天梯数据…</td></tr>';
  }
  if (leaderboardRequests.has(ladderId)) return leaderboardRequests.get(ladderId);
  const request = (async () => {
  let retries = 0;
  try {
    let data;
    while (true) {
      try {
        const response = await fetch(`/api/leaderboard?id=${ladderId}`, { cache: 'no-store' });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        break;
      } catch (error) {
        if (retries >= 5) throw error;
        retries += 1;
        if (ladderId === selectedLadder) {
          if (!currentRows.length) body.innerHTML = `<tr><td colspan="8" class="loading"><span class="loader"></span>正在重试（${retries}/5）…</td></tr>`;
          else document.querySelector('#statUpdated').textContent = `正在重试（${retries}/5）…`;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    const expiresAt = Number(data.cacheExpiresAt) || Date.now() + 60_000;
    leaderboardData.set(ladderId, { data, expiresAt });
    leaderboardRetryAt.delete(ladderId);
    if (ladderId === selectedLadder) displayLeaderboard(data);
  } catch (error) {
    leaderboardRetryAt.set(ladderId, Date.now() + 60_000);
    if (ladderId === selectedLadder) {
      if (currentRows.length) document.querySelector('#statUpdated').textContent = `更新失败 · ${error.message}`;
      else setError(error.message || '请检查网络连接后重试');
    }
  }
  })();
  leaderboardRequests.set(ladderId, request);
  try { await request; } finally { leaderboardRequests.delete(ladderId); }
}
ladderChoices.querySelectorAll('.ladder-choice').forEach(button => button.addEventListener('click', () => {
  const ladderId = Number(button.dataset.ladder);
  if (ladderId === selectedLadder) return;
  selectedLadder = ladderId;
  ladderChoices.querySelectorAll('.ladder-choice').forEach(choice => {
    const active = choice === button;
    choice.classList.toggle('selected', active);
    choice.setAttribute('aria-pressed', String(active));
  });
  currentPage = 1;
  const cached = leaderboardData.get(ladderId);
  if (cached) displayLeaderboard(cached.data);
  else {
    currentRows = [];
    body.innerHTML = '<tr><td colspan="8" class="loading"><span class="loader"></span>正在加载天梯数据…</td></tr>';
  }
  updateCountdown();
  loadLeaderboard();
}));
function updateCountdown() {
  if (location.pathname.startsWith('/profile')) return;
  const cached = leaderboardData.get(selectedLadder);
  const updateAt = cached?.expiresAt ?? leaderboardRetryAt.get(selectedLadder);
  const seconds = updateAt ? Math.max(0, Math.ceil((updateAt - Date.now()) / 1000)) : '—';
  document.querySelector('#countdown').textContent = seconds;
  if (seconds === 0 && !leaderboardRequests.has(selectedLadder)) loadLeaderboard();
}
if (!location.pathname.startsWith('/profile')) loadLeaderboard();
setInterval(updateCountdown, 1000);

const profileSearchForm = document.querySelector('#profileSearchForm');
const profileSearchInput = document.querySelector('#profileSearchInput');
const profileSearchSuggestions = document.querySelector('#profileSearchSuggestions');
const profileSearchMeta = document.querySelector('#profileSearchMeta');
let profileSuggestTimer = null;
let profileSuggestController = null;
let profileSuggestRequestId = 0;
let profileSuggestActiveIndex = -1;
let profileSuggestResults = [];
let profileSuggestExpanded = false;
let profileDetailsRequestId = 0;
let profileDetailsSocket = null;
let profileDetailsTimeout = null;
let profileDetailsRetryTimer = null;
let profileDetailsRequestTimer = null;

function formatBytes(bytes) {
  if (!Number(bytes)) return '';
  return `${(Number(bytes) / 1024 / 1024).toFixed(0)} MB`;
}
function renderProfileSearchStatus(state) {
  if (state.refreshing) {
    const transfer = state.totalBytes
      ? ` · ${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`
      : '';
    const rows = state.processedRows ? ` · 已整理 ${fmt.format(state.processedRows)} 名玩家` : '';
    const fallback = state.ready ? '当前可继续使用旧资料库；' : '';
    profileSearchMeta.textContent = `${fallback}${state.stage}${transfer}${rows}`;
    return;
  }
  if (state.ready) {
    const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleString('zh-CN') : '时间未知';
    profileSearchMeta.textContent = state.error
      ? `资料库已就绪（更新失败，继续使用旧版本）：${updated}`
      : `资料库已就绪 · 更新于 ${updated}`;
    return;
  }
  profileSearchMeta.textContent = state.error
    ? `资料库暂不可用：${state.error}`
    : `首次准备玩家资料库：${state.stage || '等待启动'}`;
}
async function refreshProfileSearchStatus() {
  try {
    const response = await fetch('/api/profile-search/status', { cache: 'no-store' });
    if (response.ok) renderProfileSearchStatus(await response.json());
  } catch {
    profileSearchMeta.textContent = '暂时无法连接玩家资料服务';
  }
}
function profileSuggestionMarkup(player, index) {
  const country = player.country ? countryName(player.country) : '未知地区';
  const clan = player.clan ? ` · ${escapeHtml(player.clan)}` : '';
  const lastMatch = player.lastMatchTime ? `上次游戏 ${escapeHtml(player.lastMatchTime)}` : '';
  const rating = player.rating !== null && player.rating !== undefined && Number.isFinite(Number(player.rating)) ? ` · 积分 ${fmt.format(Number(player.rating))}` : '';
  const alias = player.aliases?.length ? ` · 别名 ${escapeHtml(player.aliases.join('、'))}` : '';
  const details = [escapeHtml(country), clan.trim(), rating.trim(), alias.trim(), lastMatch].filter(Boolean).join(' · ');
  const avatarFallback = escapeHtml((player.name || '?').slice(0, 1).toUpperCase());
  return `<a class="profile-suggestion${index === profileSuggestActiveIndex ? ' active' : ''}" role="option" aria-selected="${index === profileSuggestActiveIndex}" data-suggestion-index="${index}" data-steam="${escapeHtml(player.steamId || '')}" href="/profile/${encodeURIComponent(player.profileId)}"><span class="profile-suggestion-avatar">${avatarFallback}</span><span class="profile-suggestion-main"><span class="profile-suggestion-name">${escapeHtml(player.name)}</span><span class="profile-suggestion-sub">${details}</span></span><span class="profile-suggestion-arrow" aria-hidden="true">›</span></a>`;
}
function renderPlayerDetailsRows(details) {
  const accounts = Array.isArray(details.accounts) ? details.accounts : [];
  if (!accounts.length) return '<tr><td colspan="4">暂无账号数据</td></tr>';
  return accounts.map(account => {
    const aliases = Array.isArray(account.akas) ? account.akas.filter(alias => typeof alias === 'string' && alias.trim()).map(repairMojibake) : [];
    const accountName = account.name || '未命名账号';
    const accountUrl = typeof account.url === 'string' && account.url.startsWith('https://') ? account.url : '';
    const accountMarkup = accountUrl ? `<a href="${escapeHtml(accountUrl)}" target="_blank" rel="noreferrer">${escapeHtml(accountName)} ↗</a>` : escapeHtml(accountName);
    return `<tr><td>${escapeHtml(account.platform || '未知平台')}</td><td>${accountMarkup}</td><td>${escapeHtml(account.id ?? '—')}</td><td>${aliases.length ? aliases.map(escapeHtml).join('、') : '无'}</td></tr>`;
  }).join('');
}
const aoe2RecsProfileCachePrefix = 'aoe2de:aoe2recs-profile:v1:';
const aoe2RecsProfileCacheTtl = 48 * 60 * 60 * 1000;
function readAoE2RecsProfileCache(profileId) {
  const key = `${aoe2RecsProfileCachePrefix}${profileId}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (!cached) return null;
    if (!Number.isFinite(cached.savedAt) || cached.savedAt > Date.now() || Date.now() - cached.savedAt >= aoe2RecsProfileCacheTtl || !cached.profile || typeof cached.profile !== 'object') {
      try { localStorage.removeItem(key); } catch { /* Local storage may be disabled. */ }
      return null;
    }
    return cached.profile;
  } catch {
    try { localStorage.removeItem(key); } catch { /* Local storage may be disabled. */ }
    return null;
  }
}
function saveAoE2RecsProfileCache(profileId, profile) {
  const cachedProfile = {
    player: profile.player || null,
    accounts: Array.isArray(profile.accounts) ? profile.accounts : []
  };
  try {
    localStorage.setItem(`${aoe2RecsProfileCachePrefix}${profileId}`, JSON.stringify({ savedAt: Date.now(), profile: cachedProfile }));
  } catch {
    // Quota or privacy settings may disable local storage; keep the live result usable.
  }
}
function renderAoE2RecsProfile(profile, profileId, fallbackName) {
  document.querySelector('#profileDetailsName').textContent = profile.player?.name || fallbackName || `玩家 ${profileId}`;
  const player = profile.player || {};
  const summary = [player.clan, player.country_code ? countryName(player.country_code) : '', player.id ? `AoE2 ID ${player.id}` : ''].filter(Boolean);
  document.querySelector('#profilePageSummary').textContent = summary.join(' · ');
  document.querySelector('#profileDetailsBody').innerHTML = renderPlayerDetailsRows(profile);
}
function routeToPlayerProfile(player) {
  if (!player?.profileId) return;
  history.pushState({ profileId: String(player.profileId), name: String(player.name || '') }, '', `/profile/${encodeURIComponent(player.profileId)}`);
  hideProfileSuggestions();
  renderCurrentRoute(player);
}
function setProfileMessage(message, className = 'profile-details-empty') {
  document.querySelector('#profileDetailsBody').innerHTML = `<tr><td colspan="4" class="${className}">${message}</td></tr>`;
}
function renderCurrentRoute(selectedPlayer = null) {
  const match = location.pathname.match(/^\/profile(?:\/(\d+))?\/?$/);
  const isProfilePage = Boolean(match);
  const profileId = match?.[1] || '';
  document.body.classList.toggle('page-profile', isProfilePage);
  document.querySelector('#player-profile').hidden = !isProfilePage;
  document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(link => {
    const active = link.dataset.page === (isProfilePage ? 'profile' : 'leaderboard');
    link.classList.toggle('active', active);
  });
  document.querySelector('.breadcrumbs b').textContent = isProfilePage ? '选手资料' : '天梯榜单';
  if (!isProfilePage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    return;
  }
  if (!profileId) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    document.querySelector('#profileDetailsName').textContent = '搜索并选择一名玩家';
    document.querySelector('#profilePageSummary').textContent = '';
    setProfileMessage('请使用页面顶部的搜索框查找并选择玩家。');
    return;
  }
  loadAoE2RecsProfile(profileId, selectedPlayer?.name || history.state?.name || '');
}
function loadAoE2RecsProfile(profileId, fallbackName = '') {
  clearTimeout(profileDetailsTimeout);
  clearTimeout(profileDetailsRetryTimer);
  clearInterval(profileDetailsRequestTimer);
  profileDetailsSocket?.close();
  const requestId = ++profileDetailsRequestId;
  const profileName = document.querySelector('#profileDetailsName');
  profileName.textContent = fallbackName || `玩家 ${profileId}`;
  document.querySelector('#profilePageSummary').textContent = '';
  const cachedProfile = readAoE2RecsProfileCache(profileId);
  if (cachedProfile) {
    renderAoE2RecsProfile(cachedProfile, profileId, fallbackName);
    return;
  }
  setProfileMessage('<span class="loader"></span>加载中');
  let retryCount = 0;

  const finish = (data, socket, attempt) => {
    if (attempt.finished || requestId !== profileDetailsRequestId || !data || typeof data !== 'object') return;
    const profile = data.person && typeof data.person === 'object' ? data.person : data;
    if (profile.found === false || profile.player === null) {
      attempt.finished = true;
      clearTimeout(profileDetailsTimeout);
      clearInterval(profileDetailsRequestTimer);
      setProfileMessage('未找到该选手资料。', 'profile-details-error');
      socket.close();
      return;
    }
    if (!Array.isArray(profile.accounts) && !profile.player) return;
    attempt.finished = true;
    clearTimeout(profileDetailsTimeout);
    clearInterval(profileDetailsRequestTimer);
    if (socket === profileDetailsSocket) profileDetailsSocket = null;
    saveAoE2RecsProfileCache(profileId, profile);
    renderAoE2RecsProfile(profile, profileId, fallbackName);
    socket.close();
  };

  const connect = () => {
    if (requestId !== profileDetailsRequestId) return;
    const attempt = { finished: false, requestSent: false, sends: 0 };
    let socket;
    const retryOrFail = () => {
      if (attempt.finished || requestId !== profileDetailsRequestId) return;
      attempt.finished = true;
      clearTimeout(profileDetailsTimeout);
      clearInterval(profileDetailsRequestTimer);
      if (socket === profileDetailsSocket) profileDetailsSocket = null;
      socket?.close();
      if (retryCount < 5) {
        retryCount++;
        profileDetailsRetryTimer = setTimeout(connect, Math.min(500 * (2 ** (retryCount - 1)), 4000));
      } else {
        setProfileMessage('加载失败（已重试 5 次），请稍后再试。', 'profile-details-error');
      }
    };
    try {
      socket = new WebSocket('wss://aoe2recs.com/dashboard/api/');
      profileDetailsSocket = socket;
    } catch {
      retryOrFail();
      return;
    }
    profileDetailsTimeout = setTimeout(retryOrFail, 12000);
    socket.addEventListener('message', event => {
      if (requestId !== profileDetailsRequestId || attempt.finished) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      // AoE2Recs ignores profile_id requests sent immediately on open. Wait for
      // its first dashboard state batch before asking for the profile.
      if (!attempt.requestSent && message.cls === 3) {
        attempt.requestSent = true;
        const sendProfileRequest = () => {
          if (attempt.finished || socket.readyState !== WebSocket.OPEN || attempt.sends >= 3) {
            clearInterval(profileDetailsRequestTimer);
            return;
          }
          attempt.sends++;
          socket.send(JSON.stringify({ profile_id: Number(profileId) }));
        };
        sendProfileRequest();
        profileDetailsRequestTimer = setInterval(sendProfileRequest, 1500);
      }
      if (message.cls === 13) finish(message.data, socket, attempt);
      if (message.cls === 3 && Array.isArray(message.data)) {
        for (const update of message.data) if (update.cls === 13) finish(update.data, socket, attempt);
      }
    });
    socket.addEventListener('error', retryOrFail);
    socket.addEventListener('close', () => {
      if (socket === profileDetailsSocket) profileDetailsSocket = null;
      retryOrFail();
    });
  };

  connect();
}
function hideProfileSuggestions() {
  profileSearchSuggestions.hidden = true;
  profileSearchSuggestions.innerHTML = '';
  profileSuggestActiveIndex = -1;
  profileSearchInput.setAttribute('aria-expanded', 'false');
}
function renderProfileSuggestions(results, query) {
  profileSuggestResults = results;
  const visibleResults = profileSuggestExpanded ? results : results.slice(0, 5);
  profileSuggestActiveIndex = -1;
  if (!visibleResults.length) {
    profileSearchSuggestions.innerHTML = '<div class="profile-suggestions-message">没有找到匹配的玩家昵称</div>';
  } else {
    const moreButton = !profileSuggestExpanded && results.length > 5
      ? '<button type="button" class="profile-suggestions-all">查看全部匹配结果 <span>›</span></button>' : '';
    profileSearchSuggestions.innerHTML = `${visibleResults.map(profileSuggestionMarkup).join('')}${moreButton}`;
    profileSearchSuggestions.querySelector('.profile-suggestions-all')?.addEventListener('click', () => {
      profileSuggestExpanded = true;
      renderProfileSuggestions(profileSuggestResults, query);
    });
  }
  for (const avatar of profileSearchSuggestions.querySelectorAll('.profile-suggestion[data-steam]:not([data-steam=""])')) {
    fetch(`/api/avatar?steamId=${encodeURIComponent(avatar.dataset.steam)}`, { cache: 'force-cache' }).then(response => response.ok ? response.json() : null).then(data => {
      if (!data?.avatar || !avatar.isConnected) return;
      const image = document.createElement('img');
      image.src = data.avatar;
      image.alt = '';
      avatar.querySelector('.profile-suggestion-avatar').replaceChildren(image);
    }).catch(() => {});
  }
  for (const option of profileSearchSuggestions.querySelectorAll('.profile-suggestion[data-suggestion-index]')) {
    option.addEventListener('click', event => {
      event.preventDefault();
      const player = profileSuggestResults[Number(option.dataset.suggestionIndex)];
      routeToPlayerProfile(player);
    });
  }
  profileSearchSuggestions.hidden = false;
  profileSearchInput.setAttribute('aria-expanded', 'true');
}
async function loadProfileSuggestions() {
  const query = profileSearchInput.value.trim();
  const requestId = ++profileSuggestRequestId;
  profileSuggestController?.abort();
  if ([...query].length < 2) { hideProfileSuggestions(); return; }
  profileSuggestExpanded = false;
  profileSuggestController = new AbortController();
  profileSearchSuggestions.innerHTML = '<div class="profile-suggestions-message"><span class="loader"></span>正在查找玩家…</div>';
  profileSearchSuggestions.hidden = false;
  profileSearchInput.setAttribute('aria-expanded', 'true');
  try {
    const response = await fetch(`/api/profile-search?q=${encodeURIComponent(query)}&leaderboardId=${encodeURIComponent(selectedLadder)}`, { cache: 'no-store', signal: profileSuggestController.signal });
    const data = await response.json();
    if (requestId !== profileSuggestRequestId || query !== profileSearchInput.value.trim()) return;
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    renderProfileSuggestions(data.results || [], query);
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== profileSuggestRequestId) return;
    profileSearchSuggestions.innerHTML = `<div class="profile-suggestions-message profile-search-error">${escapeHtml(error.message || '暂时无法搜索玩家')}</div>`;
    profileSearchSuggestions.hidden = false;
  }
}
profileSearchInput.setAttribute('role', 'combobox');
profileSearchInput.setAttribute('aria-autocomplete', 'list');
profileSearchInput.setAttribute('aria-controls', 'profileSearchSuggestions');
profileSearchInput.setAttribute('aria-expanded', 'false');
profileSearchInput.addEventListener('input', () => {
  clearTimeout(profileSuggestTimer);
  profileSuggestTimer = setTimeout(loadProfileSuggestions, 220);
});
profileSearchInput.addEventListener('keydown', event => {
  const options = [...profileSearchSuggestions.querySelectorAll('[data-suggestion-index]')];
  if (event.key === 'Escape') { hideProfileSuggestions(); return; }
  if (!options.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    profileSuggestActiveIndex = (profileSuggestActiveIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options.forEach((option, index) => {
      option.classList.toggle('active', index === profileSuggestActiveIndex);
      option.setAttribute('aria-selected', String(index === profileSuggestActiveIndex));
    });
  } else if (event.key === 'Enter' && profileSuggestActiveIndex >= 0) {
    event.preventDefault();
    options[profileSuggestActiveIndex].click();
  }
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.profile-search-input-wrap')) hideProfileSuggestions();
});
profileSearchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const query = profileSearchInput.value.trim();
  if ([...query].length < 2) return;
  if (profileSearchSuggestions.hidden) await loadProfileSuggestions();
  else profileSearchSuggestions.querySelector('[data-suggestion-index]')?.click();
});
document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  history.pushState({}, '', link.dataset.page === 'profile' ? '/profile' : '/');
  renderCurrentRoute();
}));
window.addEventListener('popstate', () => renderCurrentRoute());
renderCurrentRoute();
refreshProfileSearchStatus();
setInterval(refreshProfileSearchStatus, 5000);
