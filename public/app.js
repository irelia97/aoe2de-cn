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
const leaderboardLocalCachePrefix = 'aoe2de:leaderboard-cache:v3:';
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
    fetchJsonWithRetries(`/api/avatar?v=2&steamId=${encodeURIComponent(steamId)}`, { cache: 'default' }).then(data => {
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
  const summaryTime = summary?.dataUpdatedAt || summary?.updatedAt;
  const summaryTitle = summary?.source === 'aoe2companion-leaderboard-parquet' ? '每日榜单统计' + (summaryTime ? ' · 数据时间：' + new Date(summaryTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '（北京时间）' : '') : '';
  for (const id of ['statAverage', 'statPlayers', 'statTop100']) document.querySelector('#' + id).title = summaryTitle;
  document.querySelector('#statAverage').textContent = summary && summary.averageRating != null && Number.isFinite(Number(summary.averageRating)) ? Number(summary.averageRating).toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '-';
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
let profileDetailsTimeout = null;

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
const profilePlatformIconMarkup = {"bilibili.svg":"<svg aria-hidden=\"true\" fill=\"#00A1D6\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Bilibili</title><path d=\"M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z\"/></svg>","discord.svg":"<svg aria-hidden=\"true\" fill=\"#5865F2\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Discord</title><path d=\"M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z\"/></svg>","douyin.svg":"<svg aria-hidden=\"true\" width=\"91\" height=\"34\" viewBox=\"0 0 91 34\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<g clip-path=\"url(#clip0)\">\n<path d=\"M11.6394 13.4341V12.1233C11.184 12.0686 10.7286 12.0322 10.255 12.0322C4.60798 12.0322 -0.000732422 16.6203 -0.000732422 22.2825C-0.000732422 25.7417 1.72981 28.8186 4.37116 30.6756C2.65884 28.8368 1.62052 26.3971 1.62052 23.7026C1.63873 18.1132 6.10171 13.5616 11.6394 13.4341Z\" fill=\"#00FAF0\"/>\n<path d=\"M11.8766 28.345C14.3905 28.345 16.4489 26.3423 16.54 23.848V1.5451H20.6205C20.5294 1.08994 20.4929 0.616574 20.4929 0.125H14.9188V22.4279C14.8277 24.9222 12.7692 26.9249 10.2554 26.9249C9.47209 26.9249 8.72522 26.7246 8.08765 26.3787C8.94381 27.5803 10.3282 28.345 11.8766 28.345Z\" fill=\"#00FAF0\"/>\n<path d=\"M28.2514 9.11927V7.88124C26.7031 7.88124 25.2458 7.42608 24.0253 6.625C25.1182 7.86304 26.5938 8.75514 28.2514 9.11927Z\" fill=\"#00FAF0\"/>\n<path d=\"M24.0449 6.6255C22.8609 5.26002 22.1323 3.49399 22.1323 1.5459H20.6385C21.0393 3.65785 22.2962 5.4785 24.0449 6.6255Z\" fill=\"#FF0050\"/>\n<path d=\"M10.2551 17.5847C7.66836 17.5847 5.57349 19.6784 5.57349 22.2637C5.57349 24.0662 6.5936 25.6137 8.08733 26.3966C7.54084 25.6319 7.19473 24.6852 7.19473 23.6656C7.19473 21.0803 9.28961 18.9866 11.8763 18.9866C12.3499 18.9866 12.8236 19.0594 13.2608 19.205V13.5246C12.8054 13.47 12.3499 13.4336 11.8763 13.4336C11.8035 13.4336 11.7124 13.4336 11.6395 13.4336V17.8031C11.2023 17.6575 10.7469 17.5847 10.2551 17.5847Z\" fill=\"#FF0050\"/>\n<path d=\"M28.2523 9.11914V13.4523C25.356 13.4523 22.6964 12.5238 20.5104 10.958V22.2642C20.5104 27.9082 15.9199 32.5144 10.2547 32.5144C8.06873 32.5144 6.04672 31.8226 4.38904 30.6574C6.26531 32.6601 8.92489 33.9345 11.8941 33.9345C17.5412 33.9345 22.1499 29.3465 22.1499 23.6843V12.3781C24.3358 13.9439 27.0136 14.8724 29.8918 14.8724V9.30121C29.3271 9.283 28.7806 9.22838 28.2523 9.11914Z\" fill=\"#FF0050\"/>\n<path d=\"M20.5094 22.2648V10.9586C22.6953 12.5244 25.3731 13.4529 28.2513 13.4529V9.11977C26.5754 8.75565 25.1181 7.86354 24.0251 6.6255C22.2763 5.4967 21.0194 3.67605 20.6369 1.5459H16.5564V23.8488C16.4653 26.3431 14.4069 28.3458 11.8931 28.3458C10.3265 28.3458 8.94202 27.5811 8.10407 26.3977C6.61034 25.6148 5.59023 24.0491 5.59023 22.2648C5.59023 19.6795 7.6851 17.5858 10.2718 17.5858C10.7454 17.5858 11.2191 17.6586 11.6562 17.8042V13.4347C6.1185 13.5621 1.65552 18.1138 1.65552 23.6667C1.65552 26.3613 2.69384 28.8191 4.40617 30.6398C6.06385 31.805 8.10408 32.4969 10.2718 32.4969C15.9006 32.5151 20.5094 27.9088 20.5094 22.2648Z\" fill=\"#111111\"/>\n<path d=\"M41.9472 6.10254H39.2989V9.99149H36.2228V12.6384H39.2989V18.0341L36.2228 18.482V21.2715L39.2989 20.8235V25.4455C39.2989 25.812 38.9933 26.1174 38.6266 26.1174H36.4061V28.7643H39.7267C40.949 28.7643 41.9472 27.7666 41.9472 26.545V20.4367L44.6363 20.0295V17.24L41.9472 17.6472V12.6588H44.6363V10.0119H41.9472V6.10254Z\" fill=\"#111111\"/>\n<path d=\"M56.9451 6.10254H54.3171V19.9277L45.5979 20.681V23.4705L54.3171 22.7375V28.9476H56.9451V22.4932L59.6342 22.2488V19.4594L56.9451 19.7037V6.10254Z\" fill=\"#111111\"/>\n<path d=\"M52.951 9.17845L46.6968 8.05859V10.8684L52.951 11.9679V9.17845Z\" fill=\"#111111\"/>\n<path d=\"M52.951 14.9802L46.6968 13.8604V16.6702L52.951 17.79V14.9802Z\" fill=\"#111111\"/>\n<path d=\"M81.1238 13.8204L81.5312 11.6621H78.7403L78.3125 13.8204H71.0193L70.6933 11.6621H67.882L68.2283 13.8204H62.9316V16.4062H86.2983V13.8204H81.1238Z\" fill=\"#111111\"/>\n<path d=\"M85.5649 7.93503H76.7031L76.2549 6.10254H72.8121L73.2602 7.93503H63.665V10.5005H85.5649V7.93503Z\" fill=\"#111111\"/>\n<path d=\"M81.9592 18.3008H67.271C66.0486 18.3008 65.0504 19.2985 65.0504 20.5201V26.5674C65.0504 27.789 66.0486 28.7867 67.271 28.7867H81.9592C83.1815 28.7867 84.1798 27.789 84.1798 26.5674V20.5201C84.1798 19.2985 83.2019 18.3008 81.9592 18.3008ZM68.2081 20.7034H81.0425C81.4092 20.7034 81.7147 21.0088 81.7147 21.3753V22.4544H67.5562V21.3753C67.5358 20.9884 67.8414 20.7034 68.2081 20.7034ZM81.0425 26.4045H68.2081C67.8414 26.4045 67.5358 26.0991 67.5358 25.7326V24.6331H81.6944V25.7326C81.6944 26.0991 81.4092 26.4045 81.0425 26.4045Z\" fill=\"#111111\"/>\n</g>\n<defs>\n<clipPath id=\"clip0\">\n<rect width=\"90.6667\" height=\"33.8753\" fill=\"white\" transform=\"translate(-0.000244141 0.125)\"/>\n</clipPath>\n</defs>\n</svg>\n","facebook_gaming.svg":"<svg aria-hidden=\"true\" fill=\"#005FED\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Facebook Gaming</title><path d=\"M0 0v24h15.67v-7.35H7.35v-9.3H24V0zm8.33 15.68h8.32V24H24V8.32H8.33Z\"/></svg>","kick.svg":"<svg aria-hidden=\"true\" fill=\"#53FC19\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Kick</title><path d=\"M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z\"/></svg>","mixer.svg":"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!-- Generator: Adobe Illustrator 21.1.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n<svg aria-hidden=\"true\" version=\"1.1\" id=\"Layer_1\" xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" x=\"0px\" y=\"0px\"\n\t viewBox=\"0 0 712 220\" style=\"enable-background:new 0 0 712 220;\" xml:space=\"preserve\">\n<style type=\"text/css\">\n\t.st0{fill:#03214F;}\n\t.st1{fill:#1FBAED;}\n</style>\n<g>\n\t<path class=\"st0\" d=\"M257,67.3c-9,0-16.4,7.3-16.4,16.4v117.7c0,2.4,1.9,4.3,4.3,4.3h24.2c2.4,0,4.3-1.9,4.3-4.3V83.7\n\t\tC273.4,74.6,266.1,67.3,257,67.3\"/>\n\t<path class=\"st0\" d=\"M169.4,67.4c-20.1,0-34,8.3-44.3,24.2c-13.7-32.4-60.4-31.7-79.8-1.9C42.3,77,31,67.6,17.5,67.6h-4.1\n\t\tc0,25.1,0,104.8,0,133.8c0,2.4,1.9,4.3,4.3,4.3h24.2c2.4,0,4.3-1.9,4.3-4.3V130c0-18,8.6-35.4,26.4-35.4\n\t\tc16.6,0,24.6,10.6,24.6,32.4v74.3c0,2.4,1.9,4.3,4.3,4.3h24.2c2.4,0,4.3-1.9,4.3-4.3V130c0-17.1,9.6-35.4,26.4-35.4\n\t\tc20.7,0,24.9,14,24.9,35v71.8c0,2.4,1.9,4.3,4.3,4.3h24.3c2.4,0,4.3-1.9,4.3-4.3v-78.8C214.1,89.2,202.3,67.4,169.4,67.4\"/>\n\t<path class=\"st0\" d=\"M329.5,73.5c-5.7-7.7-16.9-8.9-24.2-2.3c-6.3,5.8-6.8,15.6-1.7,22.5l32.9,44.1l-33.1,44.5\n\t\tc-5.1,6.9-4.7,16.7,1.7,22.5c7.3,6.6,18.5,5.4,24.2-2.3l46.2-62.1c1.1-1.5,1.1-3.6,0-5.1L329.5,73.5z\"/>\n\t<path class=\"st1\" d=\"M430.9,73.5c5.7-7.7,16.9-8.9,24.2-2.3c6.3,5.8,6.8,15.6,1.7,22.5l-32.9,44.1l33.1,44.5\n\t\tc5.1,6.9,4.7,16.7-1.7,22.5c-7.3,6.6-18.5,5.4-24.2-2.3L385,140.3c-1.1-1.5-1.1-3.6,0-5.1L430.9,73.5z\"/>\n\t<path class=\"st1\" d=\"M519,102.2c5.7-5.7,12.4-8.6,20.1-8.6c8.4,0,15,2.6,19.7,7.8c4.4,5,6.8,12.2,7,21.6h-57.3\n\t\tC510.1,114.6,513.7,107.6,519,102.2 M572.1,180.2c-1-1.3-2.7-1.8-4.2-1.3c0,0,0,0,0,0c-17.1,5.9-56.6,9.4-59.5-30.6h75.6\n\t\tc8.1,0,14.6-6.5,14.6-14.6c0-18.1-3.3-35.6-15.6-49.1c-30.1-33.3-108.2-20.7-108.2,54.8c0,78.3,73.2,76.6,106.4,61.4\n\t\tc2.5-1.1,3.2-4.3,1.6-6.4L572.1,180.2z\"/>\n\t<path class=\"st1\" d=\"M697.5,69.4L697.5,69.4c-5.8-1.6-15.2-1.2-18.2-0.6c-11.7,3.5-20.3,11.5-25.5,23.6\n\t\tc-1.8-14-13.8-24.8-28.3-24.8h-4.2c0,25.1,0,104.9,0,133.8c0,2.4,1.9,4.3,4.3,4.3h24.2c2.4,0,4.3-1.9,4.3-4.3v-64.8\n\t\tc0-26.8,15.1-45.6,40.7-36.1c2.8,1,5.8-1,5.8-4V73.6C700.7,71.7,699.3,69.9,697.5,69.4\"/>\n\t<path class=\"st0\" d=\"M239.5,26.5c0,9.7,7.9,17.5,17.6,17.5s17.5-7.9,17.5-17.5S266.7,9,257,9S239.5,16.9,239.5,26.5\"/>\n</g>\n</svg>\n","steam.svg":"<svg aria-hidden=\"true\" fill=\"#000000\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Steam</title><path d=\"M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z\"/></svg>","trovo.svg":"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg aria-hidden=\"true\" xmlns=\"http://www.w3.org/2000/svg\" class=\"svg-icon icon-trovo\" viewBox=\"2 2.79 81.1 22\"><path fill=\"#19D66B\" fill-rule=\"evenodd\" clip-rule=\"evenodd\" d=\"M57.6 7.09346C57.9 7.09346 58.1 7.19346 58.1 7.49346L57.7 14.2935L60.9 7.19346C61 6.99346 61.2 6.89346 61.4 6.89346H67.3C67.5 6.89346 67.7 7.09346 67.7 7.29346C67.7 7.39346 67.7 7.39346 67.7 7.49346L60 24.4935C59.9 24.6935 59.7 24.7935 59.5 24.7935H51.3C51 24.7935 50.8 24.5935 50.8 24.2935L51.9 7.59346C51.9 7.29346 52.1 7.09346 52.4 7.09346H57.6ZM29.5 7.09346L29 9.19346C29.7854 8.40805 30.7 7.39346 31.7 7.09346H37C37.269 7.09346 37.5282 7.29346 37.2 7.59346C35.6 8.69346 34.3 9.59346 33.5 10.4935C32.9 11.0935 32.2 12.0935 31.5 13.5935L30.9 15.1935L30.4 16.9935L28.8 24.3935C28.8 24.5935 28.5 24.7935 28.3 24.7935H22.3C22 24.7935 21.8 24.5935 21.8 24.2935V24.1935L25.3 7.49346C25.3 7.29346 25.6 7.09346 25.8 7.09346H29.5ZM41.8 6.99346C46.7 6.99346 50.6 10.8935 50.6 15.7935C50.6 20.6935 46.7 24.5935 41.8 24.5935C36.9 24.5935 33 20.6935 33 15.7935C33 10.8935 36.9 6.99346 41.8 6.99346ZM74.3 6.99346C79.2 6.99346 83.1 10.8935 83.1 15.7935C83.1 20.6935 79.2 24.5935 74.3 24.5935C69.4 24.5935 65.5 20.6935 65.5 15.7935C65.5 10.8935 69.4 6.99346 74.3 6.99346ZM41.8 12.9935C40.2 12.9935 39 14.2935 39 15.7935C39 17.2935 40.3 18.5935 41.8 18.5935C43.3 18.5935 44.6 17.2935 44.6 15.7935C44.6 14.2935 43.4 12.9935 41.8 12.9935ZM17.2 2.79346C17.5 2.79346 17.7 2.99346 17.7 3.29346V3.39346L17 6.59346C17 6.69346 17.1 6.89346 17.2 6.89346C17.2 6.89346 17.2 6.89346 17.3 6.89346H23.7C24 6.89346 24.2923 7.09346 24.2 7.49346L22.7 13.7935C22.6 14.0935 22.4 14.1935 22.1 14.1935L18.6 13.9935C17.5 13.9935 16.3 14.2935 15.4 15.2935C14.2 16.4935 14.1 18.2935 14.6 19.5935C15.1 20.8935 16.5 21.5935 17.9 21.2935C19 21.0935 19.6 19.9935 19.5 19.0935C19.4 18.0935 19 17.7935 18.4 17.7935C17.8 17.7935 17.6 18.0935 17.6 18.3935C17.6 18.6935 17.7 18.8935 17.9 19.0935C18.2 19.3935 17.6 20.2935 16.8 19.7935C16.3 19.4935 16 18.8935 16.1 17.9935C16.2 16.8935 17.1 15.8935 18.7 15.8935C20.3 15.8935 21.5 16.8935 21.8 18.3935C22.3 20.2935 21.3 22.5935 19 23.7935C16.2 25.2935 11.5 25.1935 8.89996 22.3935C7.39996 20.7935 6.89996 18.6935 6.99996 16.7935C6.99996 16.1935 7.09996 15.4935 7.29996 14.8935C7.29996 14.6935 7.19996 14.4935 6.99996 14.3935H6.89996H2.49996C2.19996 14.3935 1.99996 14.0935 1.99996 13.7935V13.6935L3.39996 7.59346C3.49996 7.19346 3.79996 6.99346 4.19996 6.99346H8.49996C8.69996 6.89346 8.89996 6.79346 8.99996 6.49346L9.69996 3.39346C9.79996 2.99346 10.2 2.79346 10.5 2.79346H17.2ZM74.3 12.9935C75.9 12.9935 77.1 14.2935 77.1 15.7935C77.1 17.2935 75.8 18.5935 74.3 18.5935C72.8 18.5935 71.5 17.2935 71.5 15.7935C71.5 14.2935 72.8 12.9935 74.3 12.9935Z\"/></svg>","twitch.svg":"<svg aria-hidden=\"true\" fill=\"#9146FF\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>Twitch</title><path d=\"M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z\"/></svg>","twitter.svg":"<svg aria-hidden=\"true\" fill=\"#000000\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>X</title><path d=\"M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z\"/></svg>","youtube.svg":"<svg aria-hidden=\"true\" fill=\"#FF0000\" role=\"img\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><title>YouTube</title><path d=\"M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z\"/></svg>","liquipedia.png":"<img src=\"data:image/png;base64,AAABAAMAMDAAAAEAIACoJQAANgAAACAgAAABACAAqBAAAN4lAAAQEAAAAQAgAGgEAACGNgAAKAAAADAAAABgAAAAAQAgAAAAAAAAJAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVjELBkwmAiBJIgAdSCAAEUYeAAg+FQACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWjcRbXNVNeJ3WjvdbU4tzmVEIbxeOxenWDQOkFQvCHZQKwNcTScAQkskAClKIwARTigCAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7EQAEYkEdr87Euf/x7uv/5uHb/9vTy//Ow7j/v7Gi/6+ei/+finT9jnZc9X5iRedqSijMWTUPcFYyDAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9EwAFZEMgs9rSyf///////////////////////////////////////Pz7//Xz8P/e19D/gGRH8FAqAjwAAAAAAAAAAAAAAAAAAAAAWDQOC1g0DlZYNA56WDQOWlg0DipYNA4JAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/FQAGZUQhttvTy//////////////////////////////////////////////////7+vn/jXRb9E4oAEIAAAAAAAAAAAAAAAAAAAAAWDQObVg0DvpYNA7/WDQO/Fg0DuhYNA66WDQOeFg0DjZYNA4MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAFwAHZkUjudzVzf/////////////////////////////////////////////////UysD/Z0Yjw04oABMAAAAAAAAAAAAAAAAAAAAAWDQOoFYyDP9VMQr/VjIM/1g0Dv9YNA7/WDQO/1g0Du9YNA6/WDQOd1g0DjFYNA4GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABCGQAIZ0Yju93Wzv////////////////////////////////////////////f18/+Mc1n0USwEVQAAAAAAAAAAAAAAAAAAAAAAAAAAVzMNkXhaO/+Mc1n+clMz/lg0Dv9XMw3/WDQO/1g0Dv9YNA7/WDQO/lg0DuxYNA58WDQOAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDGgAJZ0ckvd7X0P///////////////////////////////////////////8q+sv9fPBitTScACQAAAAAAAAAAAAAAAAAAAAAAAAAAUi0GbKeUgP/7+vn+mYNs/VczDf9jQR7+WTUP/1g0Dv9YNA7/WDQO/1g0Dv9YNA64WDQOBwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABDGwAKaUgmwODZ0v///////////////////////////////////////////56JcvtQKgNdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATigAS5V+ZvjDtqj9gWZJ/rSkk/7Y0Mf+el0+/lYyC/9YNA7/WDQO/1g0Dv9YNA5+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEHAALaUknwuHa0////////////////////////////////////////f38/5F5YPZNJwBFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATykBRY10WvbXzsX98e7r/v//////////zcK3/mJAHP5XMw3/WDQO/1g0DvBYNA46AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFg0DhdYNA5GWDQOX1g0DlRYNA4uUy4ICQAAAABFHQAMakknxOLb1P///////////////////////////////////////////6WSff1SLQVsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUy4HdKyah////////////97Wz/7Rx7399/b0/qaTfv1YNA7/WDQO/1g0DsJYNA4OAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA4IWDQOY1g0Ds9YNA73WDQO/1g0DvxZNQ/qWzgTsVErBE9PKQE3akoo2ubg2v///////////////////////////////////////////9jPxv9oSCXLUSwEIgAAAAAAAAAAAAAAAAAAAABOKAA4cFIx2eHa0////////Pz7/9LIvv3j3df+/v7+/7mpmf5ZNQ//WDQO/1g0Dn4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFo2EAVWMQp9VjEL91YxC/9VMQr/VTAK/1UwCf9cORT/qZeD/5B4X/VmRSLpjXRa/ff19P////////////////////////////////////////////Xz8f56XkD+VjELw1ErBFVKIwAnSiQALFEsBWtvUDDayb2x///////////////+//7+/f//////5N7Y/nBRMf5XMgz/WDQO8Fg0DjoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFMuB1N6Xj/uq5mG/6qXhP6jkHv+moRt/o51XP6CZ0v+1cvC/vv6+v/j3db/7+zo/v///////////////////////////////////////////////+rl4P57X0H+saCP/5eAaPh+Y0XngWZJ6p+Ldfve18/////////////////////////////6+Pf/lX9n/lYyC/9YNA7/WDQOylg0DhAAAAAAWDQOBFg0DgtYNA4LWDQOAgAAAAAAAAAAAAAAAF07FrrFuKv///////////////////////39/P/49/X/+/r5/////////////////////////////////////////////////////////////////97X0P6nlYH9/f38//38/P/18/H/9vTz//79/f/////////////////////////////////Dtqj+XToV/1czDf9YNA7/WDQO3lg0DotYNA6aWDQOsFg0DsJYNA7EWDQOllg0DjhYNA4BAAAAAHBRMO/o497//////////////////////////////////////////////////////////////////////////////////////////////////////+Hb1P3Y0Mf9/////////////////////////////////////////////////////+jj3f50Vjb+VjIL/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DuZYNA5aAAAAAHdaO/zw7en///////38/P/08e7+5uHb/tfOxf7IvK/+vrCh/u3p5f7///////////////////////////////////////////////////////////Lw7f308e/+////////////////////////////////////////////////+/r6/5uGb/5WMgz/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7iWDQOPWxMKuq8rp/+rpyK/o92Xf54Wjv+aEgl/l88GP5aNhD/VzMN/7Ojkf7///////////////////////////////////////////////////////////7+/v/+/v7/////////////////////////////////////////////////yL2w/l88GP5XMw3/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOq1k1D61aNxH/VjIL/1UxCv9WMgv/VzMN/1czDf9WMQv/VDAJ/4FmSf718vD+///////////////////////////////////////////////////////////////////////////////////////////////////////////r5+P+eFs8/lYyC/9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO61g0DkBYNA7kWDQO/1g0Dv9YNA7/WDMN/2JAHf+CZ0r+sJ+N/tzUzP77+/r//////////////////////////////////////////////////////////////////////////////////////+3p5f7b08v++vn4//39/P+hjXj+VzMM/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/Vg0DgFYNA5fWDQO6Fg0Dv9cORT/gGVI/6uZhv/AsqT/v7Gj/9jPxv79/f3//v7+////////////////////////////////////////////////////////////////////////////9vTx/5F5YP2ch3D9+fj3/t/Z0f5lRCH+VzMN/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO8AAAAABYNA4CWDQOOlg0DplcOBPFaEclwmVEIbBdOhWbVjELjnBRMOC4qZn/qZaD/fLv7P7//////////////////////////////////////v79//f18//29PH//fz8////////////5uHb/ci8sP329PL//////8i8sP1ZNhD/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOvAAAAAAAAAAAAAAAAFk1DwJULwkMSCEBCz8WAAQAAAAAVzMNElk1D81bNxL/VzMN/6GMd/76+fj//////////////////////////v/e1s//n4p0/IFmSex/ZEfol4Bp+dDGu//8/Pv//v7+/////v///////v7+/7amlf1YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7wWDQOVQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOPVg0DvFXMw3/VjIM/4xzWf708e/+/////////////////////8i8sP9vUC/YUiwFcEslADBKIwApUCoCW2RDH8m3qJf//v79//7+/v/h29T+nIdx/WVDIP5YNA3/WDQO/1g0Dv9YNA7/WDQO/1g0Dv1YNA7pWDQO91g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DvhYNA6BWDQOBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOglg0Df9YNA7/k3ti/u/r6P7//////f39//v6+f//////39jR/29QMNdNJwA0AAAAAAAAAAAAAAAAAAAAAE0nACdqSijOyLyv/6uYhf1qSij+VjIL/1czDf9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DtdYNA41WDQOV1g0DrdYNA7qWDQO+1g0Dv5YNA73WDQO0lg0DmdYNA4JAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA4PWDMNxVg0Dv+YgWr+8/Du////////////zsO4/ZeBaf3l39n+qJWB/lMtBnQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA5tYD4a/1g0Dv9XMgz/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DsBYNA4JAAAAAFg0DgpYNA4uWDQOUVg0DlxYNA5FWDQOGFg0DgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABXMw09WDMN8ZZ/aP/08e/////////////o497+dlk6/lQwCf9vUDD+bk4t9VQvCEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA5IVzMN+Vg0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dr1YNA4IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABWMgyCjXVb//Lv7P////////////r5+P6Ygmv9VjIL/1czDP9pSSf+d1k69lMuB0UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA5hWDQO/lg0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrtYNA4IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEkiAAljQR280ce9/////////////////8W4q/1dOxb+VzMN/1YxC/+hjXj+p5SA/lMtBmgAAAAAAAAAAAAAAAAAAAAAAAAAAFg0DgxYNA6zWDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrlYNA4HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEskAANbOBOAfWFD7KmXg/7WzcT/4tzW/ndaO/5WMgv/VzMN/2JAHP7a08r+wrWn/1k1D44AAAAAAAAAAAAAAAAAAAAAAAAAAFg0DllYNA73WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrdYNA4GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABULwkHTicBMFQvCHJkQyC4b1Av6lk1EP5YNA7/VjEL/4dtUv78+/r/xbms/1s3EpwAAAAAAAAAAAAAAAAAAAAAWDQOElg0DsNYNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrVYNA4FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABIIQAJUSsGMFg0DnJYNA64VjIM64RpTf2+sKH/h25S+VYxC2kAAAAAAAAAAAAAAAAAAAAAWDQORVg0DvZYNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrNYNA4FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA4JWDQOMFcyDGVXMw1+VTAJV1czDQsAAAAAAAAAAAAAAAAAAAAAWDQOQFg0DvJYNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DrFYNA4EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOCFg0DnRYNA7NWDQO5Vg0DvNYNA77WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dq1YNA4DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFg0DgFYNA4QWDQOJFg0DjpYNA5SWDQOa1g0DoVYNA6eWDQOtlg0DspYNA7cWDQO41g0DmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABYNA4BWDQOBlg0Dg9YNA4bWDQOIVg0DgYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP///////wAA////////AAD///////8AAP///////wAA////////AAD///////8AAP///////wAA//A/////AAD/4AH///8AAP/gAP///wAA/+AA/B//AAD/4AD4A/8AAP/gAfgA/wAA/+AB/AB/AAD/4AP8AP8AAP/gA/wA/wAA/+AD/AD/AADgYAH4Af8AAMAAAPAB/wAAgAAAAAH/AAAAAAAAAAcAAAAAAAAAAwAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAADAAAAAAAAAAOAAAAAAAAAA/4AAAAABAAD/gA8AAAEAAP8AH4AGBwAA/wA/wAf/AAD/AD/AB/8AAP4AP8AH/wAA/gA/gAf/AAD+AB+AB/8AAP/AHwAH/wAA//g/AAf/AAD///8AB/8AAP///4AH/wAA/////A//AAD///////8AAP///////wAA////////AAD///////8AAP///////wAA////////AAD///////8AACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABaNhAaXz0YWVo3EU5RLAU7RyAAKTsQABkkAQAMAwAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGpKKHG3qJf/xrqt+ripmfOrmYbonoly2ZB4XsR/ZEenZ0YjYU4oAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcVIyfuDZ0v/////////////////9/Pz/9/X0/+7r5/+kkXzsTyoCMgAAAAAAAAAAWDQOHlg0DoxYNA6SWDQOW1g0DiVYNA4FAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAByUzOB4drT////////////////////////////+ff2/5uGb9ZFHQAeAAAAAAAAAABYNA5oVzMM/1YyDP9YNA78WDQO4lg0DqtYNA5iWDQOIVg0DgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHNUNITh29T////////////////////////////Mwbb8Z0YkcQAAAAAAAAAAAAAAAFo3EWCUfWT9jnZc/lczDf9XMw3/WDQO/1g0Dv1YNA7UWDQOKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdFY2h+Lc1v///////////////////////Pv6/5yHcdc9FAAcAAAAAAAAAAAAAAAAVjILP7KikPSnlID+o496/oduUv5WMgz/WDQO/1g0DuVYNA4oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOBFg0DhFYNA4NWDQOAQAAAAB0VjeJ493X///////////////////////49/X/kXlgxycAAA4AAAAAAAAAAAAAAABULwg+r52L8+3p5f/39fP+3dbO/nBRMf5XMwz/WDQOrlg0DgYAAAAAAAAAAAAAAAAAAAAAAAAAAFMuCDhWMguiVzMMz1czDcZePBeKTCUCNnBSMqHm4Nv///////////////////////////+xoY/tUi0HRwAAAAAAAAAAIwAACnJUNZPd1c3//v79/9jQx/3x7er+mYNs/lYxC/5YNA5mAAAAAAAAAAAAAAAAAAAAAAAAAABcORNFakoo3WtLKf9mRSP/Xz0Z/5iCa/6rmYbtppN+9ff29P///////////////////////////8vAtP9wUTDbbk8ufWNBHmV9YUSpxrqt+P79/f///v7//////9rSyv5pSSb/VzMM5Fg0DigAAAAAAAAAAAAAAAAAAAAAAAAAAIBkR8Lc1Mz/6ubh/+Tf2f7a08r+5+Lc/v7+/v/9/Pz/////////////////////////////////yLyv/s/Fuv7c1c3/0si+/+nk3//+/v7////////////18/H/iW9U/lYxC/9YNA7eWDQObFg0DndYNA6LWDQOc1g0DiIAAAAAn4t19/38/P////////7+//r5+P/08vD//Pv7///////////////////////////////////////i3NX99/Xz/////////////////////////////////7amlf5aNhD/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOy1g0DjSSe2L0yb2x/6yah/6Se2L+gGRH/ndZOv7Rx73+//////////////////////////////////////v6+v7+/v7////////////////////////////e19D+a0sq/lcyDP9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOtlw5FLdbNxL/VjEL/1QwCf9YNA7/aUgm/7mqmv7///////////////////////////////////////////////////////////v6+f/9/Pz/9/b0/452XP5WMQv/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA71VzMNNlg0Ds1YNA7/a0sp/5Z/Z/+3qJj+493X/v39/f////7////////////////////////////////////////////29fP/saGP/uXg2v7Guq3+WzgT/1g0Df9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DvcAAAAAWDQOI1g1D3RoRySLclMzd2RDH26AZUjfmoVu/+Lc1f7////////////////+/v7/6eTf/9LIvv/b1Mv/+Pf1//Pw7f7g2tP+///+/6WRff5VMQr/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOwwAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOKVYyC+ZWMQv/sJ+N/v///////////v39/8a5rPd8YEOrY0EeaGxMKoGeinTe8Ozp//j39f/FuKv+c1U1/lczDP9YNA7/WDQO/1g0DvVYNA7vWDQO/1g0Dv9YNA7/WDQO/1g0Dt9YNA5HAAAAAAAAAAAAAAAAAAAAAAAAAABXMwxpWTUQ/pyGcP7z8e7/9fPx/+vn4v7b08v/cVM0kSAAAAkAAAAAAAAAAFczEEmXgWnuinBW/1w5FP9XMgz/WDQO/1g0Dv9YNA7/WDQOnlg0DjlYNA6NWDQOxFg0Ds1YNA6jWDQOOlg0DgEAAAAAAAAAAAAAAAAAAAAAUCoCB1k2ELCdh3H/9vTy//7+/f+pl4T+c1U1/4dtUvJXMgw8AAAAAAAAAAAAAAAAVjILDlcyDMlWMgv/WDQN/1g0Dv9YNA7/WDQO/1g0Dv9YNA6GAAAAAFg0DgFYNA4MWDQOEFg0DgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABNJwAqln9n5vXz8P//////0Ma7/mJAHf5dOhX/gWZJ8lw5FDwAAAAAAAAAAAAAAABYNA4eWDQO2lg0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DoMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFMuBy2Pd17VzMG1/ODZ0v9/ZEf/VC8I/4FmSf7Dtqj9Y0IfXgAAAAAAAAAAAAAAAFg0DnRYNA79WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQOgQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQQAU0mAiFiQB1ecVMzplo2EeBWMgz8p5SA/8W5rP9iQBxmAAAAAAAAAABYNA4eWDQO11g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA5+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5HAYEVzMNI1g0Dl52WDmYdlk5jVcyDB4AAAAAAAAAAFg0DjRYNA7uWDQO/1g0Dv9YNA7/WDQO/1g0Dv9YNA7/WDQO/1g0DnwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWDQOCFg0DmNYNA6lWDQOv1g0DtRYNA7lWDQO8Vg0DvpYNA7/WDQObwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFg0DgJYNA4JWDQOFVg0DiRYNA42WDQOS1g0DllYNA4aAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA////////////////////////////Af///wDz//4A8H/+AfAf/gHwH/4B8B/CAeA/gADAPwAAADcAAAABAAAAAAAAAACAAAAA7AAAAPwCAAH8B4BD+A+Af/gPgH/4D4B//g8A///PAP///4D///////////////////////////8oAAAAEAAAACAAAAABACAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAQABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB9YkQprZuImrCfjY2jkHtzj3deSWA+GgcAAAAAUy4HB1YxCwIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkHdeSefi3Pn6+fj/9fLw/8i8r9tlQyAcWjYRKFw4E7NVMQqUVzMNTlg0DhMAAAAAAAAAAAAAAAAAAAAAAAAAAJF5YEzq5uH6//////j39v+0o5KVAAAAAHJUNDWXgGnwfGBD/1o3EftYNA54AAAAAAAAAABJJAEcUSwEY1czDViJcFVt6+fj+//////29PL/o498hwAAAACGbVRJ2tLK897X0P90Vjb4Uy4GTwAAAAAAAAAAoY14uqqYhf6zo5L718/G8Pn49v7//////Pz7/8Gzpey6rJyz1s3D3P38/P/Mwbb/ZEMf51YyC1tYNA5EWDQOFbusnfjMwbX/u6yd/+7r5/////////////39/f/18/D+/f39///////v6+j/fWFE/1YxC/1YNA73WDQO+Fg0DrBiQB2xYD4Z+IBlSPfd1c38//////////////7//v7+//n49//r5+L+q5mG/lczDf9YNA7/WDQO/1g0Dv9YNA74USwGFWRCH0R5XD5cg2hM5+Lb1f/9/fz/1czD3L6wobXd1s7t2M/G/3ZZOv9WMgv+WDQO8Vg0DvtYNA7+WDQOvAAAAAAAAAAAY0IeUKeUgPnZ0cj/r56M8oNpT0gAAAABfWFEiG5PLv9YNA7/WDQO+1g0DmxYNA5ZWDQOY1g0Dh0AAAAAAAAAAJJ6YXnXz8b6i3JX/4NoS/CCZ0s0AAAAAFYyC5dXMgz/WDQO/1g0DvpYNA5KAAAAAAAAAAAAAAAAAAAAAAAAAAB0VjcTgGVITGE/G5SYgmq0hWtPJ1UwChxYNA7cWDQO/1g0Dv9YNA75WDQOSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABXMg8CPBgGCAAAAABYNA4IWDQOSFg0DnBYNA6KWDQOmlg0DikAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFg0DgEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP//AAD//wAA8/8AAPDPAADwxwAA8McAAAAHAAAAAAAAAAAAAOAAAADjDwAA4w8AAPMPAAD/zwAA//8AAP//AAA=\" alt=\"\">"};
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
  return `<span class="profile-account-link-group" title="${label}链接"><span class="profile-account-link-kind">${label}</span>${entries.map(({ platform, url }) => `<a class="profile-account-link profile-account-link-${escapeHtml(platform)}" href="${escapeHtml(externalUrl(platform, url))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(platform)}"><span aria-hidden="true">${icon[platform] ? (profilePlatformIconMarkup[icon[platform]] || `<img src="/assets/icons/${escapeHtml(icon[platform])}" alt="">`) : `<span class="profile-link-fallback">${escapeHtml(fallbackLabel[platform] || platform.slice(0, 2).toUpperCase())}</span>`}</span><span class="sr-only">${escapeHtml(platform)}</span></a>`).join('')}</span>`;
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
    fetch(`/api/avatar?v=2&profileId=${encodeURIComponent(profileId)}`, { cache: 'default' }).then(response => response.ok ? response.json() : null).then(data => {
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
const replayCivilizationNamesById = {
  0: '随机', 1: '不列颠', 2: '法兰克', 3: '哥特', 4: '条顿', 5: '日本', 6: '中国', 7: '拜占庭', 8: '波斯', 9: '撒拉逊', 10: '土耳其', 11: '维京', 12: '蒙古', 13: '凯尔特', 14: '西班牙', 15: '阿兹特克', 16: '玛雅', 17: '匈奴', 18: '高丽', 19: '意大利', 20: '印度斯坦', 21: '印加', 22: '马扎尔', 23: '斯拉夫', 24: '葡萄牙', 25: '埃塞俄比亚', 26: '马里', 27: '柏柏尔', 28: '高棉', 29: '马来', 30: '缅甸', 31: '越南', 32: '保加利亚', 33: '鞑靼', 34: '库曼', 35: '立陶宛', 36: '勃艮第', 37: '西西里', 38: '波兰', 39: '波希米亚', 40: '达罗毗荼', 41: '孟加拉', 42: '瞿折罗', 43: '罗马', 44: '亚美尼亚', 45: '格鲁吉亚', 46: '阿契美尼德', 47: '雅典', 48: '斯巴达', 49: '蜀', 50: '吴', 51: '魏', 52: '女真', 53: '契丹', 54: '马其顿', 55: '色雷斯', 56: '普鲁', 57: '穆伊斯卡', 58: '马普切', 59: '图皮', 60: '撒克逊', 61: '瓦兰吉', 62: '丹麦'
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
    if (games > 0) counts.set(Number(row.id) === 0 ? 'other' : Number(row.id), games);
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
  const rows = Array.isArray(leaderboards) ? leaderboards.filter(row => Number(row.id) !== 15) : [];
  currentProfileLeaderboardRows = rows;
  renderProfileModeCharts();
  const body = document.querySelector('#profileLeaderboardBody');
  const toggle = document.querySelector('#profileLeaderboardToggle');
  if (!body) return;
  const inactiveCount = rows.filter(row => row.hasData === false || row.active === false).length;
  const ladderPriority = new Map([[3, 0], [4, 1], [13, 2], [14, 3], [1, 4], [2, 5], [0, 6]]);
  const orderedRows = [...rows].sort((a, b) =>
    (ladderPriority.get(Number(a.id)) ?? 99) - (ladderPriority.get(Number(b.id)) ?? 99)
  );
  body.innerHTML = orderedRows.map(row => {
    const lobbyMode = Number(row.id) === 0;
    const hasData = row.hasData !== false;
    const active = hasData && row.active !== false;
    const games = lobbyMode && row.games != null ? Number(row.games) : row.wins != null && row.losses != null && Number.isFinite(Number(row.wins)) && Number.isFinite(Number(row.losses)) ? Number(row.wins) + Number(row.losses) : null;
    const winrate = games !== null && games > 0 && Number.isFinite(Number(row.wins)) ? `${(Number(row.wins) / games * 100).toFixed(1)}%` : '—';
    const ratingPair = row.rating != null || row.highestRating != null ? `${row.rating != null ? fmt.format(row.rating) : '—'} / ${row.highestRating != null ? fmt.format(row.highestRating) : '—'}` : '—';
    const recent = Array.isArray(recentResults?.get?.(Number(row.id))) ? recentResults.get(Number(row.id)).slice().reverse() : [];
    const favorite = recentStats?.get?.(Number(row.id)) || {};
    const recentMarkup = Array.from({ length: 5 }, (_, index) => {
      const result = recent[index];
      return `<span class="profile-recent-result ${result === true ? 'win' : result === false ? 'loss' : 'unknown'}" title="${result === true ? '胜利' : result === false ? '失败' : '暂无记录'}">${result === true ? '✓' : result === false ? '×' : '·'}</span>`;
    }).join('');
    const rankLabel = lobbyMode ? '累计胜场' : active ? '世界排名' : hasData ? '不活跃' : '未参与此模式';
    const rankValue = lobbyMode ? (row.pending ? '加载中…' : row.wins != null ? fmt.format(row.wins) : '—') : active ? '#' + fmt.format(row.rank) : hasData ? '无排名' : '—';
    const favoriteCiv = favorite.civilization ? `${favorite.civilization} · ${favorite.civilizationCount} 场` : '—';
    const favoriteMap = favorite.map ? `${favorite.map} · ${favorite.mapCount} 场` : '—';
    const favoriteOpponentRecord = favorite.opponent ? `${favorite.opponentWins}场/${favorite.opponentTotal}场` : '—';
    const favoriteOpponentId = favorite.opponentId && /^\d+$/.test(String(favorite.opponentId)) ? String(favorite.opponentId) : '';
    const favoriteOpponentAvatar = favoriteOpponentId ? `<span class="profile-ladder-opponent-avatar" data-profile-avatar-id="${escapeHtml(favoriteOpponentId)}"><span>${escapeHtml((favorite.opponent || '?').slice(0, 1).toUpperCase())}</span></span>` : '';
    const favoriteOpponentLink = favorite.opponent && favoriteOpponentId ? `<a class="profile-ladder-opponent-link" href="/profile/${encodeURIComponent(favoriteOpponentId)}" title="查看 ${escapeHtml(favorite.opponent)} 的资料">${favoriteOpponentAvatar}<span class="profile-ladder-opponent-name">${escapeHtml(favorite.opponent)}</span></a>` : escapeHtml(favorite.opponent || '—');
    const favoriteCivIcon = favorite.civilizationIcon ? `<img class="profile-ladder-civ-icon" src="${escapeHtml(favorite.civilizationIcon)}" alt="" loading="lazy" onerror="this.hidden=true">` : '';
    const lastGame = formatTimeAgo(row.lastMatchDate) || '—';
    const lastGameTitle = Number(row.lastMatchDate) > 0 ? new Date(Number(row.lastMatchDate) * 1000).toLocaleString('zh-CN') : '接口未提供最后游戏时间';
    return `<article class="profile-ladder-card${active ? '' : ' profile-inactive-row'}"${active ? '' : ' hidden'}><div class="profile-ladder-card-head"><strong>${escapeHtml(row.label || '未知模式')}</strong><span>${games !== null ? `${fmt.format(games)} 场` : '—'}</span><span class="profile-ladder-last-game" title="${escapeHtml(lastGameTitle)}">最后游戏时间 ${escapeHtml(lastGame)}</span></div><div class="profile-ladder-card-body"><div class="profile-ladder-card-main"><div class="profile-ladder-rank"><small>${rankLabel}</small><b>${rankValue}</b></div><div class="profile-ladder-stat profile-ladder-rating"><span>${lobbyMode ? '累计负场' : '当前积分/历史最高'}</span><b>${lobbyMode ? (row.losses != null ? fmt.format(row.losses) : '—') : ratingPair}</b></div><div class="profile-ladder-stat profile-ladder-record"><span>胜率</span><b>${winrate}</b></div></div><div class="profile-ladder-favorites"><div class="profile-ladder-stat profile-ladder-favorite-civ"><span>近期最多民族</span><b title="${escapeHtml(favorite.civilization || '暂无数据')}">${favoriteCivIcon}${escapeHtml(favoriteCiv)}</b></div><div class="profile-ladder-stat profile-ladder-favorite-map"><span>近期最多地图</span><b title="${escapeHtml(favorite.map || '暂无数据')}">${escapeHtml(favoriteMap)}</b></div><div class="profile-ladder-stat profile-ladder-favorite-opponent"><span>近期最强对手</span><b title="${escapeHtml(favorite.opponent || '暂无数据')}">${favoriteOpponentLink}</b><small class="profile-ladder-opponent-record">${escapeHtml(favoriteOpponentRecord)}</small></div></div></div><div class="profile-ladder-card-foot"><span class="profile-recent-results-label">最近 5 场</span><span class="profile-recent-results">${recentMarkup}</span></div></article>`;
  }).join('') || '<div class="profile-leaderboard-empty">暂无天梯汇总数据</div>';
  body.querySelectorAll('.profile-ladder-opponent-avatar[data-profile-avatar-id]').forEach(avatar => {
    const profileId = avatar.dataset.profileAvatarId;
    fetch(`/api/avatar?v=2&profileId=${encodeURIComponent(profileId)}`, { cache: 'default' })
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
let profileLeaderboardsRequestId = 0;
function loadProfileLeaderboards(profileId) {
  const requestId = ++profileLeaderboardsRequestId;
  const isCurrent = () => requestId === profileLeaderboardsRequestId && location.pathname === `/profile/${encodeURIComponent(profileId)}`;
  const initialBody = document.querySelector('#profileLeaderboardBody');
  if (initialBody) initialBody.innerHTML = profileSectionLoadingMarkup();
  fetch(`/api/profile-leaderboards?id=${encodeURIComponent(profileId)}&progressive=1`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(async data => {
      if (!isCurrent() || !data?.leaderboards) return;
      renderProfileLeaderboards(data.leaderboards);
      if (!data.leaderboards.some(row => row.pending || row.stale)) return;
      try {
        const response = await fetch(`/api/profile-leaderboards?id=${encodeURIComponent(profileId)}`, { cache:'no-store' });
        if (!response.ok) return;
        const complete = await response.json();
        if (isCurrent() && complete?.leaderboards) renderProfileLeaderboards(complete.leaderboards);
      } catch { /* Ranked cards stay visible if the optional lobby lookup fails. */ }
    })
    .catch(() => {});
}
function profileMatchCategory(match) {
  const type = profileMatchLeaderboard(match);
  if (type === 'RM 1v1') return 'rm_1v1';
  if (type === 'RM TG') return 'rm_team';
  if (!type || type.toLowerCase() === 'unranked') return 'lobby';
  return 'other';
}
function filterProfileMatches(matches) {
  const filter = document.querySelector('#profileMatchesFilter')?.value || 'all';
  return filter === 'all' ? matches : matches.filter(match => profileMatchCategory(match) === filter);
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
  const visibleMatches = filterProfileMatches((liveMatch ? [liveMatch] : []).concat(historyMatches)).slice(0, visibleCount);
  if (!visibleMatches.length) { body.innerHTML = '<div class="profile-matches-empty">最近对局中暂无符合筛选的记录</div>'; return; }
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
    const analysisProfileId = self?.id || players.find(player => player.id)?.id;
    const analysisButton = !live && match.id && analysisProfileId ? `<a class="profile-match-replay-analysis" href="/replay-analysis?matchId=${encodeURIComponent(String(match.id))}&profileId=${encodeURIComponent(String(analysisProfileId))}">录像分析</a>` : '';
    const teamLayoutClass = `${teams.length > 2 ? ' many-teams' : ''}${teams.length >= 2 && teams.some(team => Array.isArray(team.members) && team.members.length > 1) ? ' team-game' : ''}`;
    return `<article class="profile-match-card ${live ? 'is-live' : resultClass}"><div class="profile-match-heading"><span class="profile-match-leaderboard" title="${escapeHtml(profileMatchTypeLabel(match))}">${escapeHtml(profileMatchTypeLabel(match))}</span>${liveBadge}</div><div class="profile-match-content"><div class="profile-match-info"><div class="profile-match-map-column"><div class="profile-match-map-icon">${mapIcon}</div>${replayButton}${analysisButton}</div><div class="profile-match-map-copy"><strong class="${mapNameColorClass(rawMapName)}" title="${escapeHtml(mapName)}">${escapeHtml(mapName)}</strong><span>◷ ${escapeHtml(durationText)}</span><span>${escapeHtml(matchAgo)}</span><small>#${escapeHtml(match.id ?? '—')}</small></div></div><div class="profile-match-teams${teamLayoutClass}">${matchupMarkup}</div></div></article>`;
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
  const leaderboardId = match => profileMatchCategory(match) === 'lobby' ? 0 : ({ 'RM 1v1': 3, 'RM TG': 4, 'EW 1v1': 13, 'EW TG': 14 }[profileMatchLeaderboard(match)] ?? null);
  const ordered = [...(Array.isArray(matches) ? matches : [])].sort((a, b) => Number(b.started || b.lobby_created || 0) - Number(a.started || a.lobby_created || 0));
  for (const match of ordered) {
    const id = leaderboardId(match);
    if (id == null || match?.live === true || (!Number(match?.finished) && match?.abandoned !== true)) continue;
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
  const leaderboardId = match => profileMatchCategory(match) === 'lobby' ? 0 : ({ 'RM 1v1': 3, 'RM TG': 4, 'EW 1v1': 13, 'EW TG': 14 }[profileMatchLeaderboard(match)] ?? null);
  const counts = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const id = leaderboardId(match);
    if (id == null || match?.live === true || (!Number(match?.finished) && match?.abandoned !== true)) continue;
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
          const prior = entry.opponents.get(name) || { id: String(opponent.id || ''), total: 0, wins: 0, losses: 0, latest: 0 };
          prior.total += 1;
          prior.latest = Math.max(prior.latest, Number(match.started || match.finished || 0));
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
    const opponent = [...entry.opponents.entries()].sort((a, b) => a[1].wins * b[1].total - b[1].wins * a[1].total || b[1].latest - a[1].latest || a[0].localeCompare(b[0], 'zh-CN'))[0] || ['', { total: 0, wins: 0, losses: 0 }];
    stats.set(id, { civilization: civilization[0], civilizationCount: civilization[1], civilizationIcon: entry.civilizationIcons.get(civilization[0]) || '', map: map[0], mapCount: map[1], opponent: opponent[0], opponentId: opponent[1].id || '', opponentWins: opponent[1].wins, opponentTotal: opponent[1].total });
  }
  return stats;
}
async function loadWorldsEdgeMatches(profileId, profile, requestId = profileDetailsRequestId) {
  const more = document.querySelector('#profileMatchesMore');
  const isCurrent = () => requestId === profileDetailsRequestId && location.pathname === `/profile/${encodeURIComponent(String(profileId))}`;
  const refreshStatus = (phase, hasMatches = false) => {
    if (!isCurrent()) return;
    const text = phase === 'refreshing' ? '正在刷新…' : phase === 'updated' ? '' : phase === 'stale' ? '暂未刷新，显示旧数据' : hasMatches ? '刷新失败，保留旧数据' : '刷新失败，请稍后重试';
    const target = document.querySelector('#profileMatchesRefreshStatus');
    if (target) { target.hidden = phase === 'updated'; target.textContent = text; target.dataset.state = phase; }
    for (const selector of ['#profileMatchesBody','#profileRecentModeChart']) document.querySelector(selector)?.setAttribute('aria-busy',String(phase === 'refreshing'));
  };
  refreshStatus('refreshing');
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
      more.hidden = visibleCount >= filterProfileMatches(matches).length && !hasMore;
      more.disabled = loading;
      more.textContent = loading ? '加载中…' : '显示更多';
    }
  };
  const matchFilter = document.querySelector('#profileMatchesFilter');
  if (matchFilter) matchFilter.onchange = () => { visibleCount = 20; render(); };
  const fetchPage = async (offset, limit = 100, progressive = false) => {
    const suffix = progressive ? '&progressive=1' : '';
    const response = await fetch(`/api/profile-matches?id=${encodeURIComponent(profileId)}&offset=${offset}&limit=${limit}${suffix}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('近期对局请求失败');
    return response.json();
  };
  if (localMatches) render();
  if (more) more.onclick = async () => {
    if (!isCurrent()) return;
    if (loading) return;
    if (visibleCount < filterProfileMatches(matches).length) {
      visibleCount = Math.min(visibleCount + 20, filterProfileMatches(matches).length);
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
      visibleCount = Math.min(visibleCount + 20, filterProfileMatches(matches).length);
    } catch {
      hasMore = false;
    } finally {
      loading = false;
      render();
    }
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
      if (!complete.stale) saveProfileMatchesLocalCache(profileId, matches);
      currentProfileRecentResults = profileRecentResultsByLeaderboard(matches, profileId);
      currentProfileRecentStats = profileRecentStatsByLeaderboard(matches, profileId);
      currentProfileRecentModeCounts = profileRecentModeCounts(matches, profileId);
      renderProfileModeCharts();
      if (currentProfileLeaderboardRows.length) renderProfileLeaderboards(currentProfileLeaderboardRows, currentProfileRecentResults, currentProfileRecentStats);
      hasMore = false;
      renderProfileLastMatchFromMatch(matches[0]);
      render();
      refreshStatus(complete.stale ? 'stale' : 'updated',matches.length > 0);
    } catch {
      // The initial 20 matches remain visible if the background refresh fails.
      refreshStatus('failed',matches.length > 0);
    }
  } catch {
    // Do not fall back to AoE2Recs matches: they may omit per-player ratingDiff.
    if (isCurrent()) {
      if (matches.length) render();
      else {
        currentProfileRecentModeCounts = new Map();
        renderProfileModeCharts();
        const body = document.querySelector('#profileMatchesBody');
        if (body) body.innerHTML = '';
      }
      refreshStatus('failed',matches.length > 0);
    }
  }
  if (localMatches && localFresh) {
    render();
    await fetch(`/api/profile-matches?id=${encodeURIComponent(profileId)}&latest=1`, { cache: 'no-store' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('刷新对局失败')))
      .then(async data => {
        if (!isCurrent()) return;
        if (!Array.isArray(data?.matches)) throw new Error('近期对局格式无效');
        const latest = Array.isArray(data?.matches) ? data.matches[0] : null;
        if (latest) {
          const known = new Set(matches.map(match => String(match.id)));
          matches = [latest, ...matches.filter(match => String(match.id) !== String(latest.id))].slice(0, 100);
          applyMatches(); render();
          if (!data.stale && !known.has(String(latest.id))) {
            const complete = await fetchPage(0,100);
            if (!isCurrent()) return;
            matches = Array.isArray(complete.matches) ? complete.matches : matches;
            applyMatches(); render();
            if (!complete.stale) saveProfileMatchesLocalCache(profileId,matches);
            refreshStatus(complete.stale ? 'stale' : 'updated',matches.length > 0);
            return;
          }
          if (!data.stale) saveProfileMatchesLocalCache(profileId,matches);
        }
        refreshStatus(data.stale ? 'stale' : 'updated',matches.length > 0);
      }).catch(() => refreshStatus('failed',matches.length > 0));
  }

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
      fetch(`/api/avatar?v=2&profileId=${encodeURIComponent(profileId)}`, { cache: 'default' })
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
function mediaPreviewUrl(item, live = false) {
  const platform = String(item?.platform || '').toLowerCase();
  const id = String(item?.id || '').trim();
  if (platform === 'youtube' || platform === 'youtube_live') {
    const channelId = item?.channelId || String(item?.url || '').match(/youtube\.com\/channel\/([^/?#]+)/i)?.[1] || '';
    if (live && channelId) return `https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(channelId)}&autoplay=1&mute=1&controls=0&playsinline=1&rel=0`;
    const videoId = id.match(/^[A-Za-z0-9_-]{11}$/)?.[0] || String(item?.url || '').match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] || '';
    return videoId ? `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?autoplay=1&mute=1&controls=0&playsinline=1&rel=0` : '';
  }
  if (platform === 'bilibili' && live) {
    const roomId = id.match(/^(?:bilibili:)?(\d+)$/i)?.[1] || String(item?.url || '').match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/i)?.[1] || '';
    return roomId ? `https://www.bilibili.com/blackboard/live/live-activity-player.html?cid=${encodeURIComponent(roomId)}&quality=0&autoplay=1` : '';
  }
  if (platform === 'twitch' && live) {
    const channel = String(item?.url || '').match(/twitch\.tv\/([^/?#]+)/i)?.[1] || '';
    return channel ? `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=aoe2cn.cc&autoplay=true&muted=true` : '';
  }
  if (platform === 'bilibili' && !live && /^BV[0-9A-Za-z]{10}$/i.test(id)) {
    return `https://player.bilibili.com/player.html?bvid=${encodeURIComponent(id)}&autoplay=1&danmaku=0`;
  }
  return '';
}
function setupMediaHoverPreviews(root) {
  if (!root) return;
  root.querySelectorAll('.media-card[data-preview-url]').forEach(card => {
    if (card.dataset.previewBound === '1') return;
    card.dataset.previewBound = '1';
    const thumb = card.querySelector('.media-thumb');
    const previewUrl = card.dataset.previewUrl;
    if (!thumb || !previewUrl) return;
    const start = () => {
      if (thumb.querySelector('.media-hover-preview')) return;
      const frame = document.createElement('iframe');
      frame.className = 'media-hover-preview';
      frame.src = previewUrl;
      frame.title = '悬停预览';
      frame.allow = 'autoplay; encrypted-media; picture-in-picture';
      frame.setAttribute('aria-hidden', 'true');
      thumb.appendChild(frame);
      card.classList.add('is-previewing');
    };
    const stop = () => {
      thumb.querySelector('.media-hover-preview')?.remove();
      card.classList.remove('is-previewing');
    };
    card.addEventListener('pointerenter', start);
    card.addEventListener('pointerleave', stop);
    card.addEventListener('focusin', start);
    card.addEventListener('focusout', event => { if (!card.contains(event.relatedTarget)) stop(); });
  });
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
    videos.innerHTML = items.length ? items.map(item => { const previewUrl = mediaPreviewUrl(item); return `<a class="media-card"${previewUrl ? ` data-preview-url="${escapeHtml(previewUrl)}"` : ''} href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"><div class="media-thumb">${item.thumbnail ? `<img src="${escapeHtml(mediaThumbnail(item))}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-image');this.remove()">` : ''}</div><div class="media-card-body"><strong title="${escapeHtml(item.title || '')}">${escapeHtml(item.title || '未命名视频')}</strong><span>${escapeHtml(item.channel || '')}${item.publishedAt ? ` · ${escapeHtml(mediaDate(item.publishedAt))}` : ''}</span></div></a>`; }).join('') : '<div class="media-empty">暂无已配置的视频源</div>';
    setupMediaHoverPreviews(videos);
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
      const previewUrl = mediaPreviewUrl(item, true);
      return `<a class="media-card media-live-card is-live"${previewUrl ? ` data-preview-url="${escapeHtml(previewUrl)}"` : ''} href="${escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"><div class="media-thumb">${item.thumbnail ? `<img src="${escapeHtml(mediaThumbnail(item, true))}" alt="" loading="lazy" onerror="this.parentElement.classList.add('no-image');this.remove()">` : ''}<span class="media-live-status">${escapeHtml(platform)}</span></div><div class="media-card-body"><strong class="media-live-title" title="${escapeHtml(liveTitle)}">${escapeHtml(liveTitle)}</strong><div class="media-live-bottom"><div class="media-live-host"><strong class="media-live-player-name" title="${escapeHtml(item.name || '未知主播')}">${escapeHtml(item.name || '未知主播')}</strong><span class="media-live-audience"><b class="media-spark" aria-hidden="true">✦</b> ${Number(item.viewers || 0).toLocaleString('zh-CN')} ${countLabel}</span></div>${ladders ? `<span class="media-live-ladders">${ladders}</span>` : ''}</div></div></a>`;
    }).join('') : '<div class="media-empty">暂无开播直播间</div>';
    if (liveCN) liveCN.innerHTML = markup(items.filter(item => item.isCN));
    if (liveForeign) liveForeign.innerHTML = markup(items.filter(item => !item.isCN));
    setupMediaHoverPreviews(liveCN);
    setupMediaHoverPreviews(liveForeign);
  }
}
function loadMedia(showAllVideos = false) {
  if (mediaRequest) return mediaRequest;
  mediaRequest = fetch('/api/media', { cache: 'default' }).then(response => response.ok ? response.json() : Promise.reject(new Error('视频直播请求失败'))).then(data => { renderMedia(data, showAllVideos); return data; }).catch(() => { renderMedia({ videos: [], live: [] }, showAllVideos); }).finally(() => { mediaRequest = null; });
  return mediaRequest;
}
let replayParserModule = null;
let replayAnalysisLoaded = false;
function replayValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}
function replayWalk(value, visit, seen = new Set(), depth = 0) {
  if (value == null || depth > 10 || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) { value.forEach(item => replayWalk(item, visit, seen, depth + 1)); return; }
  for (const key of Object.keys(value)) {
    try { replayWalk(value[key], visit, seen, depth + 1); } catch {}
  }
}
function replayNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function replayFindChat(root, playerNames = new Map()) {
  const messages = [];
  const addMessage = (raw, fallbackPlayer = null, fallbackTime = null) => {
    if (!raw) return;
    let parsed = raw;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { parsed = { message: parsed }; }
    }
    if (!parsed || typeof parsed !== 'object') return;
    let rawText = replayValue(parsed.message ?? parsed.text ?? parsed.contents ?? parsed.content).trim();
    if (/^@#\d+<player_id,\d+,\d+>/.test(String(parsed.messageAGP || ''))) {
      rawText = rawText.replace(/(?:has\s+advanced\s+to|advanced\s+to|has\s+reached|reached)\s+(?:the\s+)?(Dark|Feudal|Castle|Imperial)\s+Age[.!]?/gi,
        (_, age) => `升级至${({dark:'黑暗时代',feudal:'封建时代',castle:'城堡时代',imperial:'帝王时代'})[age.toLowerCase()]}。`);
    }
    const text = rawText.replace(/<player_id,(\d+),\d+>/g, (_, id) => playerNames.get(String(id)) || `玩家 ${id}`);
    if (!text) return;
    const playerId = parsed.player ?? parsed.sender ?? fallbackPlayer;
    const player = playerNames.get(String(playerId)) || replayValue(playerId);
    const time = replayNumber(parsed.time ?? parsed.tick ?? parsed.timestamp ?? fallbackTime);
    messages.push({ text, time, player, playerId: playerId == null ? null : String(playerId) });
  };
  const chapters = Array.isArray(root?.chapters) ? root.chapters : [];
  if (chapters.length) {
    for (const chapter of chapters) {
      let worldTime = 0;
      let started = false;
      for (const operation of Array.isArray(chapter?.operations) ? chapter.operations : []) {
        if (operation?.Sync) worldTime += Number(operation.Sync.time_increment) || 0;
        if (operation?.Action) started = true;
        if (started && operation?.Chat) addMessage(operation.Chat.text ?? operation.Chat.message, operation.Chat.player, worldTime);
      }
    }
  } else {
    replayWalk(root, value => {
      if (!value || Array.isArray(value)) return;
      if (value.Chat) {
        addMessage(value.Chat.text ?? value.Chat.message, value.Chat.player);
        return;
      }
      const keys = Object.keys(value).map(key => key.toLowerCase());
      const textKey = keys.find(key => ['message', 'text', 'contents', 'content'].includes(key));
      if (!textKey || typeof value[textKey] !== 'string' || !value[textKey].trim()) return;
      const hasChatContext = keys.some(key => /chat|sender|player|message/.test(key));
      if (!hasChatContext) return;
      const timeKey = keys.find(key => /time|tick|timestamp/.test(key));
      const playerKey = keys.find(key => /player|sender|profile/.test(key));
      messages.push({ text: value[textKey].trim(), time: replayNumber(timeKey ? value[timeKey] : null), player: playerKey ? replayValue(value[playerKey]) : '' });
    });
  }
  const unique = [];
  for (const message of messages) {
    const duplicate = [...unique].reverse().find(previous => previous.player === message.player && previous.text === message.text && previous.time != null && message.time != null && Math.abs(previous.time - message.time) <= 1000);
    if (!duplicate) unique.push(message);
  }
  return unique.slice(0, 300);
}
function replayFormatTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function replayCivLabel(player) {
  const civId = Number(player?.civ_id);
  if (!Number.isFinite(civId)) return '未知文明';
  return replayCivilizationNamesById[civId] || '未知文明';
}
const replayCivilizationSlugsById = {
  1: 'britons', 2: 'franks', 3: 'goths', 4: 'teutons', 5: 'japanese', 6: 'chinese', 7: 'byzantines', 8: 'persians', 9: 'saracens', 10: 'turks', 11: 'vikings', 12: 'mongols', 13: 'celts', 14: 'spanish', 15: 'aztecs', 16: 'mayans', 17: 'huns', 18: 'koreans', 19: 'italians', 20: 'hindustanis', 21: 'incas', 22: 'magyars', 23: 'slavs', 24: 'portuguese', 25: 'ethiopians', 26: 'malians', 27: 'berbers', 28: 'khmer', 29: 'malays', 30: 'burmese', 31: 'vietnamese', 32: 'bulgarians', 33: 'tatars', 34: 'cumans', 35: 'lithuanians', 36: 'burgundians', 37: 'sicilians', 38: 'poles', 39: 'bohemians', 40: 'dravidians', 41: 'bengalis', 42: 'gurjaras', 43: 'romans', 44: 'armenians', 45: 'georgians', 49: 'shu', 50: 'wu', 51: 'wei', 52: 'jurchens', 53: 'khitans', 54: 'macedonians', 55: 'thracians', 56: 'puru', 57: 'muisca', 58: 'mapuche', 59: 'tupi', 60: 'saxons', 61: 'varangians', 62: 'danes'
};
function replayCivIcon(player) {
  const slug = replayCivilizationSlugsById[Number(player?.civ_id)];
  return slug ? `https://backend.cdn.aoe2companion.com/public/aoe2/de/civilizations/${slug}.png` : '';
}
let replayEapmModule = null;
let replayEapmModulePromise = null;
async function replayLoadEapm() {
  replayEapmModule = await (replayEapmModulePromise ||= import('/replay-eapm.js?v=7'));
}
function replayPlayerStats(full, durationMs, players, gameSpeed) {
  const excludedQueueUnitIds = new Set([83, 13, 17, 128]);
  const stats = new Map(players.map(player => [String(player.player_number), { queue: new Map(), villagers: 0, recent: new Map() }]));
  // Queue estimates are separate from the shared effective-action calculation.
  for (const chapter of full?.chapters || []) for (const operation of chapter.operations || []) {
    const action = operation.Action, value = action?.action_data?.DeQueue;
    const time = action?.world_time;
    if (!value || !Number.isFinite(time) || time < 0 || (Number.isFinite(durationMs) && time > durationMs)) continue;
    const entry = stats.get(String(value.player_id));
    if (!entry) continue;
    const unitId = Number(value.unit_id), amount = Math.max(1, Number(value.amount) || 1);
    const fingerprint = JSON.stringify(value), previous = entry.recent.get(fingerprint);
    const duplicate = previous != null && time >= previous && time - previous <= 300;
    if (unitId === 83) { entry.villagers += amount; entry.recent.set(fingerprint, time); }
    else { if (duplicate) continue; entry.recent.set(fingerprint, time); }
    if (!excludedQueueUnitIds.has(unitId) && Number.isFinite(unitId)) entry.queue.set(unitId, (entry.queue.get(unitId) || 0) + amount);
  }
  const actions = replayEapmModule.collectEffectiveActionTimes(full, players, durationMs, gameSpeed);
  return new Map([...stats].map(([id, entry]) => [id, {
    eapm: replayEapmModule.replayEapmStats(actions.get(id) || [], durationMs).global,
    villagerCount: entry.villagers,
    queuedUnits: [...entry.queue].sort((a,b) => b[1]-a[1]).slice(0,2).map(([id,count]) => ({ id,count }))
  }]));
}

const replayUnitInfoById = {
  83: { name: '村民', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E6%9D%91%E6%B0%91%E7%94%B7.webp' },
  4: { name: '步弓手', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E6%AD%A5%E5%BC%93%E6%89%8B.webp' },
  13: { name: '渔船', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E6%B8%94%E8%88%B9.webp' },
  74: { name: '民兵', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E6%B0%91%E5%85%B5.webp' },
  93: { name: '长矛兵', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E9%95%BF%E7%9F%9B%E5%85%B5.webp' },
  1001: { name: '风琴炮', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E9%A3%8E%E7%90%B4%E7%82%AE.webp' },
  125: { name: '僧侣', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E5%83%A7%E4%BE%A3.webp' },
  128: { name: '贸易马车', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E8%B4%B8%E6%98%93%E9%A9%AC%E8%BD%A6.webp' },
  279: { name: '弩炮', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E5%BC%A9%E7%82%AE.webp' },
  280: { name: '轻型投石车', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E8%BD%BB%E5%9E%8B%E6%8A%95%E7%9F%B3%E8%BD%A6.webp' },
  331: { name: '打包中的投石机', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E5%B7%A8%E5%9E%8B%E6%8A%95%E7%9F%B3%E6%9C%BA.webp' },
  440: { name: '爆破兵', icon: '' },
  755: { name: '答剌罕骑兵', icon: '' },
  1129: { name: '藤弓兵', icon: '' },
  1949: { name: '虎豹骑', icon: '' },
  2562: { name: '格查战士', icon: '' },
  2708: { name: '首领', icon: 'https://data.seicing.com/seicingdepot/3fatcatpool/aoe2/icon/%E9%A6%96%E9%A2%86.webp' }
};
const replayTechInfoById = {};
async function replayLoadUnitMap() {
  if (replayLoadUnitMap.loaded) return;
  replayLoadUnitMap.loaded = true;
  try {
    const { replayObjectNames } = await import('/replay-object-names.js?v=2');
    for (const [id, name] of Object.entries(replayObjectNames)) {
      if (!replayUnitInfoById[id]) replayUnitInfoById[id] = { name, icon: '' };
    }
  } catch (error) { console.warn('游戏对象中文映射加载失败', error); }

  try {
    const response = await fetch('/replay-unit-map.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`unit map ${response.status}`);
    Object.assign(replayUnitInfoById, await response.json());
  } catch (error) {
    console.warn('完整单位映射加载失败，使用内置映射', error);
  }
}
async function replayLoadTechMap() {
  if (replayLoadTechMap.loaded) return;
  replayLoadTechMap.loaded = true;
  try {
    const response = await fetch('/replay-tech-map.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`tech map ${response.status}`);
    Object.assign(replayTechInfoById, await response.json());
  } catch (error) {
    console.warn('完整科技映射加载失败', error);
  }
}
function replayQueuedUnitInfo(stats) {
  return (stats?.queuedUnits || []).map(({ id, count }) => ({
    id, count, ...(replayUnitInfoById[id] || { name: '未知单位', icon: '' })
  }));
}
function replayPlayerColor(colorId) {
  // Replay color IDs are zero-based: blue, red, green, yellow, cyan, purple, gray, orange.
  const colors = ['#405bff', '#ff0000', '#00ff00', '#ffff00', '#00ffff', '#ff00ff', '#a0a0a0', '#ff8000'];
  const id = Number(colorId);
  return Number.isInteger(id) && id >= 0 && id < colors.length ? colors[id] : '#84928a';
}
function replayTimelineTime(milliseconds) {
  const seconds = Math.max(0, Number(milliseconds) || 0) / 1000;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function replayTimelineData(full, players, durationMs) {
  const playerIds = new Set(players.map(player => Number(player.player_number)).filter(Number.isFinite));
  const events = new Map([...playerIds].map(playerId => [playerId, []]));
  const excludedUnitIds = new Set([83, 13, 17, 128]);
  const lastResearchCommands = new Map();
  let lastTime = Number(durationMs) || 0;
  let firstTime = Infinity;
  for (const chapter of Array.isArray(full?.chapters) ? full.chapters : []) {
    for (const operation of Array.isArray(chapter?.operations) ? chapter.operations : []) {
      const action = operation?.Action;
      if (!action?.action_data) continue;
      const time = Number(action.world_time) || 0;
      lastTime = Math.max(lastTime, time);
      const dequeue = action.action_data.DeQueue;
      if (dequeue && Number.isFinite(Number(dequeue.player_id)) && Number.isFinite(Number(dequeue.unit_id)) && !excludedUnitIds.has(Number(dequeue.unit_id))) {
        const playerId = Number(dequeue.player_id);
        if (events.has(playerId)) { firstTime = Math.min(firstTime, time); events.get(playerId).push({ time, type: 'unit', id: Number(dequeue.unit_id), count: Math.max(1, Number(dequeue.amount) || 1) }); }
      }
      const research = action.action_data.Research;
      if (research && Number.isFinite(Number(research.player_id))) {
        const playerId = Number(research.player_id);
        if (events.has(playerId)) {
          const technologyId = Number(research.technology_type);
          const buildingIds = [...(research.building_ids || [research.building_id])].sort((a, b) => Number(a) - Number(b));
          const key = JSON.stringify([playerId, technologyId, buildingIds]);
          const previousTime = lastResearchCommands.get(key);
          lastResearchCommands.set(key, time);
          // Repeated clicks can emit identical research commands a few ticks apart.
          if (previousTime != null && time >= previousTime && time - previousTime <= 1000) continue;
          firstTime = Math.min(firstTime, time);
          events.get(playerId).push({ time, type: 'research', id: technologyId, count: 1 });
        }
      }
    }
  }
  const bucketSize = 2 * 60 * 1000;
  const start = Number.isFinite(firstTime) ? Math.floor(firstTime / bucketSize) * bucketSize : 0;
  const groupedEvents = new Map();
  for (const [playerId, items] of events.entries()) {
    const grouped = new Map();
    for (const item of items) {
      const bucket = Math.floor(item.time / bucketSize);
      const key = `${item.type}:${item.id}:${bucket}`;
      const current = grouped.get(key);
      if (current) {
        current.count += item.count;
        current.time = Math.min(current.time, item.time);
      } else {
        const bucketStart = bucket * bucketSize;
        grouped.set(key, {
          ...item,
          time: item.time,
          bucketStart,
          bucketEnd: bucketStart + bucketSize,
        });
      }
    }
    groupedEvents.set(playerId, [...grouped.values()].sort((a, b) => a.time - b.time));
  }
  return { events: groupedEvents, start, bucketSize, duration: Math.max(Math.ceil(lastTime / bucketSize) * bucketSize, start + bucketSize) };
}
function replayTimelineMarkup(full, players, durationMs) {
  const target = document.querySelector('#replayTimeline');
  if (!target) return;
  const { events, start, duration, bucketSize } = replayTimelineData(full, players, durationMs);
  const span = Math.max(duration - start, 60000);
  const totalEvents = [...events.values()].reduce((sum, items) => sum + items.length, 0);
  const groups = [...new Map(players.map(player => [player.teamIndex, players.filter(candidate => candidate.teamIndex === player.teamIndex)])).entries()];
  const bucketCount = Math.round(span / bucketSize);
  target.style.setProperty("--timeline-min-width", `${Math.max(776, 206 + bucketCount * 80)}px`);
  target.style.setProperty("--timeline-bucket-width", `${100 / bucketCount}%`);
  const ticks = Array.from({ length: bucketCount + 1 }, (_, index) => start + index * bucketSize);
  const tickMarkup = ticks.map(time => `<span style="left:${((time - start) / span * 100).toFixed(3)}%">${replayTimelineTime(time)}</span>`).join('');
  const rows = groups.flatMap(([teamIndex, teamPlayers]) => [`<div class="replay-timeline-team"><span>队伍 ${Number(teamIndex) + 1}</span>${replayResultBadge(teamPlayers, teamIndex)}</div>`, ...teamPlayers.map(player => {
    const playerId = Number(player.player_number);
    const items = (events.get(playerId) || []).sort((a, b) => a.time - b.time);
    const laneEnds = [];
    const laneGap = Math.max(12000, span * 0.018);
    items.forEach(item => {
      let lane = laneEnds.findIndex(end => item.time - end >= laneGap);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = item.time;
      item.lane = Math.min(lane, 2);
    });
    const name = escapeHtml(player.name || `玩家 ${playerId}`);
    const markers = items.map(item => {
      const info = item.type === 'unit' ? (replayUnitInfoById[item.id] || { name: `单位 ${item.id}`, icon: '' }) : (replayTechInfoById[item.id] || { name: `科技 ${item.id}`, icon: '' });
      const icon = info.icon ? `<img src="${escapeHtml(info.icon)}" alt="${escapeHtml(info.name)}" loading="lazy" onerror="this.hidden=true">` : '<span class="replay-timeline-placeholder">科技</span>';
      const count = item.count > 1 ? `×${item.count}` : '';
      const timeLabel = `${replayTimelineTime(item.bucketStart)}–${replayTimelineTime(item.bucketEnd)}`;
      return `<span class="replay-timeline-event replay-timeline-event-${item.type}" style="left:clamp(20px, ${Math.max(0, Math.min(100, (item.time - start) / span * 100)).toFixed(3)}%, calc(100% - 24px));--event-lane:${item.lane}" title="${escapeHtml(`${timeLabel} · ${info.name}${count ? ` ${count}` : ''}`)}">${icon}<b>${count}</b></span>`;
    }).join('');
    return `<div class="replay-timeline-row"><div class="replay-timeline-player"><span class="replay-timeline-color" style="--player-color:${replayPlayerColor(player.color_id)}"></span><strong>${name}</strong></div><div class="replay-timeline-track">${markers}</div></div>`;
  })]);
  target.innerHTML = totalEvents ? `<div class="replay-timeline-axis"><div></div><div class="replay-timeline-axis-track">${tickMarkup}</div></div>${rows.join('')}` : '<div class="replay-empty">录像中没有可读取的生产或研究事件。</div>';
  const count = document.querySelector('#replayTimelineCount');
  if (count) count.textContent = `${totalEvents} 个事件`;
}
function replayBoolLabel(value) {
  return value === true ? '是' : value === false ? '否' : '—';
}
function replayGameSettingMarkup(settings, summary) {
  const mapSizeNames = { 120: '极小型（2名玩家）[120]', 144: '小型（3名玩家）[144]', 168: '中型（4名玩家）[168]', 200: '普通型（6名玩家）[200]', 220: '大型（8名玩家）[220]', 240: '巨大型[240]', 480: '超常[480]' };
  const gameTypeNames = { '-1': '未知', 0: '随机地图', 1: '弑君', 2: '死亡竞赛', 3: '场景', 6: '山丘之王', 7: '奇观竞速', 8: '守护奇观', 9: '极速随机地图', 10: '遗迹争夺', 11: '突然死亡', 12: '大逃杀', 13: '帝国战争' };
  const mapName = replayMapName(settings);
  const gameType = settings.game_type == null ? '—' : (gameTypeNames[String(settings.game_type)] || '自定义游戏');
  const mapSize = Number(settings.map_size);
  const speed = Number(settings.speed);
  const replaySpeed = Number(summary?.header?.game_speed);
  const speedValue = Number.isFinite(speed) && speed > 0 ? `×${speed.toFixed(2)}` : Number.isFinite(replaySpeed) && replaySpeed > 0 ? `×${replaySpeed.toFixed(2)}` : '—';
  const rows = [
    ['游戏类型', gameType],
    ['地图', mapName],
    ['地图尺寸', mapSizeNames[mapSize] || (Number.isFinite(mapSize) && mapSize > 6 ? `${mapSize}×${mapSize}` : '—')],
    ['人口上限', Number(settings.population_limit) > 0 ? String(settings.population_limit) : '—'],
    ['游戏速度', speedValue],
    ['迷雾', replayBoolLabel(settings.fog_of_war)],
    ['共享探索', replayBoolLabel(settings.shared_exploration)],
    ['排名对局', replayBoolLabel(settings.ranked)],
    ['匹配对局', replayBoolLabel(settings.matchmaking)],
    ['作弊', replayBoolLabel(settings.cheats)]
  ];
  return rows.map(([label, value]) => `<div class="replay-setting-item"><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong></div>`).join('');
}
function replayMapName(settings) {
  // AoE2:DE map constants. Prefer the recorded script name below when present,
  // but use this complete built-in map table when a replay only stores an ID.
  const mapNamesById = {
    9:'阿拉伯',10:'群岛',11:'波罗的海',12:'黑森林',13:'海岸',14:'大陆',15:'陨石湖',16:'堡垒',17:'黄金国',18:'高地',19:'岛屿',20:'地中海',21:'迁徙',22:'河流',23:'团队岛屿',25:'斯堪的纳维亚',26:'蒙古',27:'尤卡坦',28:'盐沼',29:'竞技场',30:'山丘之王',31:'绿洲',32:'幽灵湖',33:'游牧',34:'运河',35:'反复无常',36:'丁戈',37:'墓地',38:'大都会',39:'护城河',40:'天堂岛',41:'朝圣者',42:'草原',43:'四季',44:'舍伍德森林',46:'海难',47:'团队冰川',49:'现实世界：西班牙',50:'现实世界：英格兰',51:'现实世界：中东',52:'现实世界：德州',53:'现实世界：意大利',54:'现实世界：加勒比',55:'现实世界：法国',56:'现实世界：日德兰',57:'现实世界：日本',58:'现实世界：拜占庭',59:'自定义地图',67:'卫城',68:'布达佩斯',69:'塞诺特',70:'湖城',71:'黄金坑',72:'藏身处',73:'山堡',74:'伦巴第',75:'草原',76:'山谷',77:'大随机地图',78:'汉堡',79:'征服者：随机地图',80:'征服者：季风',81:'征服者：金字塔下降',82:'征服者：螺旋',83:'乞力马扎罗',84:'山口',85:'尼罗河三角洲',86:'塞伦盖蒂',87:'索科特拉',88:'现实世界：亚马逊',89:'现实世界：中国',90:'现实世界：非洲之角',91:'现实世界：印度',92:'现实世界：马达加斯加',93:'现实世界：西非',94:'现实世界：波希米亚',95:'现实世界：地球',96:'峡谷',97:'特殊群岛',98:'敌方岛屿',99:'遥远之地',100:'前线',101:'内圈',102:'祖国',103:'开阔平原',104:'水环',105:'蛇坑',106:'天眼',107:'现实世界：澳大利亚',108:'现实世界：印度支那',109:'现实世界：印度尼西亚',110:'现实世界：马六甲',111:'现实世界：菲律宾',112:'沼泽群岛',113:'红树林丛林',114:'太平洋群岛',115:'沙洲',116:'水上游牧',117:'丛林群岛',118:'圣线',119:'边境石',120:'阴阳',121:'丛林小径',122:'阿尔卑斯湖',123:'沼泽地',124:'山脊',125:'峡谷',126:'狼丘',127:'旋转河流',128:'双森林',129:'南行',130:'蛇形森林',131:'蔓延溪流',132:'现实世界：南极洲',133:'现实世界：阿拉尔海',134:'现实世界：黑海',135:'现实世界：高加索',136:'现实世界：西伯利亚',137:'自定义地图池',139:'黄金沼泽',140:'四湖',141:'陆地游牧',142:'冰上之战',143:'黄金国',144:'阿克苏姆之战',145:'罗马之战',146:'满者伯夷帝国',147:'亚马逊隧道',148:'海岸森林',149:'非洲林中空地',150:'阿塔卡马',151:'夺取山峰',152:'陨石坑',153:'十字路口',154:'米奇',155:'团队护城河',156:'火山岛',157:'斜坡',158:'喷发',159:'冰湖',160:'格陵兰',161:'低地',162:'市场',163:'草甸',164:'山脉',165:'北方群岛',166:'环形堡垒',167:'符文石',168:'余波',169:'封闭',170:'沙丘',171:'卡瓦桑',172:'陆地狂潮',173:'神圣泉',174:'浅滩',175:'沼泽',176:'浅滩群岛',177:'悬崖',178:'地峡',179:'沙丘泉',180:'黄金溪流',181:'山地沙丘',182:'河流分界',183:'沙漂',184:'灌木地',185:'通道',186:'空心林地',187:'喀斯特',188:'林间空地',189:'强化空地',190:'竞技场阿拉伯',191:'竞技场强化空地',192:'竞技场林间空地',193:'竞技场游牧',194:'竞技场符文石',195:'竞技场竞技场',196:'竞技场黑森林',197:'现实世界：满洲',198:'边境争端',199:'霰弹',200:'搁浅',201:'萨迪斯',202:'水上竞技场',203:'森林突破',204:'混沌坑',205:'泥沼',206:'暗林',207:'皇冠林',208:'多萝西娅采石场',209:'冰川',210:'亨格霍尔德',211:'尼斯湖',212:'壁垒',213:'石墙',214:'泰晤士',215:'狐形',216:'阿拉伯沙漠'
  };
  const resolvedMapId = Number(settings?.resolved_map_id ?? settings?.selected_map_id);
  if (resolvedMapId !== 59 && mapNamesById[resolvedMapId]) return mapNamesById[resolvedMapId];
  const lobbyName = String(settings?.lobby_name || '').trim();
  const mapStrings = Array.isArray(settings?.rms_strings) ? settings.rms_strings.map(value => String(value || '').trim()).map(value => {
    const subscribedMap = value.match(/(?:^|:)RANDOM_MAPS:([^:]+?\.rms)(?=:|$)/i) || value.match(/(?:^|:)([^:]+?\.rms)(?=:|$)/i);
    return subscribedMap ? subscribedMap[1].replace(/\.rms$/i, '') : value;
  }).filter(value => value && !/^none|null|undefined$/i.test(value) && !/^(?:NONE|SUBSCRIBEDMODS)(?::|$)/i.test(value)) : [];
  const mapName = mapStrings.find(value => value !== lobbyName);
  if (!mapName) return mapNamesById[resolvedMapId] || '未知地图';
  return /^[A-Z0-9 _-]+$/.test(mapName) ? mapName.toLowerCase().replace(/(^|[ -])[a-z]/g, value => value.toUpperCase()).replace(/\bDe\b/g, 'DE') : mapName;
}
function replayStartTimeZone(timestamp) {
  const value = Number(timestamp);
  const date = Number.isFinite(value) && value > 0 ? new Date(value * 1000) : new Date();
  const offset = -date.getTimezoneOffset();
  const minutes = Math.abs(offset);
  return `UTC${offset >= 0 ? '+' : '-'}${Math.floor(minutes / 60)}${minutes % 60 ? `:${String(minutes % 60).padStart(2, '0')}` : ''}`;
}
function replayStartTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '未记录';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value * 1000));
}
async function replayLoadMatchInfo(matchId, requestId, recordedStart) {
  try {
    const response = await fetch(`/api/replay-match-info?matchId=${encodeURIComponent(matchId)}`, { headers: { 'X-AOE2-Client': 'web' }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return;
    const info = await response.json();
    if (requestId !== replayAnalysisRequest || String(info.matchId) !== String(matchId)) return;
    if (recordedStart > 0 && info.started > 0 && Math.abs(recordedStart - info.started) > 300) return;
    const time = document.querySelector('[data-replay-summary-field="startedAt"] strong');
    const server = document.querySelector('[data-replay-summary-field="server"] strong');
    if (time && info.started) { time.textContent = replayStartTime(info.started); time.title = time.textContent; time.closest('.replay-summary-item')?.querySelector('small')?.replaceChildren(`开始时间（${replayStartTimeZone(info.started)}）`); }
    if (server && info.server) { server.textContent = realtimeServerName(info.server); server.title = info.server; }
    replayApplyMatchResults(info);
  } catch { /* Optional match metadata must not interrupt local replay analysis. */ }
}
let replayResultPlayers = [];
function replayResultBadge(teamPlayers, teamIndex) {
  const won = teamPlayers.some(player => player.winner === true);
  const lost = teamPlayers.length && teamPlayers.every(player => player.winner === false);
  return `<b data-replay-team-result="${teamIndex}" class="${won ? 'replay-result-win' : lost ? 'replay-result-loss' : 'replay-result-unknown'}">${won ? '胜者' : lost ? '失败' : '未判定'}</b>`;
}
function replayApplyMatchResults(info) {
  const outcomes = new Map((Array.isArray(info?.results) ? info.results : []).filter(player => typeof player.won === 'boolean').map(player => [String(player.profileId), player.won]));
  replayResultPlayers.forEach(player => { player.winner = outcomes.get(String(player.profile_id)) ?? null; });
  document.querySelectorAll('[data-replay-team-result]').forEach(badge => {
    const teamIndex = Number(badge.dataset.replayTeamResult);
    badge.outerHTML = replayResultBadge(replayResultPlayers.filter(player => player.teamIndex === teamIndex), teamIndex);
  });
}
function replaySummaryMarkup(summary, full, file, matchInfo = null) {
  const settings = summary?.header?.game_settings || {};
  const header = summary?.header || {};
  const replayBuild = replayValue(header.build) || '—';
  const players = (summary?.teams || []).flatMap((team, teamIndex) => (team.players || []).map(player => ({
    name: replayValue(player.name),
    profile_id: player.profile_id,
    player_number: player.player_number,
    color_id: player.color_id,
    civ_id: player.civ_id,
    custom_civ_ids: Array.isArray(player.custom_civ_ids) ? player.custom_civ_ids : [],
    resigned: Boolean(player.resigned),
    teamIndex,
    winner: null
  })));
  replayResultPlayers = players;
  replayApplyMatchResults(matchInfo);
  const playerNames = new Map(players.map(player => [String(player.player_number), player.name]));
  const chat = replayFindChat(full, playerNames);
  const playerStats = replayPlayerStats(full, summary?.duration, players, replayEapmModule.replayGameSpeed(summary));
  const operations = Array.isArray(full?.operations) ? full.operations.length : 0;
  document.querySelector('#replaySummary').innerHTML = [['版本号', replayBuild], ['游戏时长', replayFormatTime((Number(summary?.duration) || 0) / 1000)], ['地图', replayMapName(settings)], ['房间名', settings.lobby_name || '—'], ['玩家', players.length], [`开始时间（${replayStartTimeZone(matchInfo?.started || header.timestamp)}）`, replayStartTime(matchInfo?.started || header.timestamp), 'startedAt'], ['服务器位置', matchInfo?.server ? realtimeServerName(matchInfo.server) : '未记录', 'server'], ['地图种子', Number.isInteger(summary?.mapSeed) ? String(summary.mapSeed) : '未记录', 'mapSeed']].map(([label, value, field]) => `<div class="replay-summary-item${field === 'startedAt' ? ' replay-summary-time' : ''}"${field ? ` data-replay-summary-field="${field}"` : ''}><small>${escapeHtml(label)}</small><strong title="${escapeHtml(String(value ?? '—'))}">${escapeHtml(String(value ?? '—'))}</strong></div>`).join('');
  const replayGameSettings = document.querySelector('#replayGameSettings');
  if (replayGameSettings) replayGameSettings.innerHTML = replayGameSettingMarkup(settings, summary);
  const teamGroups = [...new Map(players.map(player => [player.teamIndex, players.filter(candidate => candidate.teamIndex === player.teamIndex)])).entries()];
    document.querySelector('#replayPlayers').innerHTML = teamGroups.length ? teamGroups.map(([teamIndex, teamPlayers]) => `<section class="replay-team"><div class="replay-team-heading"><strong>队伍 ${Number(teamIndex) + 1}</strong>${replayResultBadge(teamPlayers, teamIndex)}</div><div class="replay-player-columns"><span aria-hidden="true"></span><span>玩家 / 文明</span><span>eAPM</span><span>最多队列单位</span></div>${teamPlayers.map(player => { const stat = playerStats.get(String(player.player_number)); const queued = replayQueuedUnitInfo(stat); const playerName = escapeHtml(player.name || `玩家 ${player.player_number ?? ''}`); const profileLink = player.profile_id ? `<a class="replay-player-name-link" href="/profile/${encodeURIComponent(String(player.profile_id))}">${playerName}</a>` : `<strong>${playerName}</strong>`; const civIcon = replayCivIcon(player); return `<div class="replay-player-row"><span class="replay-player-color" style="--player-color:${replayPlayerColor(player.color_id)}"></span><div><strong>${profileLink}</strong><small class="replay-player-civ">${civIcon ? `<img src="${escapeHtml(civIcon)}" alt="" loading="lazy" onerror="this.hidden=true">` : ''}<span>${escapeHtml(replayCivLabel(player))}</span></small></div><span class="replay-player-eapm">${stat ? stat.eapm.toFixed(1) : '—'}</span><span class="replay-player-queue">${queued.length ? queued.map(unit => `<span class="replay-player-queue-item" title="${escapeHtml(`${unit.name} × ${unit.count}`)}">${unit.icon ? `<img src="${escapeHtml(unit.icon)}" alt="${escapeHtml(unit.name)}" loading="lazy" onerror="this.hidden=true">` : ''}<span>${escapeHtml(`${unit.name} × ${unit.count}`)}</span></span>`).join('') : '—'}</span></div>`; }).join('')}</section>`).join('') : '<div class="replay-empty">未读取到玩家资料。</div>';
  document.querySelector('#replayPlayerCount').textContent = `${players.length} 人`;
  document.querySelector('#replayChatCount').textContent = `${chat.length} 条`;
  replayTimelineMarkup(full, players, summary?.duration);
  const mapTarget = document.querySelector('#replayMap');
  if (mapTarget) {
    const mapRequest = replayAnalysisRequest;
    import('/replay-map.js?v=26').then(module => {
      const mapPlayers = players.map(player => ({...player,displayName:`${player.name} (${replayCivLabel(player)})`}));
      if (mapRequest === replayAnalysisRequest) module.renderReplayMap(mapTarget, full, mapPlayers, summary?.duration, replayPlayerColor, { units:replayUnitInfoById, techs:replayTechInfoById, chat, settings, gameSpeed: replayEapmModule.replayGameSpeed(summary) });
    }).catch(error => { if (mapRequest === replayAnalysisRequest) mapTarget.textContent = `地图读取失败：${error.message}`; });
  }
  document.querySelector('#replayOperationCount')?.remove();
   document.querySelector('#replayChat').innerHTML = chat.length ? chat.map(message => { const sender = players.find(player => String(player.player_number) === message.playerId) || players.find(player => player.name === message.player); const colorId = Number(sender?.color_id); const chatColor = sender && Number.isInteger(colorId) && colorId >= 0 && colorId < 8 ? `var(--replay-chat-color-${colorId})` : 'var(--text)'; return `<div class="replay-chat-row" style="--chat-player-color:${chatColor}"><time>${message.time == null ? '—' : replayFormatTime(message.time / 1000)}</time><strong>${escapeHtml(message.player || '玩家')}</strong><span>${escapeHtml(message.text)}</span></div>`; }).join('') : '<div class="replay-empty">未发现可读取的聊天记录。</div>';
  document.querySelector('#replayResult').hidden = false;
}
let replayAnalysisRequest = 0;
async function loadServerReplay(matchId, profileId, startAnalysis = false) {
  const requestId = ++replayAnalysisRequest;
  const status = document.querySelector('#replayStatus');
  const result = document.querySelector('#replayResult');
  const retry = document.querySelector('#replayRemoteRetry');
  result.hidden = true;
  retry.hidden = true;
  status.textContent = '正在获取录像分析，请稍候……';
  try {
    let response = await fetch(`/api/replay-analysis?matchId=${encodeURIComponent(matchId)}&profileId=${encodeURIComponent(profileId)}`, { method: startAnalysis ? 'POST' : 'GET', headers: { 'X-AOE2-Client': 'web' }, signal: AbortSignal.timeout(25000) });
    let data = await response.json();
    if (!startAnalysis && response.status === 404 && data.code === 'ANALYSIS_REQUIRED') {
      if (requestId !== replayAnalysisRequest) return;
      status.textContent = '该录像尚未分析，点击“开始分析”获取结果。';
      retry.textContent = '开始分析'; retry.hidden = false;
      return;
    }
    if (!response.ok) throw new Error(data.error || '获取录像分析失败');
    if (response.status === 202) {
      const pollUrl = data.pollUrl;
      if (typeof pollUrl !== 'string' || !pollUrl.startsWith('/api/replay-analysis/status?jobId=')) throw new Error('分析任务无效');
      const deadline = Date.now() + 5 * 60000;
      status.textContent = '录像正在分析，请稍候……';
      while (response.status === 202) {
        if (requestId !== replayAnalysisRequest) return;
        if (Date.now() >= deadline) throw new Error('分析仍在处理中，请稍后重试');
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (requestId !== replayAnalysisRequest) return;
        response = await fetch(pollUrl, { headers: { 'X-AOE2-Client': 'web' }, signal: AbortSignal.timeout(25000), cache: 'no-store' });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || '获取录像分析失败');
      }
    }
    await Promise.all([replayLoadUnitMap(), replayLoadTechMap(), replayLoadEapm()]);
    if (requestId !== replayAnalysisRequest) return;
    replaySummaryMarkup(data.summary, data.full, data.file, data.matchInfo);
    if (!data.matchInfo?.server || !Array.isArray(data.matchInfo?.results)) replayLoadMatchInfo(matchId, requestId, Number(data.summary?.header?.timestamp) || 0);
    const cacheDuration = Number(data.expiresAt) - Number(data.generatedAt) > 86400000 ? '7 天' : '30 分钟';
    status.textContent = `${response.headers.get('x-replay-cache') === 'HIT' ? '已读取缓存分析' : '录像分析完成'}。分析结果缓存 ${cacheDuration}。`;
  } catch (error) {
    if (requestId !== replayAnalysisRequest) return;
    result.hidden = true;
    status.textContent = `分析失败：${error?.message || '请稍后重试'}`;
    retry.textContent = '重试分析';
    retry.hidden = false;
  }
}
async function parseReplayFile(file) {
  const requestId = ++replayAnalysisRequest;
  document.querySelector('#replayRemoteRetry').hidden = true;
  const status = document.querySelector('#replayStatus');
  const result = document.querySelector('#replayResult');
  result.hidden = true;
  status.textContent = '正在本地解析录像，请稍候……';
  try {
    await Promise.all([replayLoadUnitMap(), replayLoadTechMap(), replayLoadEapm()]);
    replayParserModule ||= await import('/assets/aoe2rec/aoe2rec-browser.js');
    const buffer = await file.arrayBuffer();
    const summary = replayParserModule.parse_rec_summary(buffer);
    const { extractReplayMapSeed } = await import('/replay-map-seed.js?v=1');
    summary.mapSeed = await extractReplayMapSeed(buffer, summary);
    let full = null;
    try { full = replayParserModule.parse_rec(buffer); } catch (error) { console.warn('录像完整操作解析失败', error); }
    if (requestId !== replayAnalysisRequest) { summary?.free?.(); return; }
    replaySummaryMarkup(summary, full || {}, file);
    const matchId = file.name?.match(/(?:Replay_|aoe2-match-)(\d+)/i)?.[1];
    if (matchId) replayLoadMatchInfo(matchId, requestId, Number(summary?.header?.timestamp) || 0);
    status.textContent = full ? '解析完成。文件未上传服务器。' : '基础资料解析完成，完整操作流暂时无法读取。';
    summary?.free?.();
  } catch (error) {
    if (requestId !== replayAnalysisRequest) return;
    result.hidden = true;
    status.textContent = `解析失败：${error?.message || '录像格式不受支持或版本过新'}`;
  }
}
function setupReplayAnalysis() {
  if (replayAnalysisLoaded) return;
  replayAnalysisLoaded = true;
  const input = document.querySelector('#replayFile');
  input?.addEventListener('change', () => { const file = input.files?.[0]; if (file) parseReplayFile(file); });
  const params = new URLSearchParams(location.search);
  const matchId = params.get('matchId');
  const profileId = params.get('profileId');
  if (matchId && profileId) {
    document.querySelector('.replay-analysis-heading p').textContent = `比赛 #${matchId} · 分析结果最多保留 7 天，也可以选择本地录像。`;
    document.querySelector('#replayRemoteRetry').onclick = () => loadServerReplay(matchId, profileId, true);
    loadServerReplay(matchId, profileId);
  }

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
    select.onchange = () => { const url=new URL(location.href); url.searchParams.set('articleId',select.value); history.replaceState(history.state,'',url); loadUpdates(select.value); };
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
  if (/双刃斧|雙刃斧/.test(action)) return icon('axe-tech');
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
function renderRealtimeChat(messages) {
  const box = document.querySelector('#realtimeChatMessages');
  if (!box) return;
  const items = Array.isArray(messages) ? messages : [];
  const key = JSON.stringify(items.map(item => [item.id, item.author, item.uid]));
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
    content.textContent = String(item.content || '');
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
function realtimeServerName(value) {
  const text = String(value || '').trim().toLowerCase();
  const names = { ukwest: '英国西部', uksouth: '英国南部', koreacentral: '韩国中部', centralindia: '印度中部', southcentralus: '美国中南部', eastus: '美国东部', eastus2: '美国东部 2', westus: '美国西部', westus2: '美国西部 2', westus3: '美国西部 3', japaneast: '日本东部', southeastasia: '东南亚', australiaeast: '澳大利亚东部', australiasoutheast: '澳大利亚东南部', brazilsouth: '巴西南部', westeurope: '西欧', northeurope: '北欧' };
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
  const tournamentBestOf = Number(match.tournament?.bestOf);
  const bestOf = Number.isInteger(tournamentBestOf) && tournamentBestOf > 0 ? tournamentBestOf : Number(match.bestOf);
  const format = Number.isInteger(bestOf) && bestOf > 0 ? `BO${bestOf}` : '';
  const eventMeta = tournamentName ? `<span class="realtime-status-match-meta">（${escapeHtml(format || '赛事')}，${escapeHtml(score)}）</span>` : '';
  return `<span class="realtime-status-activity"><a class="realtime-status-live-link" href="aoe2de://1/${encodeURIComponent(String(match.id || null))}" title="在游戏内观战">◉ ${escapeHtml(label)}</a>${eventMeta}</span>`;
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
function renderRealtimeStatus(states) {
  const target = document.querySelector('#realtimeStatusRows');
  if (!target) return;
  const visible = (Array.isArray(states) ? states : []).filter(state => realtimeStateIsActive(state) || state?.live?.url || Number(state?.graceUntil) > Date.now());
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
  const ratingForSort = state => {
    const rating = Number(state?.player?.rating);
    return Number.isFinite(rating) && rating > 0 ? rating : -1;
  };
  const list = [...identityMap.values()].sort((a, b) => ratingForSort(b) - ratingForSort(a));
  if (!list.length) { target.innerHTML = '<tr><td colspan="6">暂无选手</td></tr>'; return; }
  target.innerHTML = list.map(state => {
    const player = state.player || {};
    const activity = realtimeStatusActivity(state);
    const numericRating = Number(player.rating);
    const rating = player.rating !== null && player.rating !== undefined && Number.isFinite(numericRating) ? numericRating.toLocaleString('zh-CN') : '—';
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
    return `<tr><td>${rating}</td><td><a class="realtime-status-player" title="${name}" href="/profile/${encodeURIComponent(String(state.profileId || ''))}">${countryFlag(player.country)}<span>${name}</span></a></td><td>${team}</td><td class="${activity ? 'realtime-status-active' : ''}">${activity}</td><td><span class="realtime-status-tournament" title="${escapeHtml(tournamentName)}">${tournament || '—'}</span></td><td>${live}</td></tr>`;
  }).join('');
  alignRealtimeStatusActivity();
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
  const rating=player.ratingMode==='rm_1v1'?Number(player.rating):NaN;
  const ratingText=Number.isFinite(rating)&&rating>0?rating.toLocaleString('zh-CN'):'—';
  return `<div class="realtime-player-row"><span class="realtime-player-number" style="background:${escapeHtml(realtimePlayerColor(number,index))}">${number}</span><span class="realtime-country">${countryFlag(player.country)}</span><a class="realtime-player-name" href="/profile/${encodeURIComponent(String(player.profileId||null))}"><strong>${escapeHtml(player.name||`玩家 ${player.profileId||''}`)}</strong></a><span class="realtime-player-civ">${realtimeCivIconMarkup(player.civilizationId)}${escapeHtml(civilizationNameZh(player.civilization||'未知文明'))}</span><span class="realtime-player-rating" title="1v1 随机地图分数">${ratingText}</span></div>`;
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
    const ratings=(Array.isArray(state?.match?.players)?state.match.players:[]).filter(player=>player.ratingMode==='rm_1v1').map(player=>Number(player.rating)).filter(rating=>Number.isFinite(rating)&&rating>0);
    return ratings.length?ratings.reduce((sum,rating)=>sum+rating,0)/ratings.length:-Infinity;
  };
  const games=[...new Map(states.filter(realtimeStateIsActive).map(state=>[String(state.match.id||state.profileId),state])).values()]
    .sort((a,b)=>Number(Boolean(b.match?.tournament || b.match?.event || b.match?.eventName))-Number(Boolean(a.match?.tournament || a.match?.event || a.match?.eventName))||matchAverageRating(b)-matchAverageRating(a)||Number(b.match?.started||0)-Number(a.match?.started||0));
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
  startRealtimeChat();
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

const feedbackSponsorToggle = document.querySelector('#feedbackSponsorToggle');
feedbackSponsorToggle?.addEventListener('click', () => {
  const qr = document.querySelector('#feedbackSponsorQr');
  if (!qr) return;
  qr.hidden = !qr.hidden;
  feedbackSponsorToggle.setAttribute('aria-expanded', String(!qr.hidden));
});
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
async function loadRecentFeedback() {
  const target = document.querySelector('#feedbackRecent');
  if (!target) return;
  try {
    const response = await fetch('/api/feedback/recent', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取反馈失败');
    const items = Array.isArray(data.items) ? data.items.slice(0, 15) : [];
    target.innerHTML = items.length ? items.map(item => {
      const date = new Date(item.sentAt);
      const time = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date) : '时间未记录';
      return `<article class="feedback-entry"><div class="feedback-entry-ip">IP · ${escapeHtml(item.ip || '未知')}</div><p>${escapeHtml(item.content || '')}</p><div class="feedback-entry-actions"><time datetime="${escapeHtml(item.sentAt || '')}">${escapeHtml(time)} · 北京时间</time><button type="button" class="feedback-like${item.liked ? ' is-liked' : ''}" data-feedback-id="${escapeHtml(item.id || '')}" aria-pressed="${Boolean(item.liked)}" title="每个IP对每条反馈最多点赞一次" ${item.liked ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10H3v10h4M7 10l5-7c1.5 0 2 1 2 2l-1 5h6a2 2 0 0 1 2 2l-2 7a2 2 0 0 1-2 1H7z"/></svg><span class="feedback-like-label">${item.liked ? '已点赞' : '点赞'}</span><span class="feedback-like-count">${Number(item.likes) || 0}</span></button><span class="feedback-like-status" role="status"></span></div></article>`;
    }).join('') : '<p class="feedback-feed-empty">暂时还没有反馈。</p>';
  } catch {
    target.innerHTML = '<p class="feedback-feed-empty">暂时无法读取反馈，请稍后刷新。</p>';
  }
}
document.querySelector('#feedbackRecent')?.addEventListener('click', async event => {
  const button = event.target.closest('.feedback-like');
  if (!button || button.disabled) return;
  button.disabled = true;
  const status = button.closest('.feedback-entry-actions').querySelector('.feedback-like-status');
  status.textContent = '';
  try {
    const response = await fetch('/api/feedback/like', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: button.dataset.feedbackId }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '点赞失败，请稍后重试');
    button.classList.add('is-liked'); button.setAttribute('aria-pressed','true');
    button.querySelector('.feedback-like-label').textContent = '已点赞';
    button.querySelector('.feedback-like-count').textContent = String(data.likes);
    status.textContent = data.added ? '点赞成功' : '这个IP已为这条反馈点赞';
  } catch (error) { button.disabled = false; status.textContent = error.message; }
});
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
    loadRecentFeedback();
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
  return /^[A-Z]{2}$/.test(rawCode) ? [...rawCode].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('') : '🌐';
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
    const countryPriority = { CN: 0, TW: 1, HK: 2 };
    countrySelect.innerHTML = '<option value="all">全部国家 / 地区</option>' + [...countries.entries()].sort((a, b) => {
      const rankA = countryPriority[a[0]] ?? 99;
      const rankB = countryPriority[b[0]] ?? 99;
      return rankA - rankB || a[1].name.localeCompare(b[1].name, 'zh-CN');
    }).map(([value, item]) => `<option value="${escapeHtml(value)}" aria-label="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`).join('');
    if ([...countrySelect.options].some(option => option.value === eventsCountryFilter)) countrySelect.value = eventsCountryFilter;
    else eventsCountryFilter = countrySelect.value = 'all';
  }
  if (tournamentSelect) {
    const tierOrder = { 'S-Tier': 0, 'A-Tier': 1, 'B-Tier': 2, 'C-Tier': 3, 'Showm.': 4, 'Mon.': 5, Other: 6 };
    const tournamentMeta = Array.isArray(eventsTournamentsPayload?.tournaments) ? eventsTournamentsPayload.tournaments : [];
    const normalizeTournamentName = value => String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
    const tierForTournament = name => {
      const normalized = normalizeTournamentName(name);
      const item = tournamentMeta.find(entry => {
        const candidate = normalizeTournamentName(entry.name);
        return candidate === normalized || normalized.startsWith(`${candidate} `) || candidate.startsWith(`${normalized} `);
      });
      return item?.tier || 'Other';
    };
    const orderedTournaments = [...tournaments].sort((a, b) => {
      const rankA = tierOrder[tierForTournament(a)] ?? tierOrder.Other;
      const rankB = tierOrder[tierForTournament(b)] ?? tierOrder.Other;
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
  const monthNumbers = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const eventTime = (item, status, part = 'start') => {
    const raw = String(item?.dates || '');
    const match = raw.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:\s*[-–]\s*(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+)?(\d{1,2}))?\b/);
    if (!match) return null;
    const now = new Date();
    const startMonth = monthNumbers[match[1]];
    const startDay = Number(match[2]);
    let startYear = now.getFullYear();
    if (status === 'Upcoming' && startMonth < now.getMonth()) startYear += 1;
    if (status !== 'Upcoming' && startMonth > now.getMonth()) startYear -= 1;
    if (part === 'start' || !match[4]) return Date.UTC(startYear, startMonth, startDay);
    const endMonth = match[3] ? monthNumbers[match[3]] : startMonth;
    const endYear = endMonth < startMonth ? startYear + 1 : startYear;
    return Date.UTC(endYear, endMonth, Number(match[4]));
  };
  const groups = ['Ongoing', 'Upcoming', 'Completed'].map(status => ({
    status,
    items: items.filter(item => item.status === status).sort((a, b) => {
      const direction = status === 'Completed' ? -1 : 1;
      const at = eventTime(a, status, status === 'Completed' ? 'end' : 'start');
      const bt = eventTime(b, status, status === 'Completed' ? 'end' : 'start');
      if (at === null && bt !== null) return 1;
      if (at !== null && bt === null) return -1;
      return (at === null || bt === null ? 0 : direction * (at - bt)) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    })
  })).filter(group => group.items.length);
  const card = item => {
    const logo = item.logo
      ? `<div class="events-tournament-card-logo"><img src="${escapeHtml(item.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
      : '<div class="events-tournament-card-logo" aria-hidden="true">♜</div>';
    return `<article class="events-tournament-card">${logo}<div class="events-tournament-card-body"><b class="events-tournament-tier">${escapeHtml(tierText[item.tier] || '其它')}</b><h4>${item.url ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a>` : escapeHtml(item.name)}</h4><small>${escapeHtml(translateDates(item.dates))}</small></div></article>`;
  };
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
  }
}

function startEventsPolling() {
  clearInterval(eventsPollTimer);
  eventsRefreshRemaining = 60;
  loadEvents();
  eventsPollTimer = setInterval(() => {
    eventsRefreshRemaining -= 1;
    if (eventsRefreshRemaining <= 0) loadEvents();
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
  const isCivilizationsPage = /^\/civilizations\/?$/.test(location.pathname);
  const isTechTreePage = /^\/tech-tree\/?$/.test(location.pathname);
  const isMediaVideosPage = /^\/media\/videos\/?$/.test(location.pathname);
  const isMediaPage = isMediaVideosPage || /^\/media\/?$/.test(location.pathname);
  const isReplayAnalysisPage = /^\/replay-analysis\/?$/.test(location.pathname);
  const isUpdatesPage = /^\/updates\/?$/.test(location.pathname);
  const isRealtimePage = /^\/realtime\/?$/.test(location.pathname);
  const isEventsPage = /^\/events\/?$/.test(location.pathname);
  const isEventResultsPage = /^\/events\/results\/?$/.test(location.pathname);
  const isFeedbackPage = /^\/feedback\/?$/.test(location.pathname);
  const buildOrderMatch = location.pathname.match(/^\/build-orders(?:\/([a-z0-9-]+))?\/?$/i);
  const isBuildOrdersPage = Boolean(buildOrderMatch);
  const buildOrderSlug = buildOrderMatch?.[1] || '';
  const profileId = match?.[1] || '';
  syncUpdatesBackToTop();
  document.body.classList.toggle('page-profile', isProfilePage);
  document.body.classList.toggle('page-civilizations', isCivilizationsPage);
  document.body.classList.toggle('page-tech-tree', isTechTreePage);
  document.body.classList.toggle('page-media', isMediaPage);
  document.body.classList.toggle('page-replay-analysis', isReplayAnalysisPage);
  document.body.classList.toggle('page-updates', isUpdatesPage);
  document.body.classList.toggle('page-realtime', isRealtimePage);
  document.body.classList.toggle('page-events', isEventsPage || isEventResultsPage);
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
  const moduleName = isTechTreePage ? 'tech-tree' : isCivilizationsPage ? 'civilizations' : isProfilePage ? 'profile' : isMediaPage ? 'media' : isReplayAnalysisPage ? 'replay-analysis' : isUpdatesPage ? 'updates' : isRealtimePage ? 'realtime' : (isEventsPage || isEventResultsPage) ? 'events' : isBuildOrdersPage ? 'build-orders' : isFeedbackPage ? 'feedback' : 'leaderboard';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(moduleArtworkKey) || '{}'); } catch {}
  const order = Array.isArray(saved.order) && saved.order.length === moduleArtworkFiles.length
    ? saved.order
    : moduleArtworkFiles.map((_, index) => index).sort(() => Math.random() - 0.5);
  const moduleSlots = ['leaderboard', 'profile', 'realtime', 'events', 'media', 'replay-analysis', 'updates', 'build-orders', 'feedback', 'civilizations', 'tech-tree'];
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
    ? 'body:not(.page-tech-tree):not(.page-civilizations):not(.page-profile):not(.page-media):not(.page-replay-analysis):not(.page-updates):not(.page-realtime):not(.page-events):not(.page-build-orders):not(.page-feedback)'
    : `body.page-${moduleName}`;
  moduleArtworkStyle.textContent = `${moduleSelector} #leaderboard:before{background-image:linear-gradient(90deg,var(--bg) 0%,rgba(16,19,16,.54) 30%,rgba(16,19,16,.08)),url("${moduleArtworkFiles[selected]}")!important}`;
  try { localStorage.setItem(moduleArtworkKey, JSON.stringify({ order })); } catch {}
  const image = new Image();
  image.src = moduleArtworkFiles[selected];
  document.querySelector('#civilizations-page').hidden = !isCivilizationsPage;
  document.querySelector('#tech-tree-page').hidden = !isTechTreePage;
  document.querySelector('#player-profile').hidden = !isProfilePage;
  document.querySelector('#media-page').hidden = !isMediaPage;
  const replayAnalysisSection = document.querySelector('#replay-analysis-page');
  if (replayAnalysisSection) replayAnalysisSection.hidden = !isReplayAnalysisPage;
  document.querySelector('#updates-page').hidden = !isUpdatesPage;
  document.querySelector('#realtime-page').hidden = !isRealtimePage;
  document.querySelector('#events-page').hidden = !isEventsPage;
  document.querySelector('#event-results-page').hidden = !isEventResultsPage;
  document.querySelector('#build-orders-page').hidden = !isBuildOrdersPage;
  document.querySelector('#feedback-page').hidden = !isFeedbackPage;
  document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(link => {
    const activePage = isTechTreePage ? 'tech-tree' : isCivilizationsPage ? 'civilizations' : isProfilePage ? 'profile' : isRealtimePage ? 'realtime' : (isEventsPage || isEventResultsPage) ? 'events' : isMediaPage ? 'media' : isReplayAnalysisPage ? 'replay-analysis' : isUpdatesPage ? 'updates' : isBuildOrdersPage ? 'build-orders' : isFeedbackPage ? 'feedback' : 'leaderboard';
    const active = link.dataset.page === activePage;
    link.classList.toggle('active', active);
  });
  document.querySelector('.breadcrumbs b').textContent = isTechTreePage ? '民族科技树' : isCivilizationsPage ? '民族统计' : isProfilePage ? '玩家资料' : isRealtimePage ? '实时对局' : isEventResultsPage ? '赛事结果' : isEventsPage ? '赛事信息' : isMediaPage ? (isMediaVideosPage ? '全部视频' : '视频直播') : isReplayAnalysisPage ? '录像解析' : isUpdatesPage ? '更新汇总' : isBuildOrdersPage ? (buildOrderSlug ? '开局指南详情' : '开局指南') : isFeedbackPage ? '反馈区' : '天梯榜单';
  if (!isRealtimePage) { clearInterval(realtimePollTimer); realtimePollTimer = null; clearInterval(realtimeChatTimer); realtimeChatTimer = null; realtimeRequest?.abort?.(); realtimeVersionRequest?.abort?.(); }
  if (!isEventsPage) { clearInterval(eventsPollTimer); eventsPollTimer = null; }
  if (isTechTreePage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    import('/tech-tree.js?v=76').then(module => module.mountTechTree(document.querySelector('#tech-tree-page')))
      .catch(() => { document.querySelector('#tech-tree-page').textContent='科技树加载失败，请刷新页面重试。'; });
    return;
  }
  if (isCivilizationsPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    import('/civilizations.js?v=23').then(module => module.mountCivilizations(document.querySelector('#civilizations-page'), {
      civName: civilizationNameZh, mapName: mapDisplayName, civImage: aoe2CivilizationImageUrl
    })).catch(() => { document.querySelector('#civilizations-page').textContent='民族统计加载失败，请刷新页面重试。'; });
    return;
  }
  if (isMediaPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    loadMedia(isMediaVideosPage);
    return;
  }
  if (isReplayAnalysisPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    setupReplayAnalysis();
    return;
  }
  if (isRealtimePage) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    profileDetailsRequestId++;
    startRealtimePolling();
    clearTimeout(profileDetailsTimeout);
    return;
  }
  if (isEventsPage) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    startEventsPolling();
    return;
  }
  if (isEventResultsPage) {
    window.scrollTo({top:0,behavior:'auto'});
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    import('/event-results.js?v=13').then(module=>module.mountEventResults(document.querySelector('#event-results-page')))
      .catch(()=>{document.querySelector('#event-results-page').textContent='赛事结果加载失败，请刷新页面重试。';});
    return;
  }
  if (isUpdatesPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    loadUpdates(new URLSearchParams(location.search).get('articleId') || '');
    return;
  }
  if (isBuildOrdersPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    loadBuildOrders(buildOrderSlug);
    return;
  }
  if (isFeedbackPage) {
    profileDetailsRequestId++;
    clearTimeout(profileDetailsTimeout);
    loadFeedbackStatus();
    loadRecentFeedback();
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
  const requestId = ++profileDetailsRequestId;
  profileMatchesRequestId = requestId;
  currentProfileAvatarUrl = '';
  currentProfileLeaderboardRows = [];
  currentProfileRecentResults = new Map();
  currentProfileRecentStats = new Map();
  currentProfileRecentModeCounts = null;
  renderProfileModeCharts();
  setProfileLoadingAnimation(false);
  loadProfileAccounts(profileId, requestId);
  const profileName = document.querySelector('#profileIdentityName');
  profileName.textContent = fallbackName || `玩家 ${profileId}`;
  document.querySelector('#profileIdentityLinks').innerHTML = '';
  const matchesBody = document.querySelector('#profileMatchesBody');
  const matchesMore = document.querySelector('#profileMatchesMore');
  if (matchesBody) matchesBody.innerHTML = profileLoadingMarkup();
  if (matchesMore) { matchesMore.hidden = true; matchesMore.disabled = false; matchesMore.onclick = null; }
  loadWorldsEdgeMatches(profileId, { player: { id: profileId }, matches: [] }, requestId);
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
    fetch(`/api/avatar?v=2&steamId=${encodeURIComponent(avatar.dataset.steam)}`, { cache: 'default' }).then(response => response.ok ? response.json() : null).then(data => {
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
  const controller = profileSuggestController;
  const timeout = setTimeout(() => controller.abort(new DOMException('搜索超时，请稍后重试', 'TimeoutError')), 12000);
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
  } finally { clearTimeout(timeout); }
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
const replayNavLink = document.querySelector('.sidebar nav')?.insertBefore(Object.assign(document.createElement('a'), { className: 'nav-item', href: '/replay-analysis', textContent: '◈录像解析' }), document.querySelector('.sidebar nav [data-page="feedback"]'));
if (replayNavLink) { replayNavLink.dataset.page = 'replay-analysis'; replayNavLink.innerHTML = '<span class="nav-icon">◈</span>录像解析<span class="nav-dot"></span>'; }
const techTreeNavLink = document.querySelector('.sidebar nav')?.insertBefore(Object.assign(document.createElement('a'), { className:'nav-item', href:'/tech-tree' }), document.querySelector('.sidebar nav [data-page="civilizations"]')?.nextElementSibling || null);
if (techTreeNavLink) {
  techTreeNavLink.dataset.page='tech-tree';
  techTreeNavLink.innerHTML='<span class="nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4"/></svg></span>民族科技树<span class="nav-dot"></span>';
}
document.querySelectorAll('.sidebar .nav-item[data-page]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  const target = link.dataset.page === 'tech-tree' ? '/tech-tree' : link.dataset.page === 'civilizations' ? '/civilizations' : link.dataset.page === 'profile' ? '/profile' : link.dataset.page === 'realtime' ? '/realtime' : link.dataset.page === 'events' ? '/events' : link.dataset.page === 'media' ? '/media' : link.dataset.page === 'replay-analysis' ? '/replay-analysis' : link.dataset.page === 'updates' ? '/updates' : link.dataset.page === 'build-orders' ? '/build-orders' : link.dataset.page === 'feedback' ? '/feedback' : '/';
  history.pushState({}, '', target);
  renderCurrentRoute();
}));
document.addEventListener('click',event=>{
  const link=event.target.closest('a[data-events-route]');
  if (!link || event.button!==0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState({},'',link.href);
  renderCurrentRoute();
});
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
