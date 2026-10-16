const body = document.querySelector('#leaderboardBody');
const ladderChoices = document.querySelector('#ladderChoices');
const countryFilter = document.querySelector('#countryFilter');
let currentRows = [];
let currentTotalRows = 0;
const leaderboardViewStorageKey = 'aoe2de:leaderboard-view:v1';
function readSavedLeaderboardView() {
  try {
    const saved = JSON.parse(localStorage.getItem(leaderboardViewStorageKey) || 'null');
    if (!saved || typeof saved !== 'object') return null;
    return {
      ladder: Number.isFinite(Number(saved.ladder)) ? Number(saved.ladder) : 3,
      country: typeof saved.country === 'string' && saved.country ? saved.country : 'all',
      page: Math.max(1, Number(saved.page) || 1)
    };
  } catch { return null; }
}
function persistLeaderboardView() {
  const view = { ladder: selectedLadder, country: selectedCountry, page: currentPage };
  try { localStorage.setItem(leaderboardViewStorageKey, JSON.stringify(view)); } catch { /* Storage may be disabled. */ }
  if (!location.pathname.startsWith('/profile')) {
    history.replaceState({ ...(history.state || {}), leaderboard: view }, '', location.href);
  }
}
const savedLeaderboardView = readSavedLeaderboardView();
let currentPage = savedLeaderboardView?.page || 1;
let selectedLadder = savedLeaderboardView?.ladder || 3;
let selectedCountry = savedLeaderboardView?.country || 'all';
const leaderboardData = new Map();
const leaderboardRequests = new Map();
const leaderboardPageRequests = new Map();
const leaderboardRetryAt = new Map();
const leaderboardSummaryCache = new Map();
const leaderboardSummaryRequests = new Map();
const leaderboardLocalCachePrefix = 'aoe2de:leaderboard-cache:v2:';
function readLeaderboardLocalCache(id) {
  try {
    const cached = JSON.parse(localStorage.getItem(`${leaderboardLocalCachePrefix}${id}`) || 'null');
    if (!cached?.data || typeof cached.data !== 'object') return null;
    return { data: cached.data, expiresAt: Number(cached.expiresAt) || 0, savedAt: Number(cached.savedAt) || 0 };
  } catch { return null; }
}
function saveLeaderboardLocalCache(id, data, expiresAt = Number(data.cacheExpiresAt) || Date.now() + 60_000) {
  try {
    localStorage.setItem(`${leaderboardLocalCachePrefix}${id}`, JSON.stringify({ data, expiresAt, savedAt: Date.now() }));
  } catch { /* Storage may be disabled or full. */ }
}
const fmt = new Intl.NumberFormat('zh-CN');
const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const themeTabs = document.querySelector('#themeTabs');
function setProfileAccountsModal(open) {
  const modal = document.querySelector('#profileAccounts');
  if (modal) modal.hidden = !open;
  if (open) document.querySelector('#profileAccountsClose')?.focus();
}
document.querySelector('#profileAliasesButton')?.addEventListener('click', () => setProfileAccountsModal(true));
document.querySelector('#profileAccountsClose')?.addEventListener('click', () => setProfileAccountsModal(false));
document.querySelector('#profileAccounts')?.addEventListener('click', event => {
  if (event.target.id === 'profileAccounts') setProfileAccountsModal(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('#profileAccounts')?.hidden) setProfileAccountsModal(false);
});
function applyTheme(theme, persist = true) {
  const selected = ['light', 'dark'].includes(theme) ? theme : 'dark';
  const resolved = selected;
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
applyTheme(document.documentElement.dataset.theme || 'dark', false);
const lazyDetails = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const row = entry.target;
    lazyDetails.unobserve(row);
    loadRowDetails(row);
  }
}, { rootMargin: '350px 0px' });

function countryFlag(code) {
  const raw = String(code || '').toUpperCase();
  code = raw === 'HK' ? 'HK' : normalizeCountryCode(raw);
  if (!code || code.length !== 2) return '🌐';
  return '<img class="country-flag-img" src="https://flagcdn.com/24x18/' + code.toLowerCase() + '.png" alt="' + code + '" title="' + escapeHtml(countryName(raw)) + '" loading="lazy">';
}
function normalizeCountryCode(code) {
  const normalized = String(code || '').toUpperCase();
  return ['HK', 'MO', 'TW'].includes(normalized) ? 'CN' : normalized;
}
function leaderboardCountryCode(code) {
  return String(code || '').trim().toUpperCase();
}
function leaderboardCountryFlag(code) {
  const normalized = leaderboardCountryCode(code);
  if (!/^[A-Z]{2}$/.test(normalized)) return '🌐';
  const flagCode = normalized === 'TW' ? 'CN' : normalized;
  return '<img class="country-flag-img" src="https://flagcdn.com/24x18/' + flagCode.toLowerCase() + '.png" alt="' + flagCode + '" loading="lazy">';
}
function profileCountryMarkup(code) {
  const normalized = String(code || '').trim();
  if (!normalized) return '未知国籍';
  return `<span class="profile-country-inline">${countryFlag(normalized)}<span>${escapeHtml(countryName(normalized))}</span></span>`;
}
function countryName(code) {
  const raw = String(code || '').toUpperCase();
  if (raw === 'CN') return '中国';
  if (raw === 'HK') return '中国香港';
  if (raw === 'MO') return '中国澳门';
  if (raw === 'TW') return '中国台湾';
  code = normalizeCountryCode(raw);
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
  const countryCode = leaderboardCountryCode(row.country);
  const country = countryName(countryCode);
  const countryCell = selectedCountry === 'all'
    ? `<div class="country-cell" title="${escapeHtml(country)}"><span class="flag">${leaderboardCountryFlag(countryCode)}</span><span class="country-name">${escapeHtml(country)}</span></div>`
    : `<span class="world-rank-cell">#${fmt.format(Number(row.rank))}</span>`;
  const avatar = selectedLadder === 15 ? '' : `<span class="avatar" title="${escapeHtml(row.name)} 的 Steam 头像" data-avatar="${escapeHtml(row.steamId || '')}"><span class="avatar-fallback">${escapeHtml((row.name || '?').slice(0, 1).toUpperCase())}</span></span>`;
  const eloChange = Number(row.eloChange || 0);
  const streakCell = selectedLadder === 15
    ? `<span class="elo-change${eloChange > 0 ? ' positive' : eloChange < 0 ? ' negative' : ''}">${eloChange > 0 ? '+' : ''}${fmt.format(eloChange)}</span>`
    : `<span class="streak${streak > 0 ? ' positive' : streak < 0 ? ' negative' : ''}">${streak > 0 ? '+' : ''}${streak}</span>`;
  const lastMatch = formatTimeAgo(row.lastMatchDate);
  const lastMatchTitle = Number(row.lastMatchDate) > 0 ? new Date(Number(row.lastMatchDate) * 1000).toLocaleString('zh-CN') : '接口未提供上次比赛时间';
  const trophy = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v3h3v3a5 5 0 0 1-5 5h-.7a6 6 0 0 1-3.8 2.9V20h4v2H8.5v-2h4v-3.1A6 6 0 0 1 8.7 14H8a5 5 0 0 1-5-5V6h3V3Zm0 5H5v1a3 3 0 0 0 2.2 2.9A8 8 0 0 1 6 8Zm12 0a8 8 0 0 1-1.2 3.9A3 3 0 0 0 19 9V8h-1ZM8 5v3a4 4 0 0 0 8 0V5H8Z"/></svg>';
  const nameMarkup = selectedLadder === 15
    ? `<span class="player-name player-name-static">${escapeHtml(row.name)}</span>`
    : `<a class="player-name" href="/profile/${encodeURIComponent(row.profileId)}">${escapeHtml(row.name)}</a>`;
  return `<tr class="player-row" data-profile="${row.profileId}" data-steam="${escapeHtml(row.steamId || '')}" data-ladder="${selectedLadder}"><td><span class="rank${medal}">${rank <= 3 ? `<span class="medal-mark" title="第${rank}名奖杯">${trophy}</span>` : rank}</span></td><td>${countryCell}</td><td><div class="player">${avatar}${nameMarkup}</div></td><td><div class="rating-stack"><span class="rating">${fmt.format(row.rating)}</span><span class="peak-rating">最高 ${fmt.format(row.highestRating ?? row.rating)}</span></div></td><td><span class="record"><b>${fmt.format(row.wins)}</b><i>/</i>${fmt.format(row.losses)}</span></td><td><span class="winrate-number">${totalRate === null ? '—' : `${totalRate}%`}</span></td><td>${streakCell}</td><td><span class="last-match-time" title="${escapeHtml(lastMatchTitle)}">${lastMatch || '暂无数据'}</span></td></tr>`;
}
async function loadRowDetails(row) {
  const avatar = row.querySelector('.avatar');
  const steamId = row.dataset.steam;
  if (steamId) {
    fetchJsonWithRetries(`/api/avatar?steamId=${encodeURIComponent(steamId)}`, { cache: 'force-cache' }).then(data => {
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
  const availableRows = selectedCountry === 'all' ? (currentTotalRows || rows.length) : rows.length;
  currentPage = Math.min(currentPage, Math.max(1, Math.ceil(availableRows / 100)));
  renderPage();
}
function updateCountryFilterOptions(rows) {
  const countries = new Map();
  for (const code of ['CN', 'VN', 'US', 'CA', 'BR', 'AR']) countries.set(code, countryName(code));
  for (const row of rows) {
    const code = leaderboardCountryCode(row.country);
    if (code.length === 2) countries.set(code, countryName(code));
  }
  if (selectedCountry !== 'all' && !countries.has(selectedCountry)) countries.set(selectedCountry, countryName(selectedCountry));
  const priority = ['CN', 'HK', 'TW', 'VN', 'US', 'CA', 'BR', 'AR'];
  const options = [...countries].sort((a, b) => {
    const aPriority = priority.indexOf(a[0]);
    const bPriority = priority.indexOf(b[0]);
    if (aPriority >= 0 || bPriority >= 0) return (aPriority < 0 ? Infinity : aPriority) - (bPriority < 0 ? Infinity : bPriority);
    return a[1].localeCompare(b[1], 'zh-CN');
  });
  countryFilter.innerHTML = `<option value="all">全部国家/地区</option>${options.map(([code, name]) => `<option value="${escapeHtml(code)}">${escapeHtml(name)}</option>`).join('')}`;
  countryFilter.value = selectedCountry;
}
function renderPagination(pageCount, currentPage) {
  const pages = [];
  const add = value => { if (pages[pages.length - 1] !== value) pages.push(value); };
  for (let page = 1; page <= pageCount; page += 1) {
    if (page === 1 || page === pageCount || Math.abs(page - currentPage) <= 2) add(page);
    else if (pages[pages.length - 1] !== 'ellipsis') add('ellipsis');
  }
  return pages.map(page => page === 'ellipsis'
    ? '<span class="pagination-ellipsis" aria-hidden="true">…</span>'
    : `<button class="page-number${page === currentPage ? ' selected' : ''}" data-page="${page}"${page === currentPage ? ' aria-current="page"' : ''}>${page}</button>`).join('');
}
function renderPage() {
  const leaderboardTable = document.querySelector('.table-wrap table');
  if (leaderboardTable) leaderboardTable.classList.toggle('tournament-mode', selectedLadder === 15);
  const filteredRows = selectedCountry === 'all'
    ? currentRows
    : currentRows.filter(row => leaderboardCountryCode(row.country) === selectedCountry);
  const totalRows = selectedCountry === 'all' ? (currentTotalRows || filteredRows.length) : filteredRows.length;
  const pageCount = Math.max(1, Math.ceil(totalRows / 100));
  currentPage = Math.min(currentPage, pageCount);
  const startIndex = (currentPage - 1) * 100;
  const pageRows = filteredRows.slice(startIndex, startIndex + 100);
  const cachedEntry = leaderboardData.get(selectedLadder);
  const loadedPages = Array.isArray(cachedEntry?.data?.loadedPages) ? cachedEntry.data.loadedPages : [];
  const pageLoaded = selectedCountry !== 'all' || loadedPages.includes(currentPage);
  const countryHeader = document.querySelector('#countryColumnHeader');
  if (countryHeader) countryHeader.textContent = selectedCountry === 'all' ? '国家/地区' : '世界排名';
  const streakHeader = document.querySelector('.streak-col');
  if (streakHeader) streakHeader.textContent = selectedLadder === 15 ? '近60天积分变化' : '连胜';
  const emptyMessage = !pageLoaded ? '<span class="loader"></span>正在加载该分页…' : currentRows.length ? '该国籍暂无上榜玩家' : '暂无榜单数据';
  body.innerHTML = pageRows.length ? pageRows.map((row, index) => rowMarkup(row, selectedCountry === 'all' ? row.rank : startIndex + index + 1)).join('') : `<tr><td colspan="8" class="loading">${emptyMessage}</td></tr>`;
  const renderedRows = [...body.querySelectorAll('.player-row')];
  renderedRows.forEach(row => lazyDetails.observe(row));
  const start = filteredRows.length ? startIndex + 1 : 0;
  const end = Math.min(startIndex + pageRows.length, filteredRows.length);
  document.querySelector('#resultRange').textContent = `显示 ${start}–${end} / ${filteredRows.length}`;
  const pagination = document.querySelector('#pagination');
  pagination.innerHTML = `<button class="page-arrow" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''} aria-label="上一页">‹</button>${renderPagination(pageCount, currentPage)}<button class="page-arrow" data-page="${currentPage + 1}" ${currentPage === pageCount ? 'disabled' : ''} aria-label="下一页">›</button>`;
  pagination.querySelectorAll('button:not(:disabled)').forEach(button => button.addEventListener('click', () => {
    currentPage = Number(button.dataset.page);
    persistLeaderboardView();
    const cachedEntry = leaderboardData.get(selectedLadder);
    const loadedPages = Array.isArray(cachedEntry?.data?.loadedPages) ? cachedEntry.data.loadedPages : [];
    if (selectedCountry === 'all' && !loadedPages.includes(currentPage)) {
      body.innerHTML = '<tr><td colspan="8" class="loading"><span class="loader"></span>正在加载该分页…</td></tr>';
      loadLeaderboardPage(currentPage);
    } else {
      renderPage();
    }
    document.querySelector('.table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}
countryFilter.addEventListener('change', () => {
  selectedCountry = countryFilter.value;
  currentPage = 1;
  persistLeaderboardView();
  renderPage();
  loadLeaderboardSummary();
});
function setError(message) {
  body.innerHTML = `<tr><td colspan="8" class="error-state"><span class="error-icon">!</span><div><b>暂时无法获取天梯数据</b><small>${escapeHtml(message)}</small></div><button id="retryBtn">重试</button></td></tr>`;
  document.querySelector('#retryBtn')?.addEventListener('click', loadLeaderboard);
}
function renderLeaderboardSummary(summary) {
  document.querySelector('#statAverage').textContent = summary && Number.isFinite(Number(summary.averageRating)) ? fmt.format(Number(summary.averageRating)) : '-';
  document.querySelector('#statPlayers').textContent = summary ? `${fmt.format(Number(summary.countryPlayers || 0))}/${fmt.format(Number(summary.totalPlayers || 0))}` : '-';
  document.querySelector('#statTop100').textContent = summary ? fmt.format(Number(summary.top100Country || 0)) : '-';
}
async function loadLeaderboardSummary() {
  const key = `${selectedLadder}:${selectedCountry}`;
  const cached = leaderboardSummaryCache.get(key);
  if (cached) renderLeaderboardSummary(cached);
  else renderLeaderboardSummary(null);
  if (leaderboardSummaryRequests.has(key)) return leaderboardSummaryRequests.get(key);
  const request = fetch(`/api/leaderboard-summary?id=${encodeURIComponent(selectedLadder)}&country=${encodeURIComponent(selectedCountry)}`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(summary => { if (summary) { leaderboardSummaryCache.set(key, summary); if (key === `${selectedLadder}:${selectedCountry}`) renderLeaderboardSummary(summary); } })
    .catch(() => { if (!cached) renderLeaderboardSummary(null); })
    .finally(() => leaderboardSummaryRequests.delete(key));
  leaderboardSummaryRequests.set(key, request);
  return request;
}
function displayLeaderboard(data) {
  currentTotalRows = Number(data.total) || (Array.isArray(data.rows) ? data.rows.length : 0);
  renderRows(Array.isArray(data.rows) ? data.rows : []);
  document.querySelector('#boardType').textContent = data.label;
  loadLeaderboardSummary();
}
function leaderboardResponseExpiresAt(data, response) {
  // The HTTP Date and cache deadline use the server clock. Convert the interval
  // to the browser clock so a fast local clock cannot leave the timer at zero.
  const now = Date.now();
  const serverNow = Date.parse(response.headers.get('date') || '');
  const remaining = Number(data.cacheExpiresAt) - (Number.isFinite(serverNow) ? serverNow : now);
  return now + (Number.isFinite(remaining) && remaining > 0 ? remaining : 5_000);
}
async function loadLeaderboard(force = false) {
  const ladderId = selectedLadder;
  let cached = leaderboardData.get(ladderId);
  if (!cached) {
    const local = readLeaderboardLocalCache(ladderId);
    if (local) {
      cached = { data: local.data, expiresAt: local.expiresAt || Date.now() };
      leaderboardData.set(ladderId, cached);
    }
  }
  if (cached) {
    displayLeaderboard(cached.data);
    if (!force && cached.expiresAt > Date.now()) return;
  } else if (!currentRows.length) {
    body.innerHTML = '<tr><td colspan="8" class="loading"><span class="loader"></span>正在加载天梯数据…</td></tr>';
  }
  if (leaderboardRequests.has(ladderId)) return leaderboardRequests.get(ladderId);
  if (!force && (leaderboardRetryAt.get(ladderId) || 0) > Date.now()) return;
  const request = (async () => {
  let retries = 0;
  try {
    let data;
    let response;
    while (true) {
      try {
        response = await fetch(`/api/leaderboard?id=${ladderId}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        break;
      } catch (error) {
        if (retries >= 5) throw error;
        retries += 1;
        if (ladderId === selectedLadder) {
          if (!currentRows.length) body.innerHTML = `<tr><td colspan="8" class="loading"><span class="loader"></span>正在重试（${retries}/5）…</td></tr>`;
          else document.querySelector('#statAverage').textContent = `重试中（${retries}/5）`;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    const expiresAt = leaderboardResponseExpiresAt(data, response);
    leaderboardData.set(ladderId, { data, expiresAt });
    saveLeaderboardLocalCache(ladderId, data, expiresAt);
    leaderboardRetryAt.delete(ladderId);
    if (ladderId === selectedLadder) displayLeaderboard(data);
  } catch (error) {
    leaderboardRetryAt.set(ladderId, Date.now() + 60_000);
    if (ladderId === selectedLadder) {
      if (currentRows.length) document.querySelector('#statAverage').textContent = '更新失败';
      else setError(error.message || '请检查网络连接后重试');
    }
  }
  })();
  leaderboardRequests.set(ladderId, request);
  try { await request; } finally { leaderboardRequests.delete(ladderId); }
}
async function loadLeaderboardPage(page) {
  const ladderId = selectedLadder;
  const requestedPage = Math.max(1, Number(page) || 1);
  const key = `${ladderId}:${requestedPage}`;
  if (leaderboardPageRequests.has(key)) return leaderboardPageRequests.get(key);
  const request = (async () => {
    try {
      const response = await fetch(`/api/leaderboard?id=${encodeURIComponent(ladderId)}&page=${encodeURIComponent(requestedPage)}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const entry = leaderboardData.get(ladderId);
      if (!entry) return;
      const rows = new Map((entry.data.rows || []).map(row => [String(row.profileId), row]));
      for (const row of data.rows || []) rows.set(String(row.profileId), row);
      entry.data = { ...entry.data, ...data, rows: [...rows.values()].sort((a, b) => Number(a.rank) - Number(b.rank)), loadedPages: [...new Set([...(entry.data.loadedPages || []), ...(data.loadedPages || [requestedPage])])].sort((a, b) => a - b) };
      entry.expiresAt = leaderboardResponseExpiresAt(data, response);
      if (ladderId === selectedLadder) displayLeaderboard(entry.data);
    } catch (error) {
      if (ladderId === selectedLadder) {
        body.innerHTML = `<tr><td colspan="8" class="error-state"><span class="error-icon">!</span><div><b>该分页暂时无法获取</b><small>${escapeHtml(error.message || '请稍后重试')}</small></div></td></tr>`;
      }
    }
  })();
  leaderboardPageRequests.set(key, request);
  try { await request; } finally { leaderboardPageRequests.delete(key); }
  return request;
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
  persistLeaderboardView();
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
  if (!/^\/$/.test(location.pathname)) return;
  const cached = leaderboardData.get(selectedLadder);
  const updateAt = leaderboardRetryAt.get(selectedLadder) ?? cached?.expiresAt;
  const seconds = updateAt ? Math.max(0, Math.ceil((updateAt - Date.now()) / 1000)) : '—';
  document.querySelector('#countdown').textContent = leaderboardRequests.has(selectedLadder) ? '更新中' : seconds;
  if (seconds === 0 && !leaderboardRequests.has(selectedLadder)) loadLeaderboard();
}
if (/^\/$/.test(location.pathname)) loadLeaderboard();
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
let profileMatchesRequestId = 0;
let currentProfileId = '';
let currentProfileAvatarUrl = '';
const lastProfileIdStorageKey = 'aoe2de:last-profile-id:v1';
let currentProfileLeaderboardRows = [];
let currentProfileRecentResults = new Map();
let currentProfileRecentStats = new Map();
let currentProfileRecentModeCounts = null;
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
function profileLoadingMarkup() {
  return '<div class="profile-loading-animation" role="status" aria-label="少女加载中"><img src="/assets/ui/profile-loading-girl.png" alt=""><span>少女加载中</span></div>';
}
function setProfileLoadingAnimation(visible) {
  const loading = document.querySelector('#profileLoadingAnimation');
  if (loading) loading.hidden = !visible;
}
function profileSectionLoadingMarkup() {
  return '<div class="profile-section-loading" role="status" aria-label="正在加载"><span class="profile-section-spinner"></span></div>';
}
function profileTableLoadingMarkup(colspan) {
  return `<tr><td colspan="${colspan}">${profileSectionLoadingMarkup()}</td></tr>`;
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
function renderProfileExternalLinks(links, kind) {
  const entries = Object.entries(links || {}).flatMap(([platform, urls]) => (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(url => ({ platform, url })));
  if (!entries.length) return '';
  const icon = { twitch: 'twitch.svg', youtube_live: 'youtube.svg', bilibili: 'bilibili.svg', douyu: 'douyu.png', douyin: 'douyin.svg', kick: 'kick.svg', youtube: 'youtube.svg', twitter: 'twitter.svg', discord: 'discord.svg', facebook_gaming: 'facebook_gaming.svg', steam: 'steam.svg', liquipedia: 'liquipedia.png', liquipedia_net: 'liquipedia.png', trovo: 'trovo.svg', mixer: 'mixer.svg' };
  const fallbackLabel = { liquipedia: 'LQ', liquipedia_net: 'LQ', trovo: 'TV', mixer: 'MX' };
  const externalUrl = (platform, value) => {
    const raw = String(value || '').trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (platform === 'liquipedia' || platform === 'liquipedia_net') return `https://liquipedia.net/ageofempires/${encodeURIComponent(raw)}`;
    if (platform === 'steam' && /^\d{10,}$/.test(raw)) return `https://steamcommunity.com/profiles/${raw}`;
    return raw;
  };
  const label = kind === 'live' ? '直播' : '社交';
  return `<span class="profile-account-link-group" title="${label}链接"><span class="profile-account-link-kind">${label}</span>${entries.map(({ platform, url }) => `<a class="profile-account-link profile-account-link-${escapeHtml(platform)}" href="${escapeHtml(externalUrl(platform, url))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(platform)}"><span aria-hidden="true">${icon[platform] ? `<img src="/assets/icons/${escapeHtml(icon[platform])}" alt="">` : `<span class="profile-link-fallback">${escapeHtml(fallbackLabel[platform] || platform.slice(0, 2).toUpperCase())}</span>`}</span><span class="sr-only">${escapeHtml(platform)}</span></a>`).join('')}</span>`;
}
function renderProfileIdentityLinks(accounts, profileId) {
  const target = document.querySelector('#profileIdentityLinks');
  if (!target) return;
  const list = Array.isArray(accounts) ? accounts : [];
  const matched = list.find(account => String(account.id ?? '') === String(profileId) && account.rlReference) || list.find(account => account.rlReference);
  if (matched?.rlReference) renderProfileIdentityReference(matched.rlReference);
}
function renderProfileIdentityReference(reference) {
  const target = document.querySelector('#profileIdentityLinks');
  if (!target) return;
  target.innerHTML = reference ? `${renderProfileExternalLinks(reference.liveLinks, 'live')}${renderProfileExternalLinks(reference.socialLinks, 'social')}` : '';
}
function renderPlayerDetailsRows(details) {
  const accounts = Array.isArray(details.accounts) ? details.accounts : [];
  if (!accounts.length) return '<tr><td colspan="4">暂无账号数据</td></tr>';
  return accounts.map(account => {
    const aliases = Array.isArray(account.akas) ? account.akas.filter(alias => typeof alias === 'string' && alias.trim()).map(repairMojibake) : [];
    const accountName = account.name || '未命名账号';
    const accountId = String(account.id ?? '');
    const accountMarkup = /^\d+$/.test(accountId)
      ? `<a href="/profile/${encodeURIComponent(accountId)}">${escapeHtml(accountName)}</a>`
      : escapeHtml(accountName);
    const avatar = `<span class="profile-account-avatar" data-profile-id="${escapeHtml(accountId)}" title="${escapeHtml(accountName)} 的 Steam 头像"><span>${escapeHtml(accountName.slice(0, 1).toUpperCase() || '?')}</span></span>`;
    const last = Number(account.last);
    const lastText = formatTimeAgo(last) || '暂无数据';
    const lastTitle = last > 0 ? new Date(last * 1000).toLocaleString('zh-CN') : '接口未提供最后游戏时间';
    return `<tr><td class="profile-account-id">${escapeHtml(accountId || '—')}</td><td><div class="profile-account-name">${avatar}${accountMarkup}</div></td><td>${aliases.length ? aliases.map(escapeHtml).join('、') : '无'}</td><td class="profile-account-last" title="${escapeHtml(lastTitle)}">${escapeHtml(lastText)}</td></tr>`;
  }).join('');
}
function loadProfileAccountAvatars() {
  for (const avatar of document.querySelectorAll('.profile-account-avatar[data-profile-id]')) {
    const profileId = avatar.dataset.profileId;
    if (!profileId) continue;
    const directUrl = avatar.dataset.avatarUrl || '';
    if (directUrl) {
      const image = document.createElement('img');
      image.src = directUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.onerror = () => image.remove();
      avatar.replaceChildren(image);
      continue;
    }
    fetch(`/api/avatar?profileId=${encodeURIComponent(profileId)}`, { cache: 'force-cache' }).then(response => response.ok ? response.json() : null).then(data => {
      if (!avatar.isConnected || !data?.avatar) return;
      const image = document.createElement('img');
      image.src = data.avatar;
      image.alt = '';
      image.loading = 'lazy';
      image.onerror = () => image.remove();
      avatar.replaceChildren(image);
    }).catch(() => {});
  }
}
const aoe2RecsProfileCachePrefix = 'aoe2de:aoe2recs-profile:v2:';
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
    avatar: profile.avatar || '',
    player: profile.player || null,
    accounts: Array.isArray(profile.accounts) ? profile.accounts : [],
    live: profile.live || null,
    matches: Array.isArray(profile.matches) ? profile.matches : [],
    leaderboards: Array.isArray(profile.leaderboards) ? profile.leaderboards : []
  };
  try {
    localStorage.setItem(`${aoe2RecsProfileCachePrefix}${profileId}`, JSON.stringify({ savedAt: Date.now(), profile: cachedProfile }));
  } catch {
    // Quota or privacy settings may disable local storage; keep the live result usable.
  }
}
const profileMatchesLocalCachePrefix = 'aoe2de:profile-matches:v1:';
const profileMatchesLocalCacheTtl = 10 * 60 * 1000;
function readProfileMatchesLocalCache(profileId) {
  try {
    const cached = JSON.parse(localStorage.getItem(`${profileMatchesLocalCachePrefix}${profileId}`) || 'null');
    if (!Array.isArray(cached?.matches) || !Number.isFinite(cached.savedAt)) return null;
    return { matches: cached.matches, savedAt: cached.savedAt };
  } catch { return null; }
}
function saveProfileMatchesLocalCache(profileId, matches) {
  try { localStorage.setItem(`${profileMatchesLocalCachePrefix}${profileId}`, JSON.stringify({ savedAt: Date.now(), matches: Array.isArray(matches) ? matches.slice(0, 100) : [] })); } catch { /* Storage may be disabled or full. */ }
}
function formatProfileDate(timestamp) {
  const value = Number(timestamp);
  return value > 0 ? new Date(value * 1000).toLocaleString('zh-CN') : '暂无数据';
}
function aoe2AssetSlug(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function aoe2MapImageUrl(mapName) {
  let source = String(mapName || '').trim();
  const enumSource = source.replace(/^(?:rm|dm|ew|cm)[_-]/i, '');
  const normalizeMapKey = value => String(value || '')
    .replace(/[’']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '')
    .toLocaleLowerCase();
  const enumKey = normalizeMapKey(enumSource);
  const canonical = Object.keys(mapNamesZh || {}).find(name => normalizeMapKey(name) === enumKey);
  if (canonical) source = canonical;
  const slug = aoe2AssetSlug(source);
  return slug ? `/assets/game/map/${slug}.png` : '';
}
const mapNamesZh = {
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
};
function mapDisplayName(mapName) {
  const value = String(mapName || '').trim();
  if (!value) return '未知地图';
  const exact = mapNamesZh[value];
  if (exact) return exact;
  const matched = Object.keys(mapNamesZh).find(name => name.toLocaleLowerCase() === value.toLocaleLowerCase());
  if (matched) return mapNamesZh[matched];
  // WebSocket events commonly return enum values such as rm_arena or rm_golden-pit.
  const normalizeMapKey = text => String(text || '')
    .replace(/^(?:rm|dm|ew|cm)[_-]/i, '')
    .replace(/[’']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '')
    .toLocaleLowerCase();
  const normalized = normalizeMapKey(value);
  const enumMatched = Object.keys(mapNamesZh).find(name => normalizeMapKey(name) === normalized);
  return enumMatched ? mapNamesZh[enumMatched] : value;
}
function mapNameColorClass(mapName) {
  const name = String(mapName || '');
  let hash = 0;
  for (const character of name) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  if (/沙漠|非洲|desert|africa|arabia|arabian/i.test(name)) return `map-name-color-${[8, 9, 10][Math.abs(hash) % 3]}`;
  return `map-name-color-${Math.abs(hash) % 8}`;
}
function aoe2CivilizationImageUrl(civilization) {
  const value = String(civilization || '').trim().toLocaleLowerCase();
  const canonical = { inca: 'incas', incas: 'incas', maya: 'mayans', mayans: 'mayans' }[value] || value;
  const slug = aoe2AssetSlug(canonical);
  return slug ? `/assets/game/civilization/${slug}.png` : '';
}
const civilizationNamesZh = {
  Armenians: '亚美尼亚', Aztecs: '阿兹特克', Bengalis: '孟加拉', Berbers: '柏柏尔', Bohemians: '波希米亚', Britons: '不列颠', Bulgarians: '保加利亚', Burgundians: '勃艮第', Burmese: '缅甸', Byzantines: '拜占庭', Celts: '凯尔特', Chinese: '中国', Cumans: '库曼', Danes: '丹麦', Dravidians: '达罗毗荼', Ethiopians: '埃塞俄比亚', Franks: '法兰克', Georgians: '格鲁吉亚', Goths: '哥特', Gurjaras: '瞿折罗', Hindustanis: '印度斯坦', Huns: '匈奴', Incas: '印加', inca: '印加', Italians: '意大利', Japanese: '日本', Jurchens: '女真', Khitans: '契丹', Khmer: '高棉', Koreans: '高丽', Lithuanians: '立陶宛', Magyars: '马扎尔', Malay: '马来', Malays: '马来', Malians: '马里', Mapuche: '马普切', Maya: '玛雅', maya: '玛雅', Mayans: '玛雅', mayans: '玛雅', Mongols: '蒙古', Muisca: '穆伊斯卡', Persians: '波斯', Poles: '波兰', Portuguese: '葡萄牙', Romans: '罗马', Saracens: '撒拉逊', Saxons: '撒克逊', Shu: '蜀', Sicilians: '西西里', Slavs: '斯拉夫', Spanish: '西班牙', Tatars: '鞑靼', Teutons: '条顿', Turks: '土耳其', Tupi: '图皮', Varangians: '瓦兰吉', Vietnamese: '越南', Vikings: '维京', Wei: '魏', Wu: '吴'
};
function civilizationNameZh(civilization) {
  const value = String(civilization || '').trim();
  const stripped = value.replace(/\s+\(.*\)$/, '');
  const exact = civilizationNamesZh[stripped];
  if (exact) return exact;
  const matched = Object.keys(civilizationNamesZh).find(name => name.toLocaleLowerCase() === stripped.toLocaleLowerCase());
  return (matched && civilizationNamesZh[matched]) || value || '未知民族';
}
function profileMatchTypeLabel(match) {
  const leaderboard = profileMatchLeaderboard(match);
  if (!leaderboard) return `大厅局 ${String(match?.lobby || '未知大厅').trim()}`;
  if (leaderboard === 'RM TG') return '团队随机地图';
  if (leaderboard === 'RM 1v1') return '随机地图1v1';
  return leaderboard;
}
function profileMatchTypeKey(match) {
  const leaderboard = profileMatchLeaderboard(match);
  if (leaderboard) return leaderboard;
  return `${String(match?.type || '').trim()}|${String(match?.diplomacy || '').trim()}`;
}
function profileMatchLeaderboard(match) {
  const raw = String(match?.leaderboard || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (raw === 'DM_1V1') return 'DM 1v1';
  if (raw === 'DM_TG' || raw === 'DM_TEAM') return 'DM TG';
  if (raw === 'RM_1V1') return 'RM 1v1';
  if (raw === 'RM_TG' || raw === 'RM_TEAM') return 'RM TG';
  if (raw === 'EW_1V1') return 'EW 1v1';
  if (raw === 'EW_TG' || raw === 'EW_TEAM') return 'EW TG';
  if (/DEATHMATCH|^DM$/.test(String(match?.type || '').toUpperCase())) {
    return /1V1|1\s*V\s*1/.test(String(match?.diplomacy || '').toUpperCase()) ? 'DM 1v1' : 'DM TG';
  }
  return String(match?.leaderboard || '').trim();
}
function profileMatchRatingDeltas(matches) {
  const deltas = new Map();
  const previous = new Map();
  const chronological = [...matches].sort((a, b) => Number(a.started || a.lobby_created || 0) - Number(b.started || b.lobby_created || 0));
  for (const match of chronological) {
    if (!profileMatchLeaderboard(match) && String(match?.lobby || '').trim()) continue;
    const typeKey = profileMatchTypeKey(match);
    for (const player of Array.isArray(match.players) ? match.players : []) {
      const direct = Number(player.ratingDelta);
      if (Number.isFinite(direct)) deltas.set(`${match.id}:${player.id}`, direct);
      const rating = Number(player.rating);
      if (!Number.isFinite(rating)) continue;
      const playerKey = `${typeKey}|${player.id}`;
      const prior = previous.get(playerKey);
      if (Number.isFinite(prior) && !deltas.has(`${match.id}:${player.id}`)) deltas.set(`${match.id}:${player.id}`, rating - prior);
      previous.set(playerKey, rating);
    }
  }
  return deltas;
}
function fullSteamAvatarUrl(url) {
  return typeof url === 'string' ? url.replace(/_medium(?=\.[a-z]+(?:\?.*)?$)/i, '_full') : '';
}
function applyProfileOverviewAvatar(url, requestId = profileDetailsRequestId) {
  const source = fullSteamAvatarUrl(url);
  const avatar = document.querySelector('#profileOverviewAvatar');
  if (!source || !avatar) return false;
  const image = document.createElement('img');
  image.alt = '';
  image.decoding = 'async';
  image.onload = () => {
    if (requestId === profileDetailsRequestId && avatar.isConnected) avatar.replaceChildren(image);
  };
  image.src = source;
  return true;
}
const profileModeDefinitions = [
  { id: 3, match: 'RM 1v1', label: '1v1 随机地图', color: '#9fbd72' },
  { id: 4, match: 'RM TG', label: '团队随机地图', color: '#6fa6ba' },
  { id: 1, match: 'DM 1v1', label: '1v1 死亡竞赛', color: '#d7a65e' },
  { id: 2, match: 'DM TG', label: '团队死亡竞赛', color: '#a27bc2' },
  { id: 13, match: 'EW 1v1', label: '1v1 帝国战争', color: '#d47b68' },
  { id: 14, match: 'EW TG', label: '团队帝国战争', color: '#70b6a8' },
  { id: 'other', match: '', label: '其他 / 大厅', color: '#737c78' }
];
function profileAllModeCounts(leaderboards) {
  const counts = new Map();
  for (const row of Array.isArray(leaderboards) ? leaderboards : []) {
    const games = Math.max(0, Number(row.wins) || 0) + Math.max(0, Number(row.losses) || 0);
    if (games > 0) counts.set(Number(row.id), games);
  }
  return counts;
}
function profileRecentModeCounts(matches, playerId) {
  const modeByMatch = new Map(profileModeDefinitions.filter(mode => mode.match).map(mode => [mode.match, mode.id]));
  const counts = new Map();
  for (const match of (Array.isArray(matches) ? matches : []).slice(0, 100)) {
    const belongsToPlayer = (Array.isArray(match.players) ? match.players : []).some(player => String(player.id) === String(playerId));
    if (!belongsToPlayer) continue;
    const id = modeByMatch.get(profileMatchLeaderboard(match)) ?? 'other';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}
function profileModeChartMarkup(counts, loading = false) {
  if (loading) return '<div class="profile-section-loading" role="status" aria-label="正在加载"><span class="profile-section-spinner"></span></div>';
  const entries = profileModeDefinitions.map(mode => ({ ...mode, count: Number(counts?.get(mode.id) || 0) })).filter(mode => mode.count > 0);
  const total = entries.reduce((sum, mode) => sum + mode.count, 0);
  if (!total) return '<div class="profile-mode-chart-empty">暂无可统计的对局数据</div>';
  const point = (angle, radius) => {
    const radians = (angle - 90) * Math.PI / 180;
    return { x: 60 + radius * Math.cos(radians), y: 60 + radius * Math.sin(radians) };
  };
  let cursor = 0;
  const slices = entries.map(mode => {
    const percent = mode.count / total * 100;
    const startAngle = cursor / total * 360;
    cursor += mode.count;
    const endAngle = cursor / total * 360;
    const start = point(startAngle, 56);
    const end = point(endAngle, 56);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    const shape = entries.length === 1
      ? '<circle cx="60" cy="60" r="56"></circle>'
      : `<path d="M 60 60 L ${start.x.toFixed(3)} ${start.y.toFixed(3)} A 56 56 0 ${largeArc} 1 ${end.x.toFixed(3)} ${end.y.toFixed(3)} Z"></path>`;
    const labelPoint = point((startAngle + endAngle) / 2, 36);
    const label = percent >= 3
      ? `<text x="${labelPoint.x.toFixed(2)}" y="${labelPoint.y.toFixed(2)}">${percent.toFixed(percent >= 10 ? 0 : 1)}%</text>`
      : '';
    return `<g fill="${mode.color}"><title>${escapeHtml(mode.label)}：${percent.toFixed(2)}%</title>${shape}</g>${label}`;
  }).join('');
  const summary = entries.map(mode => `${mode.label} ${(mode.count / total * 100).toFixed(2)}%`).join('，');
  return `<svg class="profile-mode-pie" viewBox="0 0 120 120" role="img" aria-label="${escapeHtml(summary)}">${slices}</svg>`;
}
function renderProfileModeCharts() {
  const allTarget = document.querySelector('#profileAllModeChart');
  const recentTarget = document.querySelector('#profileRecentModeChart');
  const legendTarget = document.querySelector('#profileModeLegend');
  if (allTarget) allTarget.innerHTML = profileModeChartMarkup(currentProfileLeaderboardRows.length ? profileAllModeCounts(currentProfileLeaderboardRows) : null, !currentProfileLeaderboardRows.length);
  if (recentTarget) recentTarget.innerHTML = profileModeChartMarkup(currentProfileRecentModeCounts, currentProfileRecentModeCounts === null);
  if (legendTarget && !legendTarget.childElementCount) legendTarget.innerHTML = profileModeDefinitions.map(mode => `<li><i style="--mode-color:${mode.color}"></i><span>${escapeHtml(mode.label)}</span></li>`).join('');
}
function renderProfileLeaderboards(leaderboards, recentResults = currentProfileRecentResults, recentStats = currentProfileRecentStats) {
  const rows = Array.isArray(leaderboards) ? leaderboards : [];
  currentProfileLeaderboardRows = rows;
  renderProfileModeCharts();
  const body = document.querySelector('#profileLeaderboardBody');
  const toggle = document.querySelector('#profileLeaderboardToggle');
  if (!body) return;
  const inactiveCount = rows.filter(row => row.hasData === false || row.active === false).length;
  const ladderPriority = new Map([[3, 0], [4, 1], [13, 2], [14, 3], [1, 4], [2, 5]]);
  const orderedRows = [...rows].sort((a, b) =>
    (ladderPriority.get(Number(a.id)) ?? 99) - (ladderPriority.get(Number(b.id)) ?? 99)
  );
  body.innerHTML = orderedRows.map(row => {
    const hasData = row.hasData !== false;
    const active = hasData && row.active !== false;
    const games = Number.isFinite(Number(row.wins)) && Number.isFinite(Number(row.losses)) ? Number(row.wins) + Number(row.losses) : null;
    const winrate = games !== null && games > 0 && Number.isFinite(Number(row.wins)) ? `${(Number(row.wins) / games * 100).toFixed(1)}%` : '—';
    const ratingPair = row.rating != null || row.highestRating != null ? `${row.rating != null ? fmt.format(row.rating) : '—'} / ${row.highestRating != null ? fmt.format(row.highestRating) : '—'}` : '—';
    const recent = Array.isArray(recentResults?.get?.(Number(row.id))) ? recentResults.get(Number(row.id)).slice().reverse() : [];
    const favorite = recentStats?.get?.(Number(row.id)) || {};
    const recentMarkup = Array.from({ length: 5 }, (_, index) => {
      const result = recent[index];
      return `<span class="profile-recent-result ${result === true ? 'win' : result === false ? 'loss' : 'unknown'}" title="${result === true ? '胜利' : result === false ? '失败' : '暂无记录'}">${result === true ? '✓' : result === false ? '×' : '·'}</span>`;
    }).join('');
    const rankLabel = active ? '世界排名' : hasData ? '不活跃' : '未参与此模式';
    const rankValue = active ? '#' + fmt.format(row.rank) : hasData ? '无排名' : '—';
    const favoriteCiv = favorite.civilization ? `${favorite.civilization} · ${favorite.civilizationCount} 场` : '—';
    const favoriteMap = favorite.map ? `${favorite.map} · ${favorite.mapCount} 场` : '—';
    const favoriteOpponentRecord = favorite.opponent ? `${favorite.opponentWins}场/${favorite.opponentTotal}场` : '—';
    const favoriteOpponentId = favorite.opponentId && /^\d+$/.test(String(favorite.opponentId)) ? String(favorite.opponentId) : '';
    const favoriteOpponentAvatar = favoriteOpponentId ? `<span class="profile-ladder-opponent-avatar" data-profile-avatar-id="${escapeHtml(favoriteOpponentId)}"><span>${escapeHtml((favorite.opponent || '?').slice(0, 1).toUpperCase())}</span></span>` : '';
    const favoriteOpponentLink = favorite.opponent && favoriteOpponentId ? `<a class="profile-ladder-opponent-link" href="/profile/${encodeURIComponent(favoriteOpponentId)}" title="查看 ${escapeHtml(favorite.opponent)} 的资料">${favoriteOpponentAvatar}<span class="profile-ladder-opponent-name">${escapeHtml(favorite.opponent)}</span></a>` : escapeHtml(favorite.opponent || '—');
    const favoriteCivIcon = favorite.civilizationIcon ? `<img class="profile-ladder-civ-icon" src="${escapeHtml(favorite.civilizationIcon)}" alt="" loading="lazy" onerror="this.hidden=true">` : '';
    const lastGame = formatTimeAgo(row.lastMatchDate) || '—';
    const lastGameTitle = Number(row.lastMatchDate) > 0 ? new Date(Number(row.lastMatchDate) * 1000).toLocaleString('zh-CN') : '接口未提供最后游戏时间';
    return `<article class="profile-ladder-card${active ? '' : ' profile-inactive-row'}"${active ? '' : ' hidden'}><div class="profile-ladder-card-head"><strong>${escapeHtml(row.label || '未知模式')}</strong><span>${games !== null ? `${fmt.format(games)} 场` : '—'}</span><span class="profile-ladder-last-game" title="${escapeHtml(lastGameTitle)}">最后游戏时间 ${escapeHtml(lastGame)}</span></div><div class="profile-ladder-card-body"><div class="profile-ladder-card-main"><div class="profile-ladder-rank"><small>${rankLabel}</small><b>${rankValue}</b></div><div class="profile-ladder-stat profile-ladder-rating"><span>当前积分/历史最高</span><b>${ratingPair}</b></div><div class="profile-ladder-stat profile-ladder-record"><span>胜率</span><b>${winrate}</b></div></div><div class="profile-ladder-favorites"><div class="profile-ladder-stat profile-ladder-favorite-civ"><span>近期最多民族</span><b title="${escapeHtml(favorite.civilization || '暂无数据')}">${favoriteCivIcon}${escapeHtml(favoriteCiv)}</b></div><div class="profile-ladder-stat profile-ladder-favorite-map"><span>近期最多地图</span><b title="${escapeHtml(favorite.map || '暂无数据')}">${escapeHtml(favoriteMap)}</b></div><div class="profile-ladder-stat profile-ladder-favorite-opponent"><span>近期最强对手</span><b title="${escapeHtml(favorite.opponent || '暂无数据')}">${favoriteOpponentLink}</b><small class="profile-ladder-opponent-record">${escapeHtml(favoriteOpponentRecord)}</small></div></div></div><div class="profile-ladder-card-foot"><span class="profile-recent-results-label">最近 5 场</span><span class="profile-recent-results">${recentMarkup}</span></div></article>`;
  }).join('') || '<div class="profile-leaderboard-empty">暂无天梯汇总数据</div>';
  body.querySelectorAll('.profile-ladder-opponent-avatar[data-profile-avatar-id]').forEach(avatar => {
    const profileId = avatar.dataset.profileAvatarId;
    fetch(`/api/avatar?profileId=${encodeURIComponent(profileId)}`, { cache: 'force-cache' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (!avatar.isConnected || !data?.avatar) return;
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.onload = () => {
          if (avatar.isConnected) avatar.replaceChildren(image);
        };
        image.src = fullSteamAvatarUrl(data.avatar);
      }).catch(() => {});
  });
  if (toggle) {
    toggle.hidden = inactiveCount === 0;
    toggle.textContent = '显示不活跃模式';
    toggle.onclick = () => {
      const hidden = body.querySelector('.profile-inactive-row')?.hidden;
      body.querySelectorAll('.profile-inactive-row').forEach(row => { row.hidden = !hidden; });
      toggle.textContent = hidden ? '隐藏不活跃模式' : '显示不活跃模式';
    };
  }
}
function loadProfileLeaderboards(profileId) {
  const initialBody = document.querySelector('#profileLeaderboardBody');
  if (initialBody) initialBody.innerHTML = profileSectionLoadingMarkup();
  fetch(`/api/profile-leaderboards?id=${encodeURIComponent(profileId)}`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(data => { if (data?.leaderboards) renderProfileLeaderboards(data.leaderboards); })
    .catch(() => {});
}
function renderProfileMatches(profile, matchesOverride = null, visibleCount = 100) {
  const body = document.querySelector('#profileMatchesBody');
  if (!body) return;
  const playerId = String(profile.player?.id || '');
  const matches = Array.isArray(matchesOverride) ? matchesOverride : (Array.isArray(profile.matches) ? profile.matches : []);
  if (!matches.length) {
    body.innerHTML = '<div class="profile-matches-empty">暂无对局记录</div>';
    return;
  }
  const isLiveMatch = match => {
    const started = Number(match?.started) || 0;
    const age = Math.floor(Date.now() / 1000) - started;
    const plausibleAge = started > 0 && started <= Math.floor(Date.now() / 1000) + 300 && age <= 3 * 60 * 60;
    return plausibleAge && (match?.live === true || (match?.live !== false && !Number(match?.finished) && match?.abandoned !== true));
  };
  // LIVE can only belong to the newest match. Searching the full history lets
  // an old unfinished cache record override a newer completed match.
  const liveMatch = matches.length && isLiveMatch(matches[0]) ? matches[0] : null;
  const historyMatches = matches.filter(match => match !== liveMatch);
  const ratingDeltas = profileMatchRatingDeltas(matches);
  const visibleMatches = (liveMatch ? [liveMatch] : []).concat(historyMatches.slice(0, visibleCount));
  body.innerHTML = visibleMatches.map(match => {
    const live = match === liveMatch;
    const players = Array.isArray(match.players) ? match.players : [];
    const self = players.find(player => String(player.id) === playerId);
    const teams = Array.isArray(match.teams) ? match.teams : [];
    const selfTeam = self && teams.find(team => Array.isArray(team.members) && team.members.some(member => String(member) === String(self.number)));
    const hasTeamWinner = teams.some(team => team.winner === true) || players.some(player => player.winner === true || player.won === true);
    const selfTeamWon = selfTeam?.winner === true || self?.winner === true || self?.won === true;
    const won = selfTeamWon;
    const lost = self?.winner === false || self?.won === false || (hasTeamWinner && selfTeam && !selfTeamWon);
    const isLobbyMatch = !String(match.leaderboard || '').trim();
    const isAbandoned = match.abandoned === true;
    const result = live ? '' : isAbandoned ? '非正常对局' : won ? '胜利' : lost ? '失败' : '—';
    const duration = Number(match.duration);
    const durationText = live ? '进行中' : Number.isFinite(duration) && duration > 0 ? `${Math.floor(duration / 60)}分${Math.floor(duration % 60)}秒` : '—';
    const started = Number(match.started || match.lobby_created) || 0;
    const matchAgo = formatTimeAgo(started) || '暂无时间';
    const playerByNumber = new Map(players.map(player => [String(player.number), player]));
    const orderedTeams = selfTeam ? [selfTeam, ...teams.filter(team => team !== selfTeam)] : teams;
    const isOneVsOne = String(match.diplomacy || '').toLowerCase() === '1v1' || (players.length === 2 && teams.length === 2 && teams.every(team => Array.isArray(team.members) && team.members.length <= 1));
    const renderMatchPlayer = (player, teamWon = false, side = '') => {
      const isSelf = String(player.id) === playerId;
      const color = typeof player.color_hex === 'string' && /^#[0-9a-f]{6}$/i.test(player.color_hex) ? player.color_hex : '#84928a';
      const playerWon = !live && (player.winner === true || (hasTeamWinner && teamWon));
      const civilization = player.civilization || '未知文明';
      const civilizationZh = civilizationNameZh(civilization);
      const civImage = aoe2CivilizationImageUrl(civilization);
      const civMarkup = civImage ? `<img class="profile-match-civ-icon" src="${civImage}" alt="" loading="lazy" onerror="this.hidden=true">` : '';
      const playerClass = `profile-match-player${isSelf ? ' is-self' : ''}${playerWon ? ' is-winner' : ''}${side ? ` is-${side}` : ''}`;
      const ratingMarkup = `<b>${player.rating != null ? fmt.format(player.rating) : '—'}</b>`;
      const directRatingDelta = Number(player.ratingDelta);
      const ratingDelta = live || isLobbyMatch || isAbandoned ? null : Number.isFinite(directRatingDelta)
        ? directRatingDelta
        : ratingDeltas.get(`${match.id}:${player.id}`);
      const ratingDeltaMarkup = Number.isFinite(ratingDelta) && ratingDelta !== 0 ? `<span class="profile-match-rating-delta ${ratingDelta > 0 ? 'positive' : 'negative'}">${ratingDelta > 0 ? '+' : ''}${fmt.format(ratingDelta)}</span>` : '';
      const crownMarkup = playerWon ? '<span class="profile-match-crown" title="胜者">♛</span>' : '';
      const playerName = escapeHtml(player.name || '未知玩家');
      const playerLink = /^\d+$/.test(String(player.id || '')) ? `<a class="profile-match-player-name-link" title="${playerName}" href="/profile/${encodeURIComponent(String(player.id))}">${playerName}</a>` : playerName;
      const nameMarkup = `<div class="profile-match-player-name">${side === 'left' ? ratingDeltaMarkup : ''}<strong title="${playerName}">${playerLink}</strong>${side !== 'left' ? ratingDeltaMarkup : ''}</div>`;
      const mainMarkup = `<div class="profile-match-player-main">${nameMarkup}<span class="profile-match-civ"><span>${escapeHtml(civilizationZh)}</span>${civMarkup}</span></div>`;
      const colorMarkup = `<span class="profile-match-color" style="background:${color}"></span>`;
      return side === 'left' ? `<div class="${playerClass}">${ratingMarkup}${crownMarkup}${mainMarkup}${colorMarkup}</div>` : `<div class="${playerClass}">${colorMarkup}${mainMarkup}${crownMarkup}${ratingMarkup}</div>`;
    };
    const teamMarkup = orderedTeams.map((team, teamIndex) => {
      const teamPlayers = (Array.isArray(team.members) ? team.members : []).map(member => playerByNumber.get(String(member))).filter(Boolean);
      const teamWon = team.winner === true || teamPlayers.some(player => player.winner === true || player.won === true);
      const side = teams.length > 2 ? 'right' : (teamIndex === 0 ? 'left' : 'right');
      const playersMarkup = teamPlayers.map(player => renderMatchPlayer(player, teamWon, side)).join('') || '<div class="profile-match-player-empty">队伍信息不可用</div>';
      return `<div class="profile-match-team${teamWon ? ' is-winner' : ''}${teamIndex === 0 ? ' is-own-team' : ''}">${playersMarkup}</div>`;
    }).join('<div class="profile-match-vs">VS</div>');
    const matchupMarkup = isOneVsOne && players.length >= 2
      ? `${renderMatchPlayer(players[0], teams.find(team => team.members?.some(member => String(member) === String(players[0].number)))?.winner === true, 'left')}<div class="profile-match-vs">VS</div>${renderMatchPlayer(players[1], teams.find(team => team.members?.some(member => String(member) === String(players[1].number)))?.winner === true, 'right')}`
      : teamMarkup;
    const resultClass = isAbandoned ? 'is-abandoned' : won ? 'is-win' : lost ? 'is-loss' : 'is-unknown';
    const rawMapName = match.rms || '未知地图';
    const mapName = mapDisplayName(rawMapName);
    const mapImage = aoe2MapImageUrl(rawMapName);
    const mapIcon = `<span class="profile-match-map-fallback">?</span>${mapImage ? `<img src="${mapImage}" alt="" loading="lazy" onerror="this.hidden=true">` : ''}`;
    const liveBadge = live ? `<a class="profile-match-live-badge" href="aoe2de://1/${encodeURIComponent(String(match.id))}" title="点击在 AoE2 DE 中观战">LIVE-&gt;点击游戏内观战</a>` : `<span class="profile-match-result">${escapeHtml(result)}</span>`;
    const replayButton = live ? '' : `<select class="profile-match-replay-download" aria-label="选择录像视角" data-match-id="${escapeHtml(match.id ?? '')}"><option value="">下载录像</option>${players.map(player => `<option value="${escapeHtml(player.id ?? '')}">${escapeHtml(player.name || `玩家 ${player.id}`)}</option>`).join('')}</select>`;
    const teamLayoutClass = `${teams.length > 2 ? ' many-teams' : ''}${teams.length >= 2 && teams.some(team => Array.isArray(team.members) && team.members.length > 1) ? ' team-game' : ''}`;
    return `<article class="profile-match-card ${live ? 'is-live' : resultClass}"><div class="profile-match-heading"><span class="profile-match-leaderboard" title="${escapeHtml(profileMatchTypeLabel(match))}">${escapeHtml(profileMatchTypeLabel(match))}</span>${liveBadge}</div><div class="profile-match-content"><div class="profile-match-info"><div class="profile-match-map-column"><div class="profile-match-map-icon">${mapIcon}</div>${replayButton}</div><div class="profile-match-map-copy"><strong class="${mapNameColorClass(rawMapName)}" title="${escapeHtml(mapName)}">${escapeHtml(mapName)}</strong><span>◷ ${escapeHtml(durationText)}</span><span>${escapeHtml(matchAgo)}</span><small>#${escapeHtml(match.id ?? '—')}</small></div></div><div class="profile-match-teams${teamLayoutClass}">${matchupMarkup}</div></div></article>`;
  }).join('');
  body.querySelectorAll('.profile-match-replay-download').forEach(picker => {
    picker.addEventListener('change', () => {
      const selectedProfileId = picker.value;
      const matchId = picker.dataset.matchId;
      if (!selectedProfileId || !matchId) return;
      window.location.href = `/api/match-replay?matchId=${encodeURIComponent(matchId)}&profileId=${encodeURIComponent(selectedProfileId)}`;
      picker.selectedIndex = 0;
    });
  });
}
function renderProfileLastMatchFromMatch(match) {
  const target = document.querySelector('#profileIdentityLastMatch');
  if (!target) return;
  const started = Number(match?.started) || 0;
  const age = Math.floor(Date.now() / 1000) - started;
  const plausibleAge = started > 0 && started <= Math.floor(Date.now() / 1000) + 300 && age <= 3 * 60 * 60;
  const live = plausibleAge && (match?.live === true || (match?.live !== false && !Number(match?.finished) && match?.abandoned !== true));
  if (live) {
    target.innerHTML = '<span class="profile-live-dot" aria-hidden="true"></span><span class="profile-live-label">游戏中</span>';
    target.title = started > 0 ? `开始于 ${new Date(started * 1000).toLocaleString('zh-CN')}` : '正在进行的对局';
    return;
  }
  const duration = Number(match?.duration);
  const finished = started > 0 ? started + (Number.isFinite(duration) && duration > 0 ? duration : 0) : 0;
  target.textContent = `最后游戏时间：${formatTimeAgo(finished || started) || '暂无数据'}`;
  target.title = finished > 0 ? new Date(finished * 1000).toLocaleString('zh-CN') : '接口未提供最后游戏时间';
}
function profileRecentResultsByLeaderboard(matches, playerId) {
  const results = new Map();
  const leaderboardId = match => ({ 'RM 1v1': 3, 'RM TG': 4, 'EW 1v1': 13, 'EW TG': 14 }[String(match?.leaderboard || '').trim()] || null);
  const ordered = [...(Array.isArray(matches) ? matches : [])].sort((a, b) => Number(b.started || b.lobby_created || 0) - Number(a.started || a.lobby_created || 0));
  for (const match of ordered) {
    const id = leaderboardId(match);
    if (!id || match?.live === true || (!Number(match?.finished) && match?.abandoned !== true)) continue;
    const players = Array.isArray(match.players) ? match.players : [];
    const self = players.find(player => String(player.id) === String(playerId));
    if (!self) continue;
    const teams = Array.isArray(match.teams) ? match.teams : [];
    const selfTeam = teams.find(team => Array.isArray(team.members) && team.members.some(member => String(member) === String(self.number)));
    const teamWon = selfTeam?.winner === true;
    const won = self.winner === true || self.won === true || teamWon;
    const lost = self.winner === false || self.won === false || (selfTeam && selfTeam.winner === false);
    if (!won && !lost) continue;
    const values = results.get(id) || [];
    if (values.length < 5) values.push(won);
    results.set(id, values);
  }
  return results;
}
function profileRecentStatsByLeaderboard(matches, playerId) {
  const stats = new Map();
  const leaderboardId = match => ({ 'RM 1v1': 3, 'RM TG': 4, 'EW 1v1': 13, 'EW TG': 14 }[String(match?.leaderboard || '').trim()] || null);
  const counts = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const id = leaderboardId(match);
    if (!id || match?.live === true || (!Number(match?.finished) && match?.abandoned !== true)) continue;
    const self = (Array.isArray(match.players) ? match.players : []).find(player => String(player.id) === String(playerId));
    if (!self) continue;
    const entry = counts.get(id) || { civilizations: new Map(), civilizationIcons: new Map(), maps: new Map(), opponents: new Map() };
    const civilization = civilizationNameZh(self.civilization || '');
    const map = mapDisplayName(match.rms || '');
    if (civilization && civilization !== '未知民族') {
      entry.civilizations.set(civilization, (entry.civilizations.get(civilization) || 0) + 1);
      const civImage = aoe2CivilizationImageUrl(self.civilization || '');
      if (civImage) entry.civilizationIcons.set(civilization, civImage);
    }
    if (map && map !== '未知地图') entry.maps.set(map, (entry.maps.get(map) || 0) + 1);
    const selfTeam = (Array.isArray(match.teams) ? match.teams : []).find(team => Array.isArray(team.members) && team.members.some(member => String(member) === String(self.number)));
    const selfWon = self.winner === true || self.won === true || selfTeam?.winner === true;
    const selfLost = self.winner === false || self.won === false || (selfTeam && selfTeam.winner === false);
    if (selfWon || selfLost) {
      const selfMembers = new Set(Array.isArray(selfTeam?.members) ? selfTeam.members.map(String) : [String(self.number)]);
      for (const opponent of (Array.isArray(match.players) ? match.players : []).filter(player => !selfMembers.has(String(player.number)))) {
        const name = String(opponent.name || '').trim();
        if (name) {
          const prior = entry.opponents.get(name) || { id: String(opponent.id || ''), total: 0, wins: 0, losses: 0 };
          prior.total += 1;
          if (selfWon) prior.wins += 1;
          if (selfLost) prior.losses += 1;
          entry.opponents.set(name, prior);
        }
      }
    }
    counts.set(id, entry);
  }
  for (const [id, entry] of counts) {
    const mostFrequent = values => [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))[0] || ['', 0];
    const civilization = mostFrequent(entry.civilizations);
    const map = mostFrequent(entry.maps);
    const opponent = [...entry.opponents.entries()].sort((a, b) => b[1].losses - a[1].losses || b[1].total - a[1].total || a[0].localeCompare(b[0], 'zh-CN'))[0] || ['', { total: 0, wins: 0, losses: 0 }];
    stats.set(id, { civilization: civilization[0], civilizationCount: civilization[1], civilizationIcon: entry.civilizationIcons.get(civilization[0]) || '', map: map[0], mapCount: map[1], opponent: opponent[0], opponentId: opponent[1].id || '', opponentWins: opponent[1].wins, opponentTotal: opponent[1].total });
  }
  return stats;
}
async function loadWorldsEdgeMatches(profileId, profile, requestId = profileDetailsRequestId) {
  const more = document.querySelector('#profileMatchesMore');
  const isCurrent = () => requestId === profileDetailsRequestId && location.pathname === `/profile/${encodeURIComponent(String(profileId))}`;
  // Match history is sourced exclusively from AoE2 Companion. AoE2Recs profile
  // payloads may contain a partial history without per-player ratingDiff.
  let matches = [];
  let hasMore = false;
  let visibleCount = 20;
  let loading = false;
  const localMatches = readProfileMatchesLocalCache(profileId);
  const localFresh = Boolean(localMatches && Date.now() - localMatches.savedAt < profileMatchesLocalCacheTtl);
  const applyMatches = () => {
    currentProfileRecentResults = profileRecentResultsByLeaderboard(matches, profileId);
    currentProfileRecentStats = profileRecentStatsByLeaderboard(matches, profileId);
    currentProfileRecentModeCounts = profileRecentModeCounts(matches, profileId);
    renderProfileModeCharts();
    if (currentProfileLeaderboardRows.length) renderProfileLeaderboards(currentProfileLeaderboardRows, currentProfileRecentResults, currentProfileRecentStats);
    renderProfileLastMatchFromMatch(matches[0]);
  };
  if (localMatches) {
    matches = localMatches.matches;
    applyMatches();
  }
  const render = () => {
    if (!isCurrent()) return;
    renderProfileMatches(profile, matches, visibleCount);
    if (more) {
      more.hidden = visibleCount >= matches.length && !hasMore;
      more.disabled = loading;
      more.textContent = loading ? '加载中…' : '显示更多';
    }
  };
  const fetchPage = async (offset, limit = 100, progressive = false) => {
    const suffix = progressive ? '&progressive=1' : '';
    const response = await fetch(`/api/profile-matches?id=${encodeURIComponent(profileId)}&offset=${offset}&limit=${limit}${suffix}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('近期对局请求失败');
    return response.json();
  };
  if (!localFresh) try {
    const first = await fetchPage(0, 100, true);
    if (!isCurrent()) return;
    matches = Array.isArray(first.matches) ? first.matches : [];
    currentProfileRecentResults = profileRecentResultsByLeaderboard(matches, profileId);
    currentProfileRecentStats = profileRecentStatsByLeaderboard(matches, profileId);
    currentProfileRecentModeCounts = profileRecentModeCounts(matches, profileId);
    renderProfileModeCharts();
    if (currentProfileLeaderboardRows.length) renderProfileLeaderboards(currentProfileLeaderboardRows, currentProfileRecentResults, currentProfileRecentStats);
    // Render the first upstream batch immediately while the server completes
    // the cache refresh and watermark scan in the background.
    hasMore = true;
    visibleCount = 20;
    renderProfileLastMatchFromMatch(matches[0]);
    render();

    // Replace the initial batch with the completed cached 100-match window as
    // soon as the background refresh finishes.
    try {
      const complete = await fetchPage(0, 100);
      if (!isCurrent()) return;
      matches = Array.isArray(complete.matches) ? complete.matches : matches;
      saveProfileMatchesLocalCache(profileId, matches);
      currentProfileRecentResults = profileRecentResultsByLeaderboard(matches, profileId);
      currentProfileRecentStats = profileRecentStatsByLeaderboard(matches, profileId);
      currentProfileRecentModeCounts = profileRecentModeCounts(matches, profileId);
      renderProfileModeCharts();
      if (currentProfileLeaderboardRows.length) renderProfileLeaderboards(currentProfileLeaderboardRows, currentProfileRecentResults, currentProfileRecentStats);
      hasMore = false;
      renderProfileLastMatchFromMatch(matches[0]);
      render();
    } catch {
      // The initial 20 matches remain visible if the background refresh fails.
    }
  } catch {
    // Do not fall back to AoE2Recs matches: they may omit per-player ratingDiff.
    if (isCurrent()) {
      currentProfileRecentModeCounts = new Map();
      renderProfileModeCharts();
      const body = document.querySelector('#profileMatchesBody');
      if (body) body.innerHTML = '';
    }
  }
  if (localMatches && localFresh) {
    render();
    fetch(`/api/profile-matches?id=${encodeURIComponent(profileId)}&latest=1`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        const latest = Array.isArray(data?.matches) ? data.matches[0] : null;
        if (!latest || !isCurrent()) return;
        const known = new Set(matches.map(match => String(match.id)));
        matches = [latest, ...matches.filter(match => String(match.id) !== String(latest.id))].slice(0, 100);
        applyMatches();
        render();
        if (!known.has(String(latest.id))) saveProfileMatchesLocalCache(profileId, matches);
      }).catch(() => {});
  }
  if (!more) return;
  more.onclick = async () => {
    if (!isCurrent()) return;
    if (loading) return;
    if (visibleCount < matches.length) {
      visibleCount = Math.min(visibleCount + 20, matches.length);
      render();
      return;
    }
    if (!hasMore) return;
    loading = true;
    render();
    try {
      const page = await fetchPage(matches.length, 100);
      if (!isCurrent()) return;
      const incoming = Array.isArray(page.matches) ? page.matches : [];
      const known = new Set(matches.map(match => String(match.id)));
      matches = matches.concat(incoming.filter(match => !known.has(String(match.id))));
      hasMore = Boolean(page.hasMore);
      visibleCount = Math.min(visibleCount + 20, matches.length);
    } catch {
      hasMore = false;
    } finally {
      loading = false;
      render();
    }
  };
}
function loadProfileAccounts(profileId, requestId) {
  const isCurrent = () => requestId === profileDetailsRequestId && location.pathname === `/profile/${encodeURIComponent(String(profileId))}`;
  setProfileMessage(profileSectionLoadingMarkup());
  fetch(`/api/profile-accounts?id=${encodeURIComponent(profileId)}`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : Promise.reject(new Error('账号资料请求失败')))
    .then(data => {
      if (!isCurrent()) return;
      if (data?.avatar) currentProfileAvatarUrl = data.avatar;
      const details = { player: { id: profileId }, avatar: data?.avatar || '', accounts: Array.isArray(data?.accounts) ? data.accounts : [] };
      renderProfileIdentityLinks(details.accounts, profileId);
      document.querySelector('#profileDetailsBody').innerHTML = renderPlayerDetailsRows(details);
      loadProfileAccountAvatars();
    })
    .catch(() => { if (isCurrent()) setProfileMessage('暂时无法获取账号与曾用名', 'profile-details-error'); });
}
function renderAoE2RecsProfile(profile, profileId, fallbackName, requestId = profileDetailsRequestId) {
  setProfileLoadingAnimation(false);
  const selectedAccount = (Array.isArray(profile.accounts) ? profile.accounts : []).find(account => String(account.id ?? '') === String(profileId));
  const playerName = selectedAccount?.name || profile.player?.name || fallbackName || `玩家 ${profileId}`;
  document.querySelector('#profileIdentityName').textContent = playerName;
  const player = profile.player || {};
  const avatar = document.querySelector('#profileOverviewAvatar');
  if (avatar) {
    avatar.replaceChildren();
    avatar.textContent = playerName.slice(0, 1).toUpperCase();
    const fallbackAvatarUrl = profile.avatar || currentProfileAvatarUrl;
    const applyFallbackAvatar = () => {
      if (fallbackAvatarUrl && avatar.isConnected) applyProfileOverviewAvatar(fallbackAvatarUrl, requestId);
    };
    if (/^\d+$/.test(String(profileId))) {
      // 先走服务端头像缓存；缓存失效后由服务端查询 Steam，失败再回退 AoE2Recs 资料头像。
      fetch(`/api/avatar?profileId=${encodeURIComponent(profileId)}`, { cache: 'force-cache' })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
          if (!avatar.isConnected) return;
          if (data?.avatar) {
            const image = document.createElement('img');
            image.src = data.avatar;
            image.alt = '';
            image.loading = 'lazy';
            image.onerror = applyFallbackAvatar;
            avatar.replaceChildren(image);
          } else {
            applyFallbackAvatar();
          }
        }).catch(applyFallbackAvatar);
    } else {
      applyFallbackAvatar();
    }
  }
  const meta = document.querySelector('#profileIdentityMeta');
  if (meta) {
    const country = profileCountryMarkup(player.country_code);
    const team = player.team || '暂无战队';
    meta.innerHTML = `${country}<span class="profile-country-separator">·</span><span class="profile-team-inline">${escapeHtml(team)}</span>`;
  }
  renderProfileIdentityLinks(profile.accounts, profileId);
  renderProfileIdentityReference(profile.rlReference || null);
  const lastMatch = document.querySelector('#profileIdentityLastMatch');
  if (lastMatch) {
    const latestMatch = Array.isArray(profile.matches) ? profile.matches[0] : null;
    const started = Number(latestMatch?.started || latestMatch?.lobby_created) || 0;
    const duration = Number(latestMatch?.duration);
    const latest = started > 0 ? started + (Number.isFinite(duration) && duration > 0 ? duration : 0) : 0;
    const relative = formatTimeAgo(latest) || '暂无数据';
    lastMatch.textContent = `最后游戏时间：${relative}`;
    lastMatch.title = latest > 0 ? new Date(latest * 1000).toLocaleString('zh-CN') : '接口未提供最后游戏时间';
  }
  if (Array.isArray(profile.accounts) && profile.accounts.length) {
    document.querySelector('#profileDetailsBody').innerHTML = renderPlayerDetailsRows(profile);
    loadProfileAccountAvatars();
  }
  const matchesBody = document.querySelector('#profileMatchesBody');
  if (matchesBody && profileMatchesRequestId !== requestId) matchesBody.innerHTML = profileLoadingMarkup();
  if (profileMatchesRequestId !== requestId) loadWorldsEdgeMatches(profileId, profile, requestId);
}
function routeToPlayerProfile(player) {
  if (!player?.profileId) return;
  if (!location.pathname.startsWith('/profile')) history.replaceState({ ...(history.state || {}), leaderboard: { ladder: selectedLadder, country: selectedCountry, page: currentPage } }, '', location.href);
  history.pushState({ profileId: String(player.profileId), name: String(player.name || '') }, '', `/profile/${encodeURIComponent(player.profileId)}`);
  hideProfileSuggestions();
  renderCurrentRoute(player);
}
function setProfileMessage(message, className = 'profile-details-empty') {
  document.querySelector('#profileDetailsBody').innerHTML = `<tr><td colspan="4" class="${className}">${message}</td></tr>`;
}
let mediaRequest = null;
function mediaDate(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? new Date(time).toLocaleString('zh-CN') : '';
}
function mediaThumbnail(item, live = false) {
  if (!item?.thumbnail) return '';
  if (/^\/assets\//i.test(String(item.thumbnail))) return String(item.thumbnail);
  const liveParams = live ? `&live=1&v=${Math.floor(Date.now() / (5 * 60 * 1000))}` : '';
  return `/api/media/thumbnail?id=${encodeURIComponent(item.id || 'thumbnail')}&url=${encodeURIComponent(item.thumbnail)}${liveParams}`;
}
function renderMedia(data, showAllVideos = false) {
  const videos = document.querySelector('#mediaVideos');
  const liveCN = document.querySelector('#mediaLiveCN');
  const liveForeign = document.querySelector('#mediaLiveForeign');
  const liveSection = document.querySelector('#mediaLiveSection');
  const moreLink = document.querySelector('#mediaVideosMore');
  const backLink = document.querySelector('#mediaVideosBack');
  const title = document.querySelector('#mediaTitle');
  const subtitle = document.querySelector('#mediaSubtitle');
  const videosHint = document.querySelector('#mediaVideosHint');
  if (liveSection) liveSection.hidden = showAllVideos;
  if (moreLink) moreLink.hidden = showAllVideos;
  if (backLink) backLink.hidden = !showAllVideos;
  if (title) title.textContent = showAllVideos ? '全部视频' : '视频直播';
  if (subtitle) subtitle.textContent = showAllVideos ? '服务端当前保存的全部视频' : '开发者精选的帝国时代 II 视频与直播';
  if (videosHint) videosHint.textContent = showAllVideos ? '服务端缓存' : '最新 10 个';
  if (videos) {
    const items = (Array.isArray(data?.videos) ? data.videos : []).slice(0, showAllVideos ? 50 : 10);
    videos.innerHTML = items.length ? items.map(item => `<a class="media-card" href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"><div class="media-thumb">${item.thumbnail ? `<img src="${escapeHtml(mediaThumbnail(item))}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-image');this.remove()">` : ''}</div><div class="media-card-body"><strong title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || '未命名视频')}</strong><span>${escapeHtml(item.channel || '')}${item.publishedAt ? ` · ${escapeHtml(mediaDate(item.publishedAt))}` : ''}</span></div></a>`).join('') : '<div class="media-empty">暂无已配置的视频源</div>';
  }
  if (liveCN || liveForeign) {
    const items = Array.isArray(data?.live) ? data.live : [];
    const platformNames = { twitch: 'Twitch', youtube: 'YouTube', youtube_live: 'YouTube', douyin: '抖音', douyu: '斗鱼', bilibili: '哔哩哔哩', kick: 'Kick' };
    const ladderBadge = (label, stat) => stat && Number.isFinite(Number(stat.rating)) && Number(stat.rank) > 0
      ? `<small><b>${label}</b> ${Number(stat.rating).toLocaleString('zh-CN')} <i>#${Number(stat.rank).toLocaleString('zh-CN')}</i></small>`
      : '';
    const markup = list => list.length ? list.map(item => {
      const platform = platformNames[item.platform] || item.platform || '直播';
      const countLabel = ['bilibili', 'douyu'].includes(item.platform) ? '人气' : '人观看';
      const ladders = `${ladderBadge('1v1', item.leaderboards?.randomMap1v1)}${ladderBadge('团队', item.leaderboards?.randomMapTeam)}`;
      const liveTitle = item.title || '正在直播';
      return `<a class="media-card media-live-card is-live" href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"><div class="media-thumb">${item.thumbnail ? `<img src="${escapeHtml(mediaThumbnail(item, true))}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-image');this.remove()">` : ''}<span class="media-live-status">${escapeHtml(platform)}</span></div><div class="media-card-body"><strong class="media-live-title" title="${escapeHtml(liveTitle)}">${escapeHtml(liveTitle)}</strong><div class="media-live-bottom"><div class="media-live-host"><strong class="media-live-player-name" title="${escapeHtml(item.name || '未知主播')}">${escapeHtml(item.name || '未知主播')}</strong><span class="media-live-audience"><b class="media-spark" aria-hidden="true">✦</b> ${Number(item.viewers || 0).toLocaleString('zh-CN')} ${countLabel}</span></div>${ladders ? `<span class="media-live-ladders">${ladders}</span>` : ''}</div></div></a>`;
    }).join('') : '<div class="media-empty">暂无开播直播间</div>';
    if (liveCN) liveCN.innerHTML = markup(items.filter(item => item.isCN));
    if (liveForeign) liveForeign.innerHTML = markup(items.filter(item => !item.isCN));
  }
}
function loadMedia(showAllVideos = false) {
  if (mediaRequest) return mediaRequest;
  mediaRequest = fetch('/api/media', { cache: 'default' }).then(response => response.ok ? response.json() : Promise.reject(new Error('视频直播请求失败'))).then(data => { renderMedia(data, showAllVideos); return data; }).catch(() => { renderMedia({ videos: [], live: [] }, showAllVideos); }).finally(() => { mediaRequest = null; });
  return mediaRequest;
}
let updatesRequest = null;
let currentUpdatesArticleId = '';
let updatesTocActiveId = '';
let updatesTocSyncFrame = 0;
let updatesTocManualScroll = false;
function normalizeUpdatesArticle() {
  const article = document.querySelector('#updatesArticle');
  if (!article) return;
  for (const paragraph of [...article.querySelectorAll(':scope > p')]) {
    const text = paragraph.textContent.trim();
    const meaningful = [...paragraph.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE || node.textContent.trim());
    const onlyBold = meaningful.length && meaningful.every(node => node.nodeType === Node.ELEMENT_NODE && ['STRONG', 'BR'].includes(node.tagName));
    if (!onlyBold || text.length < 2 || text.length > 48) continue;
    const isMinorHeading = /^(?:声明|内容概要)(?:[:：]|\s|$)/.test(text);
    const isMajorHeading = paragraph.previousElementSibling?.tagName === 'HR' && !isMinorHeading;
    const heading = document.createElement(isMajorHeading ? 'h2' : 'h3');
    heading.className = 'updates-inferred-heading';
    heading.innerHTML = paragraph.innerHTML;
    paragraph.replaceWith(heading);
  }
  for (const list of [...article.querySelectorAll(':scope > ul.updates-opus-list')]) {
    if (!list.isConnected) continue;
    let next = list.nextElementSibling;
    while (next?.matches(`ul.updates-opus-list.${[...list.classList].find(name => name.startsWith('level-')) || 'level-1'}`)) {
      const following = next.nextElementSibling;
      list.append(...next.children);
      next.remove();
      next = following;
    }
  }
}
function renderUpdatesToc(articleId = '') {
  const article = document.querySelector('#updatesArticle');
  const toc = document.querySelector('#updatesToc');
  if (!article || !toc) return;
  const headings = [...article.querySelectorAll(':scope > h2, :scope > h3, :scope > h4, :scope > .opus-module-content > h2, :scope > .opus-module-content > h3, :scope > .opus-module-content > h4')]
    .filter(heading => !/^(?:译注|译者注|编者注|注释|注意|重要提示)(?:[:：]|\s|$)/.test(heading.textContent.trim()));
  if (headings.length < 2) {
    toc.hidden = true;
    toc.innerHTML = '';
    updatesTocActiveId = '';
    return;
  }
  const key = String(articleId || 'article').replace(/[^a-z0-9_-]/gi, '');
  const entries = headings.map((heading, index) => {
    heading.id = `updates-section-${key}-${index + 1}`;
    return `<a class="level-${heading.tagName.slice(1)}" href="#${heading.id}">${escapeHtml(heading.textContent.trim() || `章节 ${index + 1}`)}</a>`;
  });
  toc.innerHTML = `<strong>文章目录</strong><nav>${entries.join('')}</nav>`;
  for (const link of toc.querySelectorAll('a[href^="#"]')) {
    link.addEventListener('click', event => {
      event.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  toc.hidden = false;
  updatesTocActiveId = '';
  syncUpdatesTocToReading();
}
function syncUpdatesTocToReading() {
  const toc = document.querySelector('#updatesToc');
  if (!toc || toc.hidden || !/^\/updates\/?$/.test(location.pathname)) return;
  const links = [...toc.querySelectorAll('a[href^="#"]')];
  const entries = links.map(link => ({ link, heading: document.getElementById(link.getAttribute('href').slice(1)) })).filter(entry => entry.heading);
  if (!entries.length) return;
  const marker = 130;
  let active = entries[0];
  for (const entry of entries) {
    if (entry.heading.getBoundingClientRect().top > marker) break;
    active = entry;
  }
  const id = active.heading.id;
  if (id === updatesTocActiveId) return;
  updatesTocActiveId = id;
  for (const entry of entries) entry.link.classList.toggle('active', entry === active);
  if (updatesTocManualScroll) return;
  const tocRect = toc.getBoundingClientRect();
  const linkRect = active.link.getBoundingClientRect();
  const linkTop = linkRect.top - tocRect.top + toc.scrollTop;
  const targetTop = linkTop - (toc.clientHeight - linkRect.height) / 2;
  toc.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
}
function scheduleUpdatesTocSync() {
  if (updatesTocSyncFrame) return;
  updatesTocSyncFrame = requestAnimationFrame(() => {
    updatesTocSyncFrame = 0;
    syncUpdatesTocToReading();
  });
}
function renderUpdates(data) {
  const select = document.querySelector('#updatesArticleSelect');
  const article = document.querySelector('#updatesArticle');
  const updated = document.querySelector('#updatesUpdated');
  const status = document.querySelector('#updatesStatus');
  const items = Array.isArray(data?.articles) ? data.articles : [];
  if (updated) updated.textContent = data?.updatedAt ? `更新于 ${mediaDate(data.updatedAt)}` : '等待更新';
  if (select) {
    const current = String(data?.article?.id || '');
    select.innerHTML = items.length ? items.map(item => `<option value="${escapeHtml(item.id)}"${String(item.id) === current ? ' selected' : ''}>${escapeHtml(item.title || '未命名文章')}</option>`).join('') : '<option value="">暂无符合条件的文章</option>';
    select.onchange = () => loadUpdates(select.value);
  }
  const item = data?.article;
  if (item?.id) currentUpdatesArticleId = String(item.id);
  if (status) status.textContent = items.length ? `共 ${items.length} 篇` : '暂无文章';
  if (article) {
    if (!item) {
      article.innerHTML = '<div class="updates-empty">暂无符合筛选条件的文章</div>';
      renderUpdatesToc();
    }
    else {
      const authorUrl = `https://space.bilibili.com/${encodeURIComponent(item.authorUid || '2608713')}`;
      article.innerHTML = `<h1>${escapeHtml(item.title || '未命名文章')}</h1><div class="updates-attribution">文章转载于 <a href="${escapeHtml(item.sourceUrl || '#')}" target="_blank" rel="noopener noreferrer">原链接</a>，作者是 <a href="${escapeHtml(authorUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.author || '未知')}</a></div>${item.contentHtml || '<div class="updates-empty">正文暂未抓取完成，请稍后重试。</div>'}`;
      normalizeUpdatesArticle();
      renderUpdatesToc(item.id);
    }
  }
}
function loadUpdates(articleId = '') {
  const requestedId = String(articleId || currentUpdatesArticleId || '');
  if (updatesRequest && !requestedId) return updatesRequest;
  const request = fetch(`/api/updates${requestedId ? `?articleId=${encodeURIComponent(requestedId)}` : ''}`, { cache: 'no-store' }).then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))).then(data => { renderUpdates(data); return data; }).catch(error => { const article = document.querySelector('#updatesArticle'); if (article) article.innerHTML = `<div class="updates-empty">更新汇总加载失败：${escapeHtml(error.message || '')}</div>`; }).finally(() => { if (!requestedId) updatesRequest = null; });
  if (!requestedId) updatesRequest = request;
  return request;
}
const updatesBackToTop = document.querySelector('#updatesBackToTop');
const leaderboardBackToTop = document.querySelector('#leaderboardBackToTop');
const updatesToc = document.querySelector('#updatesToc');
function syncUpdatesBackToTop() {
  const isUpdates = /^\/updates\/?$/.test(location.pathname);
  const isLeaderboard = /^\/?$/.test(location.pathname);
  if (updatesBackToTop) updatesBackToTop.hidden = !isUpdates || window.scrollY < 480;
  if (leaderboardBackToTop) leaderboardBackToTop.hidden = !isLeaderboard || window.scrollY < 480;
}
updatesBackToTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
leaderboardBackToTop?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
updatesToc?.addEventListener('wheel', event => {
  const maxScrollTop = updatesToc.scrollHeight - updatesToc.clientHeight;
  if (maxScrollTop <= 0 || !event.deltaY) return;
  const canScroll = event.deltaY < 0 ? updatesToc.scrollTop > 0 : updatesToc.scrollTop < maxScrollTop - 1;
  if (!canScroll) return;
  event.preventDefault();
  event.stopPropagation();
  updatesTocManualScroll = true;
  const currentScrollTop = updatesToc.scrollTop;
  updatesToc.scrollTo({ top: currentScrollTop, behavior: 'auto' });
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 18 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? updatesToc.clientHeight : 1;
  updatesToc.scrollTop += event.deltaY * scale;
}, { passive: false });
updatesToc?.addEventListener('mouseleave', () => {
  if (!updatesTocManualScroll) return;
  updatesTocManualScroll = false;
  updatesTocActiveId = '';
  scheduleUpdatesTocSync();
});
let buildOrdersRequest = null;
let buildOrdersItems = [];
let buildOrdersFilter = 'all';
let buildOrdersRenderId = 0;
function buildGuideArtwork(item) {
  const images = Array.isArray(item.images) && item.images.length ? item.images : item.image ? [item.image] : [];
  return '<div class="build-guide-pictures' + (images.length > 1 ? ' is-dual' : '') + '">' + images.slice(0, 2).map(src => '<img src="' + escapeHtml(src) + '" alt="" loading="lazy">').join('') + '</div>';
}
function buildGuideTitle(item) {
  return String(item?.title || '未命名开局').replace('被偷猪后18P封建时代', '防偷猪的18P封建时代');
}
function buildGuideStepIcon(step) {
  const action = String(step?.action || '');
  const original = String(step?.icon || '');
  const icon = name => `/assets/build-orders/icons/${name}.webp`;
  const unit = name => `/assets/build-orders/units/${name}.webp?v=units-v2`;
  if (/升级(?:到|进入)?(?:封建|城堡|帝王)时代|封建时代|城堡时代|帝王时代/.test(action)) {
    if (/帝王/.test(action)) return icon('imperial-age');
    if (/城堡/.test(action)) return icon('castle-age');
    return icon('feudal-age');
  }
  if (/撒田|耕田|耕作|农田/.test(action)) return icon('farm');
  if (/弓锯|弓鋸/.test(action)) return icon('bow-saw');
  if (/重型犁|重犁/.test(action)) return icon('heavy-plow');
  if (/箭羽|羽箭/.test(action)) return icon('fletching');
  if (/骑兵护甲|骑兵鳞甲|骑兵铠甲/.test(action)) return icon('cavalry-armor');
  if (/步兵护甲|手护甲|护甲|装甲/.test(action)) return icon('armor');
  if (/血统/.test(action)) return icon('bloodlines');
  if (/纵火/.test(action)) return icon('arson');
  if (/手推车|独轮手推车/.test(action)) return icon('wheelbarrow');
  if (/锥子箭/.test(action)) return icon('bodkin-arrow');
  if (/畜牧/.test(action)) return icon('husbandry');
  if (/侍从/.test(action)) return icon('armor');
  if (/强化教堂/.test(action)) return icon('fortified-church');
  if (/攻城武器厂/.test(action)) return icon('siege-workshop');
  if (/城镇中心|城堡中心/.test(action)) return icon('town-center');
  if (/赶鹿|引鹿|诱鹿|引诱.*鹿/.test(action)) return icon('deer');
  // 步骤明确提到要建造/生产某个单位时，单位图标优先于同句中的建筑图标。
  if (/步弓手|弓兵/.test(action)) return unit('archer');
  if (/鹰斥候/.test(action)) return unit('eagle-scout');
  if (/弩手|弩兵/.test(action)) return unit('crossbowman');
  if (/掷矛手|散兵/.test(action)) return unit('skirmisher');
  if (/长矛兵|矛兵|长枪兵/.test(action)) return unit('spearman');
  if (/斥候骑兵|侦察骑兵/.test(action)) return unit('scout-cavalry');
  if (/骑射手|骑射兵|骑射/.test(action)) return unit('cavalry-archer');
  if (/轻骑兵/.test(action)) return unit('light-cavalry');
  if (/骑士/.test(action)) return unit('knight');
  if (/火枪手|手铳兵|手持加农炮|手炮兵/.test(action)) return unit('hand-cannoneer');
  if (/剑士|长剑士/.test(action)) return unit('man-at-arms');
  if (/民兵/.test(action)) return unit('militia');
  if (/牧师战士/.test(action)) return unit('priest-warrior');
  if (/僧侣|牧师|修道士/.test(action)) return unit('monk');
  // “散木”是地图上的零散树木，使用木材/散木图标；普通伐木步骤使用伐木场图标。
  if (/散木/.test(action)) return icon('straggler-tree');
  if (/伐木|木区|砍伐/.test(action)) return icon('lumber-camp');
  if (/浆果/.test(action)) return icon('berries');
  if (/野猪/.test(action)) return icon('boar');
  if (/赶鹿|引鹿|诱鹿|鹿/.test(action)) return icon('deer');
  if (/羊肉|羊/.test(action)) return icon('sheep');
  if (/鸡|鸡群/.test(action)) return icon('resource-food');
  if (/农田|种子|撒.*田/.test(action)) return icon('farm');
  if (/靶场|射箭场|弓箭场/.test(action)) return icon('archery-range');
  if (/马厩|马房|骑兵建筑/.test(action)) return icon('stable');
  if (/市场|贸易站/.test(action)) return icon('market');
  if (/马轭|马驹/.test(action)) return icon('horse-collar');
  if (/黄金|采矿场|金矿/.test(action)) return icon('gold');
  if (/石料|采石/.test(action)) return icon('stone');
  if (/食物|狩猎|采集/.test(action) && !/建造|房屋|磨坊/.test(action)) return icon('resource-food');
  if (/木头|木材/.test(action)) return icon('resource-wood');
  return original;
}
function buildOrderCard(item) {
  const civs = Array.isArray(item.civilizations) ? item.civilizations : [];
  return `<a class="build-order-card" href="/build-orders/${encodeURIComponent(item.slug)}" data-build-order-slug="${escapeHtml(item.slug)}" data-category="${escapeHtml(item.category || 'standard')}" data-video="${item.video ? 'true' : 'false'}"><div class="build-order-art">${buildGuideArtwork(item)}<div class="build-order-badges"><span>${item.category === 'signature' ? '特色战术' : '通用开局'}</span>${item.video ? '<span class="video">视频指南</span>' : ''}</div></div><div class="build-order-card-body"><h4>${escapeHtml(buildGuideTitle(item))}</h4><div class="build-order-metrics"><span><small>步骤</small><b>${Number(item.steps || 0)} 步</b></span><span><small>升级时间</small><b>${escapeHtml(item.timing || '灵活')}</b></span></div><div class="build-order-civs"><small>推荐文明</small><p>${civs.length ? civs.map(name => `<span>${escapeHtml(name)}</span>`).join('') : '<span>全部文明</span>'}</p></div></div></a>`;
}
function renderBuildOrderCardsProgressively(target, items, emptyMessage, renderId) {
  if (!target) return;
  target.innerHTML = '';
  if (!items.length) { target.innerHTML = `<div class="build-orders-empty">${emptyMessage}</div>`; return; }
  let offset = 0;
  const appendNext = () => {
    if (renderId !== buildOrdersRenderId) return;
    target.insertAdjacentHTML('beforeend', items.slice(offset, offset + 4).map(buildOrderCard).join(''));
    offset += 4;
    if (offset < items.length) requestAnimationFrame(appendNext);
  };
  appendNext();
}
function renderBuildOrdersList() {
  const query = String(document.querySelector('#buildOrdersSearch')?.value || '').trim().toLocaleLowerCase();
  const filtered = buildOrdersItems.filter(item => {
    const matchesFilter = buildOrdersFilter === 'all' || item.category === buildOrdersFilter || (buildOrdersFilter === 'video' && item.video);
    const haystack = [item.title, ...(Array.isArray(item.civilizations) ? item.civilizations : [])].join(' ').toLocaleLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });
  const standard = filtered.filter(item => item.category !== 'signature');
  const signature = filtered.filter(item => item.category === 'signature');
  const standardGrid = document.querySelector('#buildOrdersStandard');
  const signatureGrid = document.querySelector('#buildOrdersSignature');
  const standardSection = document.querySelector('#buildOrdersStandardSection');
  const signatureSection = document.querySelector('#buildOrdersSignatureSection');
  const emptyMessage = buildOrdersItems.length ? '没有符合条件的开局指南' : '等待导入新的内容来源…';
  const renderId = ++buildOrdersRenderId;
  renderBuildOrderCardsProgressively(standardGrid, standard, emptyMessage, renderId);
  renderBuildOrderCardsProgressively(signatureGrid, signature, emptyMessage, renderId);
  if (standardSection) standardSection.hidden = buildOrdersFilter === 'signature';
  if (signatureSection) signatureSection.hidden = buildOrdersFilter === 'standard';
  const total = document.querySelector('#buildOrdersCount');
  const standardCount = document.querySelector('#buildOrdersStandardCount');
  const signatureCount = document.querySelector('#buildOrdersSignatureCount');
  if (total) total.textContent = `${filtered.length} 篇`;
  if (standardCount) standardCount.textContent = `${standard.length} 篇`;
  if (signatureCount) signatureCount.textContent = `${signature.length} 篇`;
}
function renderBuildOrderDetail(item) {
  const library = document.querySelector('#buildOrdersLibrary');
  const detail = document.querySelector('#buildOrderDetail');
  const body = document.querySelector('#buildOrderDetailBody');
  if (library) library.hidden = Boolean(item);
  if (detail) detail.hidden = !item;
  if (!item || !body) return;
  const civs = Array.isArray(item.civilizations) ? item.civilizations : [];
  const notes = Array.isArray(item.notes) ? item.notes : [];
  const steps = Array.isArray(item.timelineSteps) ? item.timelineSteps : [];
  let currentPhase = '';
  const timeline = steps.map(step => {
    const phase = step.phase && step.phase !== currentPhase ? `<div class="build-order-phase">${step.phaseIcon ? `<img src="${escapeHtml(step.phaseIcon)}" alt="" referrerpolicy="no-referrer">` : ''}<strong>${escapeHtml(step.phase)}</strong><i></i></div>` : '';
    if (step.phase) currentPhase = step.phase;
    const assignments = (Array.isArray(step.assignments) ? step.assignments : []).map(label => `<span>${escapeHtml(label)}</span>`).join('');
    const resources = step.resources || {};
    const resourceGrid = step.hasResources ? `<div class="build-order-resource-grid"><span title="村民"><i>♟</i><b>${Number(resources.villagers || 0)}</b></span><span title="木材"><i><img src="/assets/build-orders/icons/resource-wood.webp" alt="木材"></i><b>${Number(resources.wood || 0)}</b></span><span title="食物"><i><img src="/assets/build-orders/icons/resource-food.webp" alt="食物"></i><b>${Number(resources.food || 0)}</b></span><span title="黄金"><i><img src="/assets/build-orders/icons/resource-gold.webp" alt="黄金"></i><b>${Number(resources.gold || 0)}</b></span><span title="石料"><i><img src="/assets/build-orders/icons/resource-stone.webp" alt="石料"></i><b>${Number(resources.stone || 0)}</b></span></div>` : '';
    const stepIcon = buildGuideStepIcon(step);
    return `${phase}<div class="build-order-step"><div class="build-order-step-icon">${stepIcon ? `<img src="${escapeHtml(stepIcon)}" alt="" title="${escapeHtml(step.iconTitle || '')}" referrerpolicy="no-referrer">` : ''}</div><div class="build-order-step-copy"><p>${escapeHtml(step.action || '')}</p>${assignments ? `<div class="build-order-assignments">${assignments}</div>` : ''}</div>${resourceGrid}</div>`;
  }).join('');
  const video = item.video?.embedUrl ? `<section class="build-order-video"><iframe src="${escapeHtml(item.video.embedUrl)}" title="${escapeHtml(item.video.title || item.title || '视频指南')}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe><div><span>视频指南${item.author ? ` · ${escapeHtml(item.author)}` : ''}</span><strong>${escapeHtml(item.video.title || item.title || '')}</strong>${item.video.url ? `<a href="${escapeHtml(item.video.url)}" target="_blank" rel="noopener noreferrer">在 YouTube 打开 ↗</a>` : ''}</div></section>` : '';
  body.innerHTML = `<div class="build-order-detail-hero"><div class="build-order-detail-art">${buildGuideArtwork(item)}</div><div><div class="build-order-badges"><span>${item.category === 'signature' ? '特色战术' : '通用开局'}</span>${item.video ? '<span class="video">视频指南</span>' : ''}</div><small>${escapeHtml(item.eyebrow || '')}</small><h2>${escapeHtml(buildGuideTitle(item))}</h2><p>${Number(item.steps || 0)} 个步骤 · 升级时间 ${escapeHtml(item.timing || '灵活')}</p>${item.author ? `<div class="build-order-author">${item.authorImage ? `<img src="${escapeHtml(item.authorImage)}" alt="" referrerpolicy="no-referrer">` : ''}<strong>${escapeHtml(item.author)}</strong>${item.creatorUrl ? `<a href="${escapeHtml(item.creatorUrl)}" target="_blank" rel="noopener noreferrer">作者指南 ↗</a>` : ''}</div>` : ''}</div></div>${video}${notes.length ? `<section class="build-order-notes"><h3>${escapeHtml(item.notesTitle || '战术说明')}</h3><div>${notes.map(note => `<article><strong>${escapeHtml(note.title || '')}</strong><p>${escapeHtml(note.text || '')}</p></article>`).join('')}</div></section>` : ''}<div class="build-order-detail-panel"><div><span>推荐文明</span><p>${civs.length ? civs.map(name => `<b>${escapeHtml(name)}</b>`).join('') : '<b>全部文明</b>'}</p></div></div><section class="build-order-timeline"><div class="build-order-timeline-heading"><span>执行步骤</span><h3>开局流程</h3>${item.timelineIntro ? `<p>${escapeHtml(item.timelineIntro)}</p>` : ''}</div><div class="build-order-steps">${timeline}</div>${item.closing ? `<p class="build-order-closing">${escapeHtml(item.closing)}</p>` : ''}</section>`;
  window.scrollTo({ top: 0, behavior: 'auto' });
}
function renderBuildOrders(data, slug = '') {
  buildOrdersItems = Array.isArray(data?.items) ? data.items : [];
  const updated = document.querySelector('#buildOrdersUpdated');
  if (updated) updated.textContent = data?.updatedAt ? `更新于 ${mediaDate(data.updatedAt)}` : '等待更新';
  renderBuildOrdersList();
  renderBuildOrderDetail(slug ? data?.item : null);
}
function loadBuildOrders(slug = '') {
  if (buildOrdersRequest) return buildOrdersRequest;
  const url = `/api/build-orders${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`;
  buildOrdersRequest = fetch(url, { cache: 'no-store' }).then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))).then(data => { renderBuildOrders(data, slug); return data; }).catch(error => {
    const target = document.querySelector('#buildOrdersStandard');
    if (target) target.innerHTML = `<div class="build-orders-empty">开局指南加载失败：${escapeHtml(error.message || '')}</div>`;
  }).finally(() => { buildOrdersRequest = null; });
  return buildOrdersRequest;
}
document.querySelector('#buildOrdersSearch')?.addEventListener('input', renderBuildOrdersList);
document.querySelector('#buildOrdersFilters')?.addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  buildOrdersFilter = button.dataset.filter || 'all';
  document.querySelectorAll('#buildOrdersFilters [data-filter]').forEach(entry => entry.classList.toggle('selected', entry === button));
  renderBuildOrdersList();
});
document.querySelector('#buildOrderBack')?.addEventListener('click', () => {
  history.pushState({}, '', '/build-orders');
  renderCurrentRoute();
});
document.querySelector('#build-orders-page')?.addEventListener('click', event => {
  const link = event.target.closest('[data-build-order-slug]');
  if (!link) return;
  event.preventDefault();
  history.pushState({}, '', link.getAttribute('href'));
  renderCurrentRoute();
});
window.addEventListener('scroll', syncUpdatesBackToTop, { passive: true });
window.addEventListener('scroll', scheduleUpdatesTocSync, { passive: true });
setInterval(() => {
  if (!/^\/media\/?$/.test(location.pathname)) return;
  const bucket = String(Math.floor(Date.now() / (5 * 60 * 1000)));
  for (const image of document.querySelectorAll('.media-live-card .media-thumb img')) {
    const source = new URL(image.src, location.origin);
    source.searchParams.set('v', bucket);
    image.src = `${source.pathname}${source.search}`;
  }
}, 5 * 60 * 1000);

let realtimeRequest = null;
let realtimeVersionRequest = null;
let realtimePollTimer = null;
let realtimeRequestId = 0;
let realtimeLastPayload = null;
let realtimeLastVersion = null;
let realtimeLastEtag = null;
function realtimeElapsed(started) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(started || 0));
  if (!seconds) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时前`;
}
function realtimeServerName(value) {
  const text = String(value || '').trim().toLowerCase();
  const names = { ukwest: '英国西部', uksouth: '英国南部', koreacentral: '韩国中部', centralindia: '印度中部', southcentralus: '美国中南部', eastus: '美国东部', eastus2: '美国东部 2', westus: '美国西部', westus2: '美国西部 2', westus3: '美国西部 3', japaneast: '日本东部', southeastasia: '东南亚', australiaeast: '澳大利亚东部', brazilsouth: '巴西南部', westeurope: '西欧', northeurope: '北欧' };
  return names[text] || (text ? text : '未知服务器');
}
function realtimeLeaderboardName(value) {
  const key = String(value || '').trim().toUpperCase().replace(/\s+/g, '_');
  const names = { RM_1V1: '1v1 随机地图', RM_TG: '团队随机地图', RM_TEAM: '团队随机地图', DM_1V1: '1v1 死亡竞赛', DM_TG: '团队死亡竞赛', DM_TEAM: '团队死亡竞赛', EW_1V1: '1v1 帝国战争', EW_TG: '团队帝国战争', EW_TEAM: '团队帝国战争', UNRANKED: '非排位' };
  if (key.startsWith('QP_')) return `快速${realtimeLeaderboardName(key.slice(3))}`;
  return names[key] || String(value || '自定义房间');
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
  if (oneVsOne) {
    const opponent = players.find(player => String(player.profileId) !== String(state.profileId) && (!own || String(player.team) !== String(own.team))) || players.find(player => String(player.profileId) !== String(state.profileId));
    if (opponent) label = `${map} vs ${opponent.name || `玩家 ${opponent.profileId || ''}`}`;
  } else if (teamGame) {
    label = `${map} TG`;
  }
  const rawScore = Array.isArray(match.score) ? match.score : (Array.isArray(match.scores) ? match.scores : []);
  const score = rawScore.length >= 2
    ? `${rawScore[0] ?? 0}:${rawScore[1] ?? 0}`
    : '0:0';
  const tournamentName = typeof match.tournament === 'string' ? match.tournament.trim() : String(match.tournament?.name || '').trim();
  const format = Number(match.bestOf) > 0 ? `BO${Number(match.bestOf)}` : '';
  const eventMeta = tournamentName ? `<span class="realtime-status-match-meta">（${escapeHtml(format || '赛事')}，${escapeHtml(score)}）</span>` : '';
  return `<span class="realtime-status-activity"><a class="realtime-status-live-link" href="aoe2de://1/${encodeURIComponent(String(match.id || null))}" title="在游戏内观战">◉ ${escapeHtml(label)}</a>${eventMeta}</span>`;
}
function renderRealtimeStatus(states) {
  const target = document.querySelector('#realtimeStatusRows');
  if (!target) return;
  const visible = (Array.isArray(states) ? states : []).filter(state => realtimeStateIsActive(state) || state?.live?.url);
  const identityMap = new Map();
  const priority = state => [
    realtimeStateIsActive(state) ? 3 : state?.live?.url ? 2 : 1,
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
  const list = [...identityMap.values()];
  if (!list.length) { target.innerHTML = '<tr><td colspan="6">暂无选手</td></tr>'; return; }
  target.innerHTML = list.map(state => {
    const player = state.player || {};
    const activity = realtimeStatusActivity(state);
    const rating = Number.isFinite(Number(player.rating)) ? Number(player.rating).toLocaleString('zh-CN') : '—';
    const name = escapeHtml(player.name || `玩家 ${state.profileId || ''}`);
    const team = escapeHtml(player.team || '');
    const tournamentValue = state.match?.tournament || state.match?.event || state.match?.eventName || '';
    const tournamentName = typeof tournamentValue === 'string' ? tournamentValue : tournamentValue?.name || '';
    const tournamentUrl = typeof tournamentValue === 'object'
      ? tournamentValue?.url || tournamentValue?.href || ''
      : state.match?.tournamentUrl || state.match?.eventUrl || '';
    const tournament = tournamentName
      ? (typeof tournamentUrl === 'string' && /^https?:\/\//i.test(tournamentUrl)
        ? `<a class="realtime-status-tournament-link" href="${escapeHtml(tournamentUrl)}" target="_blank" rel="noopener noreferrer" title="打开赛事页面">${escapeHtml(tournamentName)}</a>`
        : escapeHtml(tournamentName))
      : '';
    const live = state.live?.url ? `<a class="realtime-status-stream-link" href="${escapeHtml(state.live.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(state.live.title || '正在直播')}">${realtimePlatformIconMarkup(state.live.platform)}${escapeHtml(state.live.title || '正在直播')}</a>` : '';
    return `<tr><td>${rating}</td><td><a class="realtime-status-player" href="/profile/${encodeURIComponent(String(state.profileId || ''))}">${countryFlag(player.country)}<span>${name}</span></a></td><td>${team}</td><td class="${activity ? 'realtime-status-active' : ''}">${activity}</td><td>${tournament || '—'}</td><td>${live}</td></tr>`;
  }).join('');
}
function realtimeGroupedPlayers(match) {
  const players = Array.isArray(match?.players) ? match.players : [];
  const leaderboard = String(match?.leaderboard || '').toUpperCase();
  const teamGame = leaderboard.includes('TG') || players.length > 2;
  if (!teamGame) return null;
  const groups = new Map();
  players.forEach((player,index) => {
    const team=String(player.team ?? `team-${index+1}`);
    if (!groups.has(team)) groups.set(team,[]);
    groups.get(team).push({player,index});
  });
  return [...groups.entries()];
}
function realtimePlayerRow(player,index) {
  const color=Number(player.color);
  const number=Number.isFinite(color)&&color>0?color:index+1;
  const rating=Number(player.rating);
  const ratingText=Number.isFinite(rating)&&rating>0?rating.toLocaleString('zh-CN'):'-';
  return `<div class="realtime-player-row"><span class="realtime-player-number" style="background:${escapeHtml(realtimePlayerColor(number,index))}">${number}</span><span class="realtime-country">${countryFlag(player.country)}</span><a class="realtime-player-name" href="/profile/${encodeURIComponent(String(player.profileId||null))}"><strong>${escapeHtml(player.name||`玩家 ${player.profileId||''}`)}</strong></a><span class="realtime-player-civ">${realtimeCivIconMarkup(player.civilizationId)}${escapeHtml(civilizationNameZh(player.civilization||'未知文明'))}</span><span class="realtime-player-rating">${ratingText}</span></div>`;
}
function renderRealtimeCards(payload) {
  const container=document.querySelector('#realtimePlayers');
  const statusPanel=document.querySelector('#realtimeStatusPanel');
  const loading=document.querySelector('#realtimeLoading');
  const updated=document.querySelector('#realtimeUpdated');
  if (!container) return;
  realtimeLastPayload = payload || { states: [] };
  const states=Array.isArray(payload?.states)?payload.states:[];
  renderRealtimeStatus(states);
  if (loading) loading.hidden=true;
  if (statusPanel) statusPanel.hidden=false;
  container.hidden=false;
  const matchAverageRating = state => {
    const ratings=(Array.isArray(state?.match?.players)?state.match.players:[]).map(player=>Number(player.rating)).filter(rating=>Number.isFinite(rating)&&rating>0);
    return ratings.length?ratings.reduce((sum,rating)=>sum+rating,0)/ratings.length:-Infinity;
  };
  const games=[...new Map(states.filter(realtimeStateIsActive).map(state=>[String(state.match.id||state.profileId),state])).values()]
    .sort((a,b)=>matchAverageRating(b)-matchAverageRating(a)||Number(b.match?.started||0)-Number(a.match?.started||0));
  if (updated) updated.textContent=payload?.checkedAt?`更新于 ${new Date(payload.checkedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`:'等待更新';
  if (!games.length) {
    container.innerHTML='<div class="realtime-empty"><div class="realtime-empty-icon">◌</div><h3>当前没有检测到进行中的对局</h3><p>检测池中的玩家均未返回正在进行的最新对局。</p></div>';
    return;
  }
  container.innerHTML=games.map(state=>{
    const match=state.match;
    const players=Array.isArray(match.players)?match.players:[];
    const groups=realtimeGroupedPlayers(match);
    const rows=groups?groups.map(([team,members])=>`<div class="realtime-team-group"><span class="realtime-team-label">队伍 ${escapeHtml(team)}</span>${members.map(({player,index})=>realtimePlayerRow(player,index)).join('')}</div>`).join(''):players.map((player,index)=>realtimePlayerRow(player,index)).join('');
    const leaderboardKey=String(match.leaderboard||'').trim().toLowerCase();
    const ranked=!leaderboardKey||leaderboardKey==='unranked'||leaderboardKey.startsWith('qp_')?'非排位':'排位';
    const mode=realtimeLeaderboardName(match.leaderboard) || '自定义对局';
    const activity='游戏中';
    const watch=`<a class="realtime-watch-link" href="aoe2de://1/${encodeURIComponent(String(match.id||null))}" title="在游戏内观战" aria-label="在游戏内观战">👁</a>`;
    const rawMapName = String(match.map || '').trim();
    const displayedMapName = mapDisplayName(rawMapName || '未知地图');
    const knownMap = Boolean(rawMapName) && (displayedMapName !== rawMapName || Object.values(mapNamesZh).includes(rawMapName));
    const mapImage = knownMap ? aoe2MapImageUrl(rawMapName) : '';
    const mapImageMarkup = mapImage ? `<img class="realtime-map-thumbnail" src="${escapeHtml(`${mapImage}?v=rgba`)}" alt="" loading="lazy" onerror="this.hidden=true">` : '';
    return `<article class="realtime-match-card"><div class="realtime-match-top"><span class="realtime-match-live-dot"></span><strong>${escapeHtml(displayedMapName)}</strong>${mapImageMarkup}<time>${realtimeElapsed(match.started)}</time>${watch}</div><div class="realtime-match-players${groups?' is-team-game':''}">${rows}</div><div class="realtime-match-tags"><span>● ${activity}</span><span>◇ ${escapeHtml(mode)}</span><span>⚔ ${ranked}</span><span>▣ ${escapeHtml(realtimeServerName(match.server||''))}</span></div></article>`;
  }).join('');
}

async function loadRealtimeStates() {
  if (!/^\/realtime\/?$/.test(location.pathname)) return;
  const requestId = ++realtimeRequestId;
  try {
    realtimeRequest?.abort?.();
    realtimeRequest = new AbortController();
    const headers = realtimeLastEtag ? { 'If-None-Match': realtimeLastEtag } : {};
    const response = await fetch('/api/realtime', { cache: 'no-cache', headers, signal: realtimeRequest.signal });
    if (response.status === 304) return;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (requestId === realtimeRequestId) {
      realtimeLastEtag = response.headers.get('etag') || realtimeLastEtag;
      realtimeLastVersion = payload?.checkedAt || null;
      renderRealtimeCards(payload);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      const container = document.querySelector('#realtimePlayers');
      const loading = document.querySelector('#realtimeLoading');
      if (container && requestId === realtimeRequestId) {
        if (loading) loading.hidden = true;
        container.hidden = false;
        container.innerHTML = '<div class="realtime-empty"><div class="realtime-empty-icon">!</div><h3>实时对局暂时无法更新</h3><p>稍后会自动重试。</p></div>';
      }
    }
  }
}
async function checkRealtimeVersion() {
  if (!/^\/realtime\/?$/.test(location.pathname)) return;
  try {
    realtimeVersionRequest?.abort?.();
    realtimeVersionRequest = new AbortController();
    const response = await fetch('/api/realtime/version', { cache: 'no-store', signal: realtimeVersionRequest.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!realtimeLastPayload || data?.version !== realtimeLastVersion) await loadRealtimeStates();
    else renderRealtimeCards(realtimeLastPayload);
  } catch (error) {
    if (error?.name !== 'AbortError' && !realtimeLastPayload) await loadRealtimeStates();
  }
}
function showRealtimeLoading() {
  const loading = document.querySelector('#realtimeLoading');
  const statusPanel = document.querySelector('#realtimeStatusPanel');
  const container = document.querySelector('#realtimePlayers');
  if (loading) loading.hidden = false;
  if (statusPanel) statusPanel.hidden = true;
  if (container) container.hidden = true;
}
function startRealtimePolling() {
  clearInterval(realtimePollTimer);
  if (realtimeLastPayload) {
    renderRealtimeCards(realtimeLastPayload);
  } else {
    showRealtimeLoading();
  }
  // The browser only reads the server cache. The server's single scheduled
  // refresh loop is the only path that calls the upstream match API.
  checkRealtimeVersion();
  realtimePollTimer = setInterval(checkRealtimeVersion, 5 * 1000);
}

let lastCountedPageView = '';
function renderSiteStats(data) {
  const users = document.querySelector('#todayUsers');
  const views = document.querySelector('#todayViews');
  if (users) users.textContent = Number(data?.users || 0).toLocaleString('zh-CN');
  if (views) views.textContent = Number(data?.views || 0).toLocaleString('zh-CN');
}
async function loadSiteStats() {
  try {
    const response = await fetch('/api/site-stats', { cache: 'default' });
    if (!response.ok) throw new Error('访问统计请求失败');
    renderSiteStats(await response.json());
  } catch {}
}
async function recordCurrentPageView() {
  const route = `${location.pathname}${location.search}`;
  if (lastCountedPageView === route) return;
  lastCountedPageView = route;
  try {
    const response = await fetch('/api/page-view', { method: 'POST', cache: 'no-store' });
    if (!response.ok) throw new Error('访问记录失败');
    renderSiteStats(await response.json());
  } catch {
    loadSiteStats();
  }
}

const feedbackForm = document.querySelector('#feedbackForm');
const feedbackContent = document.querySelector('#feedbackContent');
const feedbackCounter = document.querySelector('#feedbackCounter');
const feedbackSubmit = document.querySelector('#feedbackSubmit');
const feedbackStatusText = document.querySelector('#feedbackStatus');
function setFeedbackStatus(message, kind = '') {
  if (!feedbackStatusText) return;
  feedbackStatusText.textContent = message;
  feedbackStatusText.className = `feedback-status${kind ? ` is-${kind}` : ''}`;
}
function updateFeedbackCounter() {
  if (!feedbackCounter || !feedbackContent) return;
  feedbackCounter.textContent = `${[...feedbackContent.value].length} / 1000`;
}
async function loadFeedbackStatus() {
  try {
    const response = await fetch('/api/feedback', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取反馈状态失败');
    if (feedbackSubmit) feedbackSubmit.disabled = data.remaining <= 0;
    setFeedbackStatus(data.remaining > 0 ? `今天还可以提交 ${data.remaining} 次` : '今天的反馈提交次数已用完，请明天再试');
  } catch (error) {
    setFeedbackStatus(error.message || '暂时无法读取反馈状态', 'error');
  }
}
feedbackContent?.addEventListener('input', updateFeedbackCounter);
feedbackForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const content = feedbackContent?.value.trim() || '';
  if (!content) return setFeedbackStatus('请输入建议或反馈', 'error');
  if (feedbackSubmit) feedbackSubmit.disabled = true;
  setFeedbackStatus('正在提交…');
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || '提交失败');
      error.status = response.status;
      throw error;
    }
    if (feedbackContent) feedbackContent.value = '';
    updateFeedbackCounter();
    setFeedbackStatus(`✓ 提交成功！今天还可以提交 ${data.remaining} 次`, 'success');
    if (feedbackSubmit) feedbackSubmit.disabled = data.remaining <= 0;
  } catch (error) {
    setFeedbackStatus(error.message || '提交失败，请稍后再试', 'error');
    if (feedbackSubmit) feedbackSubmit.disabled = error.status === 429;
  }
});

let eventsPayload = null;
let eventsTournamentsPayload = null;
let eventsSelectedTab = 'upcoming';
let eventsPollTimer = null;
let eventsCountryFilter = 'all';
let eventsTournamentFilter = 'all';
const eventTierDefinitions = [['S-Tier', 'S级'], ['A-Tier', 'A级'], ['B-Tier', 'B级'], ['C-Tier', 'C级'], ['Showm.', '表演赛'], ['Other', '其它']];
const eventsTierStorageKey = 'aoe2de:events-tier-filter:v1';
let eventsTierFilter = new Set(eventTierDefinitions.map(([value]) => value));
try {
  const savedTiers = JSON.parse(localStorage.getItem(eventsTierStorageKey) || 'null');
  if (Array.isArray(savedTiers)) {
    const validTiers = new Set(eventTierDefinitions.map(([value]) => value));
    eventsTierFilter = new Set(savedTiers.filter(value => validTiers.has(value)));
  }
} catch {}
let eventsRefreshRemaining = 60;
let eventsLoading = false;
const eventsDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short'
});
const eventsRegionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['zh-CN'], { type: 'region' }) : null;

function eventCountryName(opponent) {
  const code = String(opponent?.countryCode || '').toUpperCase();
  if (code === 'HK') return '中国香港';
  if (code === 'TW') return '中国台湾';
  if (code && eventsRegionNames) {
    try {
      const translated = eventsRegionNames.of(code);
      if (translated && translated !== code) return translated;
    } catch {}
  }
  return String(opponent?.country || code || '国家 / 地区未知');
}

function eventCountryKey(opponent) {
  const code = String(opponent?.countryCode || '').toUpperCase();
  return code || String(opponent?.country || '').trim();
}

function eventCountryEmoji(countryCode) {
  const rawCode = String(countryCode || '').toUpperCase();
  const code = rawCode === 'HK' || rawCode === 'TW' ? 'CN' : rawCode;
  return /^[A-Z]{2}$/.test(code) ? [...code].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('') : '🌐';
}

function eventStatusLabel(match) {
  if (match.status === 'completed') return '已结束';
  if (match.status === 'ongoing') return '进行中';
  const milliseconds = Number(match.timestamp || 0) * 1000 - Date.now();
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}天${hours % 24}小时后`;
  return `${hours}小时${minutes % 60}分钟后`;
}

function eventOpponentMarkup(opponent, score, side) {
  const name = escapeHtml(opponent?.name || '待定');
  const nameMarkup = opponent?.url
    ? `<a href="${escapeHtml(opponent.url)}" target="_blank" rel="noopener noreferrer">${name}</a>`
    : `<strong>${name}</strong>`;
  const countryName = eventCountryName(opponent);
  const countryCode = String(opponent?.countryCode || '').toUpperCase();
  const flagSource = countryCode === 'TW' ? 'https://flagcdn.com/w40/cn.png' : opponent?.flag;
  const flag = flagSource
    ? `<img class="events-country-flag" src="${escapeHtml(flagSource)}" alt="${escapeHtml(countryName)}国旗" loading="lazy" referrerpolicy="no-referrer">`
    : `<span class="events-country-flag is-emoji" aria-hidden="true">${eventCountryEmoji(opponent?.countryCode)}</span>`;
  const country = `<small>${flag}<span>${escapeHtml(countryName)}</span></small>`;
  const infoMarkup = `<div>${nameMarkup}${country}</div>`;
  return `<div class="events-opponent is-${side}${opponent?.winner ? ' is-winner' : ''}${opponent?.loser ? ' is-loser' : ''}">${infoMarkup}</div>`;
}

function eventCardMarkup(match) {
  const start = Number(match.timestamp || 0) > 0 ? new Date(Number(match.timestamp) * 1000) : null;
  const timeText = start && Number.isFinite(start.getTime()) ? eventsDateFormatter.format(start) : '时间待定';
  const opponents = Array.isArray(match.opponents) ? match.opponents : [];
  const scores = Array.isArray(match.score) ? match.score : ['', ''];
  const hasScore = scores.some(score => score !== '' && score !== null && score !== undefined);
  const scoreLine = hasScore ? `${scores[0] ?? 0}:${scores[1] ?? 0}` : '—';
  const center = `<span class="events-scoreline"><b>${escapeHtml(scoreLine)}</b>${match.bestOf ? `<small>BO${Number(match.bestOf)}</small>` : ''}</span>`;
  const tournamentName = escapeHtml(match.tournament?.name || '未命名赛事');
  const tournament = match.tournament?.url
    ? `<a href="${escapeHtml(match.tournament.url)}" target="_blank" rel="noopener noreferrer">${tournamentName}</a>`
    : `<span>${tournamentName}</span>`;
  const logoLight = match.tournament?.logoLight || match.tournament?.logo || '';
  const logoDark = match.tournament?.logoDark || logoLight;
  const tournamentLogo = logoLight && logoDark && logoLight !== logoDark
    ? `<span class="events-tournament-logo"><img class="events-logo-light" src="${escapeHtml(logoLight)}" alt="" loading="lazy" referrerpolicy="no-referrer"><img class="events-logo-dark" src="${escapeHtml(logoDark)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    : (logoLight || logoDark) ? `<span class="events-tournament-logo"><img src="${escapeHtml(logoLight || logoDark)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : '';
  const statusClass = match.status === 'ongoing' ? ' is-live' : match.status === 'completed' ? ' is-completed' : '';
  return `<article class="events-match-card${statusClass}"><div class="events-match-meta"><time datetime="${escapeHtml(match.startTime || '')}">${escapeHtml(timeText)}</time><span>${escapeHtml(eventStatusLabel(match))}</span></div><div class="events-matchup">${eventOpponentMarkup(opponents[0], scores[0], 'left')}${center}${eventOpponentMarkup(opponents[1], scores[1], 'right')}</div><div class="events-tournament">${tournamentLogo}${tournament}</div></article>`;
}

function refreshEventFilterOptions() {
  if (!eventsPayload) return;
  const allMatches = eventsSelectedTab === 'completed'
    ? (eventsPayload.completed || [])
    : (eventsPayload.upcoming || []);
  const countries = new Map();
  const tournaments = new Set();
  allMatches.forEach(match => {
    (match.opponents || []).forEach(opponent => {
      const key = eventCountryKey(opponent);
      if (key && !countries.has(key)) countries.set(key, { name: key === 'CN' ? '中国' : eventCountryName(opponent), code: key });
    });
    if (match.tournament?.name) tournaments.add(match.tournament.name);
  });
  const countrySelect = document.querySelector('#eventsCountryFilter');
  const tournamentSelect = document.querySelector('#eventsTournamentFilter');
  if (countrySelect) {
    countrySelect.innerHTML = '<option value="all">全部国家 / 地区</option>' + [...countries.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-CN')).map(([value, item]) => `<option value="${escapeHtml(value)}" aria-label="${escapeHtml(item.name)}">${eventCountryEmoji(item.code)} ${escapeHtml(item.name)}</option>`).join('');
    if ([...countrySelect.options].some(option => option.value === eventsCountryFilter)) countrySelect.value = eventsCountryFilter;
    else eventsCountryFilter = countrySelect.value = 'all';
  }
  if (tournamentSelect) {
    const tierOrder = ['S-Tier', 'A-Tier', 'B-Tier', 'C-Tier', 'Showm.'];
    const tierByTournament = new Map((eventsTournamentsPayload?.tournaments || []).map(item => [item.name, item.tier || 'Other']));
    const orderedTournaments = [...tournaments].sort((a, b) => {
      const ai = tierOrder.indexOf(tierByTournament.get(a)); const bi = tierOrder.indexOf(tierByTournament.get(b));
      const rankA = ai < 0 ? 99 : ai; const rankB = bi < 0 ? 99 : bi;
      return rankA - rankB || a.localeCompare(b, 'zh-CN');
    });
    tournamentSelect.innerHTML = '<option value="all">全部赛事</option>' + orderedTournaments.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    if ([...tournamentSelect.options].some(option => option.value === eventsTournamentFilter)) tournamentSelect.value = eventsTournamentFilter;
    else eventsTournamentFilter = tournamentSelect.value = 'all';
  }
  renderEventTierButtons();
}

function eventTierCategory(tier) {
  return ['S-Tier', 'A-Tier', 'B-Tier', 'C-Tier', 'Showm.'].includes(tier) ? tier : 'Other';
}

function renderEventTierButtons() {
  const target = document.querySelector('#eventsTierButtons');
  if (!target) return;
  target.innerHTML = eventTierDefinitions.map(([value, label]) => `<button type="button" class="events-tier-button${eventsTierFilter.has(value) ? ' selected' : ''}" data-events-tier="${escapeHtml(value)}" aria-pressed="${eventsTierFilter.has(value)}">${label}</button>`).join('');
  target.querySelectorAll('[data-events-tier]').forEach(button => button.addEventListener('click', () => {
    const value = button.dataset.eventsTier;
    if (!value) return;
    if (eventsTierFilter.has(value)) eventsTierFilter.delete(value);
    else eventsTierFilter.add(value);
    try { localStorage.setItem(eventsTierStorageKey, JSON.stringify([...eventsTierFilter])); } catch {}
    renderEventTierButtons();
    renderEvents();
    renderEventsTournaments();
  }));
}

function eventTournamentTier(name, url = '') {
  const normalize = value => String(value || '').replace(/\s+-\s+(?:Bracket|Group|Round|Stage)\s*\d+.*$/i, '').trim();
  const pathOf = value => { try { return new URL(value).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };
  const matchPath = pathOf(url);
  const item = (eventsTournamentsPayload?.tournaments || []).find(entry => entry.name === name)
    || (matchPath && (eventsTournamentsPayload?.tournaments || []).find(entry => { const path = pathOf(entry.url); return path && (matchPath === path || matchPath.startsWith(`${path}/`)); }))
    || (eventsTournamentsPayload?.tournaments || []).find(entry => normalize(entry.name) === normalize(name));
  return item?.tier || '';
}

function renderEvents() {
  const list = document.querySelector('#eventsList');
  if (!list || !eventsPayload) return;
  const upcoming = Array.isArray(eventsPayload.upcoming) ? eventsPayload.upcoming : [];
  const completed = Array.isArray(eventsPayload.completed) ? eventsPayload.completed : [];
  document.querySelector('#eventsUpcomingCount').textContent = upcoming.length.toLocaleString('zh-CN');
  document.querySelector('#eventsCompletedCount').textContent = completed.length.toLocaleString('zh-CN');
  const updated = document.querySelector('#eventsUpdated');
  const fetchedAt = new Date(eventsPayload.fetchedAt || 0);
  if (updated) updated.textContent = Number.isFinite(fetchedAt.getTime())
    ? `更新于 ${fetchedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`
    : '更新时间未知';
  const selectedMatches = eventsSelectedTab === 'completed' ? completed : upcoming;
  const matches = selectedMatches.filter(match => {
    const matchesCountry = eventsCountryFilter === 'all' || (match.opponents || []).some(opponent => eventCountryKey(opponent) === eventsCountryFilter);
    const matchesTournament = eventsTournamentFilter === 'all' || match.tournament?.name === eventsTournamentFilter;
    const matchesTier = eventsTierFilter.has(eventTierCategory(eventTournamentTier(match.tournament?.name, match.tournament?.url)));
    return matchesCountry && matchesTournament && matchesTier;
  });
  list.innerHTML = matches.length ? matches.map(eventCardMarkup).join('') : '<div class="events-empty">当前没有符合条件的比赛</div>';
}

function renderEventsTournaments() {
  const target = document.querySelector('#eventsTournamentsList');
  if (!target || !eventsTournamentsPayload) return;
  const items = (Array.isArray(eventsTournamentsPayload.tournaments) ? eventsTournamentsPayload.tournaments : []).filter(item => eventsTierFilter.has(eventTierCategory(item.tier)));
  const statusText = { Ongoing: '进行中', Upcoming: '即将开始', Completed: '已结束' };
  const tierText = { 'S-Tier': 'S级', 'A-Tier': 'A级', 'B-Tier': 'B级', 'C-Tier': 'C级', 'Showm.': '表演赛' };
  const monthText = { Jan: '1月', Feb: '2月', Mar: '3月', Apr: '4月', May: '5月', Jun: '6月', Jul: '7月', Aug: '8月', Sep: '9月', Oct: '10月', Nov: '11月', Dec: '12月' };
  const translateDates = value => String(value || '日期待定').replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, month => monthText[month] || month).replace(/月\s+/g, '月').replace(/(?<!\d)(\d{1,2})(?=\s*(?:[-–]|$))/g, '$1日').replace(/日\s*[-–]\s*/g, '日–');
  const groups = ['Ongoing', 'Upcoming', 'Completed'].map(status => ({ status, items: items.filter(item => item.status === status) })).filter(group => group.items.length);
  const card = item => `<article class="events-tournament-card"><div class="events-tournament-card-body"><b class="events-tournament-tier">${escapeHtml(tierText[item.tier] || '其它')}</b><h4>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a>` : escapeHtml(item.name)}</h4><small>${escapeHtml(translateDates(item.dates))}</small></div></article>`;
  target.innerHTML = groups.length ? groups.map(group => `<section class="events-tournament-group"><h4 class="events-tournament-group-title"><span>${statusText[group.status] || group.status}</span><b>${group.items.length}</b></h4><div class="events-tournament-group-list">${group.items.map(card).join('')}</div></section>`).join('') : '<div class="events-empty">暂无赛事列表</div>';
}

async function loadEvents() {
  if (eventsLoading) return;
  eventsLoading = true;
  try {
    const [response, tournamentsResponse] = await Promise.all([fetch('/api/events', { cache: 'default' }), fetch('/api/tournaments', { cache: 'default' })]);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '赛事信息请求失败');
    eventsPayload = data;
    if (tournamentsResponse.ok) eventsTournamentsPayload = await tournamentsResponse.json();
    refreshEventFilterOptions();
    renderEvents();
    renderEventsTournaments();
  } catch (error) {
    const list = document.querySelector('#eventsList');
    if (list && !eventsPayload) list.innerHTML = `<div class="events-empty is-error">赛事信息暂时无法加载：${escapeHtml(error.message || '')}</div>`;
  } finally {
    eventsLoading = false;
    eventsRefreshRemaining = 60;
    updateEventsCountdown();
  }
}

function updateEventsCountdown() {
  const countdown = document.querySelector('#eventsRefreshCountdown');
  if (countdown) countdown.textContent = `${Math.max(0, eventsRefreshRemaining)}s 后刷新`;
}

function startEventsPolling() {
  clearInterval(eventsPollTimer);
  eventsRefreshRemaining = 60;
  updateEventsCountdown();
  loadEvents();
  eventsPollTimer = setInterval(() => {
    eventsRefreshRemaining -= 1;
    if (eventsRefreshRemaining <= 0) loadEvents();
    updateEventsCountdown();
  }, 1_000);
}

document.querySelectorAll('[data-events-tab]').forEach(button => button.addEventListener('click', () => {
  eventsSelectedTab = button.dataset.eventsTab === 'completed' ? 'completed' : 'upcoming';
  document.querySelectorAll('[data-events-tab]').forEach(candidate => {
    const selected = candidate === button;
    candidate.classList.toggle('selected', selected);
    candidate.setAttribute('aria-selected', String(selected));
  });
  refreshEventFilterOptions();
  renderEvents();
}));

document.querySelector('#eventsCountryFilter')?.addEventListener('change', event => {
  eventsCountryFilter = event.target.value || 'all';
  renderEvents();
});
document.querySelector('#eventsTournamentFilter')?.addEventListener('change', event => {
  eventsTournamentFilter = event.target.value || 'all';
  renderEvents();
  renderEventsTournaments();
});

function renderCurrentRoute(selectedPlayer = null) {
  recordCurrentPageView();
  const match = location.pathname.match(/^\/profile(?:\/(\d+))?\/?$/);
  const isProfilePage = Boolean(match);
  const isMediaVideosPage = /^\/media\/videos\/?$/.test(location.pathname);
  const isMediaPage = isMediaVideosPage || /^\/media\/?$/.test(location.pathname);
  const isUpdatesPage = /^\/updates\/?$/.test(location.pathname);
  const isRealtimePage = /^\/realtime\/?$/.test(location.pathname);
  const isEventsPage = /^\/events\/?$/.test(location.pathname);
  const isFeedbackPage = /^\/feedback\/?$/.test(location.pathname);
  const buildOrderMatch = location.pathname.match(/^\/build-orders(?:\/([a-z0-9-]+))?\/?$/i);
  const isBuildOrdersPage = Boolean(buildOrderMatch);
  const buildOrderSlug = buildOrderMatch?.[1] || '';
  const profileId = match?.[1] || '';
  syncUpdatesBackToTop();
  document.body.classList.toggle('page-profile', isProfilePage);
  document.body.classList.toggle('page-media', isMediaPage);
  document.body.classList.toggle('page-updates', isUpdatesPage);
  document.body.classList.toggle('page-realtime', isRealtimePage);
  document.body.classList.toggle('page-events', isEventsPage);
  document.body.classList.toggle('page-build-orders', isBuildOrdersPage);
  document.body.classList.toggle('page-feedback', isFeedbackPage);

  // Give each module its own stable random artwork choice. The choice is
  // stored locally so revisiting a module keeps its image, while different
  // modules can still receive different artwork.
  const moduleArtworkKey = 'aoe2de:module-artwork:v5';
  const moduleArtworkFiles = [
    ...Array.from({ length: 6 }, (_, index) => `/assets/module-random/${index + 1}.webp`),
    ...Array.from({ length: 5 }, (_, index) => `/assets/module-${index + 1}.webp`)
  ];
  const moduleName = isProfilePage ? 'profile' : isMediaPage ? 'media' : isUpdatesPage ? 'updates' : isRealtimePage ? 'realtime' : isEventsPage ? 'events' : isBuildOrdersPage ? 'build-orders' : isFeedbackPage ? 'feedback' : 'leaderboard';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(moduleArtworkKey) || '{}'); } catch {}
  const order = Array.isArray(saved.order) && saved.order.length === moduleArtworkFiles.length
    ? saved.order
    : moduleArtworkFiles.map((_, index) => index).sort(() => Math.random() - 0.5);
  const moduleSlots = ['leaderboard', 'profile', 'realtime', 'events', 'media', 'updates', 'build-orders', 'feedback'];
  const slot = Math.max(0, moduleSlots.indexOf(moduleName));
  const selected = order[slot % moduleArtworkFiles.length];
  document.documentElement.style.setProperty('--module-art-image', `url("${moduleArtworkFiles[selected]}")`);
  document.documentElement.style.setProperty(`--module-art-${moduleName}`, `url("${moduleArtworkFiles[selected]}")`);
  document.documentElement.dataset.moduleArtwork = moduleName;
  const moduleArtworkStyleId = 'module-artwork-inline-style';
  let moduleArtworkStyle = document.getElementById(moduleArtworkStyleId);
  if (!moduleArtworkStyle) {
    moduleArtworkStyle = document.createElement('style');
    moduleArtworkStyle.id = moduleArtworkStyleId;
    document.head.appendChild(moduleArtworkStyle);
  }
  const moduleSelector = moduleName === 'leaderboard'
    ? 'body:not(.page-profile):not(.page-media):not(.page-updates):not(.page-realtime):not(.page-events):not(.page-build-orders):not(.page-feedback)'
    : `body.page-${moduleName}`;
  moduleArtworkStyle.textContent = `${moduleSelector} #leaderboard:before{background-image:linear-gradient(90deg,var(--bg) 0%,rgba(16,19,16,.54) 30%,rgba(16,19,16,.08)),url("${moduleArtworkFiles[selected]}")!important}`;
  try { localStorage.setItem(moduleArtworkKey, JSON.stringify({ order })); } catch {}
  const image = new Image();
  image.src = moduleArtworkFiles[selected];
  document.querySelector('#player-profile').hidden = !isProfilePage;
  document.querySelector('#media-page').hidden = !isMediaPage;
  document.querySelector('#updates-page').hidden = !isUpdatesPage;
  document.querySelector('#realtime-page').hidden = !isRealtimePage;
  document.querySelector('#events-page').hidden = !isEventsPage;
  document.querySelector('#build-orders-page').hidden = !isBuildOrdersPage;
  document.querySelector('#feedback-page').hidden = !isFeedbackPage;
  document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(link => {
    const activePage = isProfilePage ? 'profile' : isRealtimePage ? 'realtime' : isEventsPage ? 'events' : isMediaPage ? 'media' : isUpdatesPage ? 'updates' : isBuildOrdersPage ? 'build-orders' : isFeedbackPage ? 'feedback' : 'leaderboard';
    const active = link.dataset.page === activePage;
    link.classList.toggle('active', active);
  });
  document.querySelector('.breadcrumbs b').textContent = isProfilePage ? '玩家资料' : isRealtimePage ? '实时对局' : isEventsPage ? '赛事信息' : isMediaPage ? (isMediaVideosPage ? '全部视频' : '视频直播') : isUpdatesPage ? '更新汇总' : isBuildOrdersPage ? (buildOrderSlug ? '开局指南详情' : '开局指南') : isFeedbackPage ? '反馈区' : '天梯榜单';
  if (!isRealtimePage) { clearInterval(realtimePollTimer); realtimePollTimer = null; realtimeRequest?.abort?.(); realtimeVersionRequest?.abort?.(); }
  if (!isEventsPage) { clearInterval(eventsPollTimer); eventsPollTimer = null; }
  if (isMediaPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    loadMedia(isMediaVideosPage);
    return;
  }
  if (isRealtimePage) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    profileDetailsRequestId++;
    startRealtimePolling();
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    return;
  }
  if (isEventsPage) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    startEventsPolling();
    return;
  }
  if (isUpdatesPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    loadUpdates();
    return;
  }
  if (isBuildOrdersPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    loadBuildOrders(buildOrderSlug);
    return;
  }
  if (isFeedbackPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    loadFeedbackStatus();
    return;
  }
  if (!isProfilePage) {
    const saved = history.state?.leaderboard;
    if (saved) {
      selectedLadder = Number(saved.ladder) || 3;
      selectedCountry = String(saved.country || 'all');
      currentPage = Math.max(1, Number(saved.page) || 1);
      persistLeaderboardView();
      ladderChoices.querySelectorAll('.ladder-choice').forEach(choice => {
        const active = Number(choice.dataset.ladder) === selectedLadder;
        choice.classList.toggle('selected', active);
        choice.setAttribute('aria-pressed', String(active));
      });
      const cached = leaderboardData.get(selectedLadder);
      if (cached) displayLeaderboard(cached.data);
    } else {
      ladderChoices.querySelectorAll('.ladder-choice').forEach(choice => {
        const active = Number(choice.dataset.ladder) === selectedLadder;
        choice.classList.toggle('selected', active);
        choice.setAttribute('aria-pressed', String(active));
      });
      if (countryFilter) countryFilter.value = selectedCountry;
    }
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    loadLeaderboard();
    updateCountdown();
    return;
  }
  if (!profileId) {
    const aliasesButton = document.querySelector('#profileAliasesButton');
    if (aliasesButton) aliasesButton.hidden = true;
    setProfileAccountsModal(false);
    if (currentProfileId) return;
    let savedProfileId = '';
    try { savedProfileId = localStorage.getItem(lastProfileIdStorageKey) || ''; } catch { /* Storage may be disabled. */ }
    if (/^\d+$/.test(savedProfileId)) {
      history.replaceState({ ...(history.state || {}), profileId: savedProfileId }, '', `/profile/${encodeURIComponent(savedProfileId)}`);
      return renderCurrentRoute();
    }
    setProfileLoadingAnimation(false);
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    clearTimeout(profileDetailsRetryTimer);
    clearInterval(profileDetailsRequestTimer);
    profileDetailsSocket?.close();
    profileDetailsSocket = null;
    document.querySelector('#profileIdentityName').textContent = '搜索并选择一名玩家';
    document.querySelector('#profileIdentityMeta').textContent = '';
  document.querySelector('#profileIdentityLinks').innerHTML = '';
    document.querySelector('#profileIdentityLastMatch').textContent = '';
    setProfileMessage('请使用页面顶部的搜索框查找并选择玩家。');
    const leaderboardBody = document.querySelector('#profileLeaderboardBody');
    if (leaderboardBody) leaderboardBody.innerHTML = '';
    const matchesBody = document.querySelector('#profileMatchesBody');
    if (matchesBody) matchesBody.innerHTML = '<div class="profile-matches-empty">请使用页面顶部的搜索框查找并选择玩家。</div>';
    const matchesMore = document.querySelector('#profileMatchesMore');
    if (matchesMore) { matchesMore.hidden = true; matchesMore.disabled = false; matchesMore.onclick = null; }
    return;
  }
  currentProfileId = String(profileId);
  const aliasesButton = document.querySelector('#profileAliasesButton');
  if (aliasesButton) aliasesButton.hidden = false;
  setProfileAccountsModal(false);
  try { localStorage.setItem(lastProfileIdStorageKey, currentProfileId); } catch { /* Storage may be disabled. */ }
  if (selectedPlayer) {
    document.querySelector('#profileIdentityName').textContent = selectedPlayer.name || `玩家 ${profileId}`;
    document.querySelector('#profileIdentityMeta').innerHTML = `${profileCountryMarkup(selectedPlayer.country)}<span class="profile-country-separator">·</span><span class="profile-team-inline">${escapeHtml(selectedPlayer.clan || '暂无战队')}</span>`;
  }
  loadProfileLeaderboards(profileId);
  loadAoE2RecsProfile(profileId, selectedPlayer?.name || history.state?.name || '');
}
function loadAoE2RecsProfile(profileId, fallbackName = '') {
  clearTimeout(profileDetailsTimeout);
  clearTimeout(profileDetailsRetryTimer);
  clearInterval(profileDetailsRequestTimer);
  profileDetailsSocket?.close();
  const requestId = ++profileDetailsRequestId;
  profileMatchesRequestId = requestId;
  currentProfileAvatarUrl = '';
  currentProfileLeaderboardRows = [];
  currentProfileRecentResults = new Map();
  currentProfileRecentStats = new Map();
  currentProfileRecentModeCounts = null;
  renderProfileModeCharts();
  setProfileLoadingAnimation(false);
  loadWorldsEdgeMatches(profileId, { player: { id: profileId }, matches: [] }, requestId);
  loadProfileAccounts(profileId, requestId);
  const profileName = document.querySelector('#profileIdentityName');
  profileName.textContent = fallbackName || `玩家 ${profileId}`;
  document.querySelector('#profileIdentityLinks').innerHTML = '';
  const matchesBody = document.querySelector('#profileMatchesBody');
  const matchesMore = document.querySelector('#profileMatchesMore');
  if (matchesBody) matchesBody.innerHTML = profileLoadingMarkup();
  if (matchesMore) { matchesMore.hidden = true; matchesMore.disabled = false; matchesMore.onclick = null; }
  const localProfile = readAoE2RecsProfileCache(profileId);
  if (localProfile) {
    renderAoE2RecsProfile(localProfile, profileId, fallbackName, requestId);
  } else {
    setProfileMessage(profileSectionLoadingMarkup());
  }
  const controller = new AbortController();
  profileDetailsTimeout = setTimeout(() => controller.abort(), 150_000);
  if (localProfile) return;
  fetch(`/api/profile-details?id=${encodeURIComponent(profileId)}`, { cache: 'no-store', signal: controller.signal })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(data => {
      if (requestId !== profileDetailsRequestId || !data || typeof data !== 'object') return;
      clearTimeout(profileDetailsTimeout);
      if (!data.player && !Array.isArray(data.accounts)) throw new Error('资料格式无效');
      if (!data.stale) saveAoE2RecsProfileCache(profileId, data);
      renderAoE2RecsProfile(data, profileId, fallbackName, requestId);
    })
    .catch(error => {
      if (requestId !== profileDetailsRequestId) return;
      setProfileLoadingAnimation(false);
      clearTimeout(profileDetailsTimeout);
      setProfileMessage(error.name === 'AbortError' ? '加载失败（已重试 10 次），请稍后再试。' : '加载失败（已重试 10 次），请稍后再试。', 'profile-details-error');
    });
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
  const target = link.dataset.page === 'profile' ? '/profile' : link.dataset.page === 'realtime' ? '/realtime' : link.dataset.page === 'events' ? '/events' : link.dataset.page === 'media' ? '/media' : link.dataset.page === 'updates' ? '/updates' : link.dataset.page === 'build-orders' ? '/build-orders' : link.dataset.page === 'feedback' ? '/feedback' : '/';
  history.pushState({}, '', target);
  renderCurrentRoute();
}));
document.addEventListener('click', event => {
  const link = event.target.closest('.player-name');
  if (!link || link.tagName !== 'A' || location.pathname.startsWith('/profile')) return;
  const row = link.closest('.player-row');
  const profileId = row?.dataset.profile;
  const player = currentRows.find(item => String(item.profileId) === String(profileId));
  if (!player) return;
  event.preventDefault();
  routeToPlayerProfile(player);
});
window.addEventListener('popstate', () => renderCurrentRoute());
renderCurrentRoute();
refreshProfileSearchStatus();
setInterval(refreshProfileSearchStatus, 5000);
setInterval(loadSiteStats, 60_000);
