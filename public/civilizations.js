const mounted = new WeakMap();
const number = new Intl.NumberFormat('zh-CN');
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
export const civilizationTechTreeUrl = slug => `/tech-tree?civ=${encodeURIComponent(String(slug).trim().toLowerCase())}`;

export function civilizationTrend(data, opponent = '') {
  const overall = new Map((data.trend?.overall || []).map(row => [row.date, row]));
  const matchup = new Map((data.trend?.matchups || []).filter(row => row.civ === opponent).map(row => [row.date, row]));
  return (data.trend?.snapshots || []).map(snapshot => ({ ...snapshot,
    overall: snapshot.comparable ? overall.get(snapshot.date) || null : null,
    matchup: snapshot.comparable ? matchup.get(snapshot.date) || null : null,
  }));
}

export async function mountCivilizations(root, helpers) {
  if (mounted.has(root)) return mounted.get(root).activate();
  const { civName, mapName, civImage } = helpers;
  let metadata, data, request, sequence = 0, sort = 'winRate', descending = true;
  let state = { mode:'rm_1v1', map:'all', elo:'all', duration:'all', civ:'' };
  root.innerHTML = `
    <div class="civ-heading"><div><div class="section-kicker">CIVILIZATION STATISTICS</div><h2 id="civ-title">民族统计</h2><p>每周更新真实天梯对局，了解民族表现与对位。</p></div></div>
    <div class="civ-mode" role="group" aria-label="比赛类型"><button type="button" data-mode="rm_1v1" aria-pressed="true">1v1<span>随机地图</span></button><button type="button" data-mode="rm_team" aria-pressed="false">团队<span>随机地图</span></button></div>
    <div class="civ-filterbar">
      <label>地图<select id="civ-map"><option value="all">全部地图</option></select></label>
      <label><span id="civ-rating-label">对局平均分</span><select id="civ-rating"><option value="all">全部分数段</option></select></label>
      <label>游戏时长<select id="civ-duration"><option value="all">全部时长</option></select></label>
      <button type="button" class="civ-reset" id="civ-reset">重置筛选</button>
    </div>
    <div id="civ-status" class="civ-status" role="status" aria-live="polite"></div><button type="button" id="civ-retry" class="civ-reset" hidden>重新加载</button>
    <div class="civ-metrics"><div><small>筛选后对局</small><div class="civ-games-metric"><strong id="civ-games">—</strong><span id="civ-game-share" title="占当前模式全部有效对局的比例">—</span></div></div><div><small>出现民族</small><strong id="civ-count">—</strong></div><div><small>数据范围</small><strong id="civ-date-short">—</strong></div></div>
    <div class="civ-panels">
      <section class="civ-panel civ-overview" aria-labelledby="civ-overview-title"><div class="civ-panel-heading"><div><h3 id="civ-overview-title">民族表现</h3><p>点击民族名称查看科技树；使用“查看民族”切换对位统计</p><p>点击胜率/使用率/参赛次数可切换排序</p></div><div class="civ-overview-controls"><label>查看民族<select id="civ-overview-select"></select></label><span id="civ-rank-count"></span></div></div>
        <div class="civ-table-scroll"><table><thead><tr><th>民族</th><th><button type="button" data-sort="winRate">胜率</button></th><th><button type="button" data-sort="usage">使用率</button></th><th><button type="button" data-sort="games">参赛次数</button></th></tr></thead><tbody id="civ-overview-body"></tbody></table></div>
      </section>
      <section class="civ-panel civ-matchups" aria-labelledby="civ-matchups-title"><div class="civ-panel-heading"><div><h3 id="civ-matchups-title">民族对位胜率</h3><p id="civ-matchup-intro">选择一个民族查看对位</p></div>
        <div class="civ-opponent-controls"><label>查看对手<select id="civ-opponent-select"><option value="">全部对手</option></select></label></div></div>
        <div class="civ-matchup-labels"><span>对手民族</span><span>所选民族胜率</span><span>样本场数</span></div><div id="civ-matchup-list" class="civ-matchup-list"></div>
      </section>
    </div>
    <section class="civ-panel civ-trend" aria-labelledby="civ-trend-title">
      <div class="civ-trend-heading"><div><h3 id="civ-trend-title">胜率走势</h3><p>每个点为一次周更新后的累计胜率，与上方卡片口径一致；横轴为该次统计截至日期。</p></div><div id="civ-trend-legend" class="civ-trend-legend"></div></div>
      <div id="civ-trend-chart" class="civ-trend-chart"></div>
      <div id="civ-trend-filters" class="civ-trend-filters" aria-label="当前筛选条件"></div>
      <div id="civ-trend-detail" class="civ-trend-detail" role="status" aria-live="polite"></div>
    </section>
    <details class="civ-method"><summary>统计口径与数据来源</summary><p>数据来自 AoE2 Companion 每日对局包，已排除胜负缺失、队伍结构异常、未知地图、积分缺失及游戏时长不足10分钟的对局。分数段按整场对局的记录积分均值筛选；团队使用组排积分。游戏时长按（结束时间－开始时间）×1.7计算。</p><p>民族胜率按获胜参赛次数计算；使用率为该民族参赛席位占全部玩家席位的比例。团队对位表示双方民族同场、异队出现时的队伍胜率，同队相同民族重复出现不会重复加权；它不代表民族单挑胜率。同民族镜像对位按双方记录统计。</p><p>每周一北京时间08:00更新上一周对局，日期范围随数据更新。胜率与使用率右侧为较上次周更新累计统计的增减，按相同筛选条件计算；本周先记+0.00%。排名随当前排序条件变化。筛选支持组合使用，请结合样本量阅读。</p></details>`;
  const find = selector => root.querySelector(selector);
  const icon = slug => `<img src="${escape(civImage(slug))}" width="26" height="26" loading="lazy" alt="" onerror="this.hidden=true">`;
  function message(text, error = false) {
    find('#civ-status').textContent = text; find('#civ-status').classList.toggle('error', error);
    find('#civ-retry').hidden = !error;
  }
  const ratingBands = () => metadata.ratingsByMode?.[state.mode] || metadata.ratings;
  function syncControls() {
    find('#civ-rating').innerHTML = '<option value="all">全部分数段</option>' + ratingBands().map(item => `<option value="${item.id}">${escape(item.label)}</option>`).join('');
    for (const [key, id] of [['map','civ-map'],['elo','civ-rating'],['duration','civ-duration']]) find(`#${id}`).value = state[key];
    root.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
    find('#civ-rating-label').textContent = state.mode === 'rm_team' ? '对局平均分 · 组排' : '对局平均分 · 1v1';
  }
  function updateURL() {
    if (!/^\/civilizations\/?$/.test(location.pathname)) return;
    const params = new URLSearchParams();
    for (const [key,value] of Object.entries(state)) if (value && value !== 'all' && !(key === 'mode' && value === 'rm_1v1')) params.set(key,value);
    history.replaceState(history.state, '', '/civilizations' + (params.size ? `?${params}` : ''));
  }
  function change(value) {
    if (!Number.isFinite(value)) return '<small class="civ-delta neutral" title="上周相同筛选条件下无可比样本">—</small>';
    const rounded = Math.round(value * 10000) / 100;
    const points = Object.is(rounded,-0) ? 0 : rounded;
    const label = `${points >= 0 ? '+' : ''}${points.toFixed(2)}%`;
    const title = data.comparison ? `较上次周更新（截至${data.comparison.dateTo}）的变化：${label}，按百分点计算` : '本周初始基准，变化暂记+0.00%';
    return `<small class="civ-delta ${points > 0 ? 'positive' : points < 0 ? 'negative' : 'neutral'}" title="${escape(title)}">${label}</small>`;
  }
  function renderOverview() {
    if (!data) return;
    const rows = [...data.civilizations].sort((a,b) => ((a[sort]-b[sort]) * (descending ? -1 : 1)) || civName(a.civ).localeCompare(civName(b.civ),'zh-CN'));
    find('#civ-rank-count').textContent = `${rows.length} 个民族`;
    find('#civ-overview-body').innerHTML = rows.length ? rows.map((row,index) => `<tr class="${row.civ === data.selectedCiv ? 'selected' : ''}"><td><a class="civ-name-button" href="${civilizationTechTreeUrl(row.civ)}" title="查看${escape(civName(row.civ))}科技树">${icon(row.civ)}<span title="${escape(civName(row.civ))}"><span class="civ-row-rank">#${index+1}</span>${escape(civName(row.civ))}</span></a></td><td title="${number.format(row.wins)} 胜 / ${number.format(row.losses)} 负"><span class="civ-rate ${row.winRate >= .5 ? 'positive' : 'negative'}">${percent(row.winRate)}</span>${change(row.winRateDelta)}<span class="civ-rate-bar"><i style="width:${Math.max(0,Math.min(100,row.winRate*100))}%"></i></span></td><td><span class="civ-usage">${percent(row.usage)}</span>${change(row.usageDelta)}</td><td class="civ-number">${number.format(row.games)}</td></tr>`).join('') : '<tr><td colspan="4" class="civ-empty">当前筛选下暂无对局</td></tr>';
    root.querySelectorAll('[data-sort]').forEach(button => {
      button.classList.toggle('selected',button.dataset.sort === sort);
      button.parentElement.setAttribute('aria-sort',button.dataset.sort === sort ? (descending ? 'descending' : 'ascending') : 'none');
    });
  }
  function renderMatchups() {
    if (!data) return;
    const opponent = find('#civ-opponent-select').value;
    const rows = data.matchups.map((row,index) => ({...row,rank:index+1})).filter(row => !opponent || row.civ === opponent);
    find('#civ-matchup-intro').textContent = data.selectedCiv ? `${civName(data.selectedCiv)} 对阵异队民族${state.mode === 'rm_team' ? ' · 队伍胜率' : ''}` : '当前筛选下暂无对局';
    find('#civ-matchup-list').innerHTML = rows.length ? rows.map(row => `<div class="civ-matchup-row"><a class="civ-opponent" href="${civilizationTechTreeUrl(row.civ)}" title="查看${escape(civName(row.civ))}科技树">${icon(row.civ)}<span title="${escape(civName(row.civ))}"><span class="civ-row-rank">#${row.rank}</span>${escape(civName(row.civ))}</span></a><span class="civ-matchup-rate ${row.winRate >= .5 ? 'positive' : 'negative'}" title="${number.format(row.wins)} 胜 / ${number.format(row.losses)} 负（队伍观察值）">${percent(row.winRate)}${change(row.winRateDelta)}</span><span class="civ-number">${number.format(row.games)}</span></div>`).join('') : `<div class="civ-empty">${opponent ? '当前筛选下暂无该民族的对位样本' : '当前筛选下暂无对位样本'}</div>`;
  }
  let inspectTrend;
  find('#civ-trend-chart').addEventListener('focusin', event => inspectTrend?.(event));
  function renderTrend() {
    if (!data) return;
    const chart = find('#civ-trend-chart'), detail = find('#civ-trend-detail');
    const opponent = find('#civ-opponent-select').value;
    const name = data.selectedCiv ? civName(data.selectedCiv) : '所选民族';
    const label = (items, value, fallback) => items.find(item => String(item.id) === String(value))?.label || fallback;
    const selectedMap = metadata.maps.find(item => item.id === data.filters.map);
    const filters = [
      ['模式',data.mode === 'rm_team' ? '团队随机地图' : '1v1随机地图'],
      ['地图',selectedMap ? mapName(selectedMap.slug) : '全部地图'],
      [data.mode === 'rm_team' ? '对局平均分（组排）' : '对局平均分（1v1）',label(metadata.ratingsByMode?.[data.mode] || metadata.ratings,data.filters.elo,'全部分数段')],
      ['游戏时长',label(metadata.durations,data.filters.duration,'全部时长')],
      ['民族',name],['对手',opponent ? civName(opponent) : '全部对手'],
    ];
    find('#civ-trend-filters').innerHTML = filters.map(([key,value]) => `<span>${escape(key)}：<b>${escape(value)}</b></span>`).join('');
    const series = [{ key:'overall', label:`${name}胜率` }];
    if (opponent) series.push({ key:'matchup', label:`${name}对${civName(opponent)}胜率` });
    find('#civ-trend-title').textContent = `${name} · 胜率走势`;
    find('#civ-trend-legend').innerHTML = series.map(line => `<span class="civ-trend-${line.key}"><i></i>${escape(line.label)}</span>`).join('');
    detail.textContent = '';
    if (!data.trend) { chart.innerHTML = '<p class="civ-empty">历史胜率数据暂不可用</p>'; return; }
    const dates = civilizationTrend(data, opponent);
    if (!dates.some(day => day.overall || day.matchup)) { chart.innerHTML = '<p class="civ-empty">当前筛选下所选民族暂无历史样本</p>'; return; }
    const width = Math.max(280, chart.clientWidth), height = width < 500 ? 240 : 290;
    const left = 48, right = width-22, top = 26, bottom = height-38;
    const firstTime = Date.parse(dates[0].date), lastTime = Date.parse(dates.at(-1).date);
    const x = index => dates.length === 1 ? (left+right)/2 : left+(Date.parse(dates[index].date)-firstTime)/(lastTime-firstTime)*(right-left);
    const y = rate => bottom-rate*(bottom-top);
    const description = day => `截至 ${day.date} · ` + series.map(line => {
      const point = day[line.key];
      return `${line.label} ${point ? `${percent(point.winRate)}（${number.format(point.games)}${line.key === 'overall' ? '次参赛' : '场'}）` : day.comparable ? '无样本' : '统计口径不同，无法比较'}`;
    }).join('；');
    let svg = `<svg viewBox="0 0 ${width} ${height}" role="group" aria-label="${escape(name)}每次周更新累计胜率折线图，悬停、点击或使用Tab查看历史数据"><text x="${left}" y="13" class="civ-trend-axis">胜率</text>`;
    for (const rate of [0,.25,.5,.75,1]) svg += `<line class="civ-trend-grid ${rate === .5 ? 'midpoint' : ''}" x1="${left}" x2="${right}" y1="${y(rate)}" y2="${y(rate)}"/><text class="civ-trend-axis civ-trend-y-axis" x="${left-9}" y="${y(rate)+4}" text-anchor="end">${rate*100}%</text>`;
    const labelCount = width < 500 ? 3 : 7;
    const labels = new Set(Array.from({ length:Math.min(labelCount,dates.length) },(_,i) => Math.round(i*(dates.length-1)/Math.max(1,Math.min(labelCount,dates.length)-1))));
    for (const i of labels) svg += `<text class="civ-trend-axis" x="${x(i)}" y="${bottom+23}" text-anchor="${dates.length===1 ? 'middle' : i===0 ? 'start' : i===dates.length-1 ? 'end' : 'middle'}">${dates[i].date.replaceAll('-','/')}</text>`;
    for (const line of series) {
      let path = '', connected = false;
      dates.forEach((day,i) => {
        const point = day[line.key];
        if (!Number.isFinite(point?.winRate)) { connected = false; return; }
        path += `${connected ? 'L' : 'M'}${x(i).toFixed(2)},${y(point.winRate).toFixed(2)} `; connected = true;
      });
      svg += `<g class="civ-trend-${line.key}"><path class="civ-trend-line" d="${path}"/>`;
      dates.forEach((day,i) => { if (Number.isFinite(day[line.key]?.winRate)) svg += `<circle class="civ-trend-dot" cx="${x(i)}" cy="${y(day[line.key].winRate)}" r="3"/>`; });
      svg += '</g>';
    }
    svg += `<line id="civ-trend-cursor" class="civ-trend-cursor" x1="${left}" x2="${left}" y1="${top}" y2="${bottom}" visibility="hidden"/>`;
    dates.forEach((day,i) => { const start = i === 0 ? left : (x(i-1)+x(i))/2, end = i === dates.length-1 ? right : (x(i)+x(i+1))/2; svg += `<rect class="civ-trend-hit" data-day="${i}" x="${start}" y="${top}" width="${Math.max(1,end-start)}" height="${bottom-top}" fill="transparent" tabindex="0" role="img" aria-label="${escape(description(day))}"><title>${escape(description(day))}</title></rect>`; });
    chart.innerHTML = svg + '</svg>';
    function inspect(event) {
      const hit = event.target.closest('[data-day]'); if (!hit) return;
      const index = Number(hit.dataset.day), cursor = find('#civ-trend-cursor');
      cursor.setAttribute('x1',x(index)); cursor.setAttribute('x2',x(index)); cursor.setAttribute('visibility','visible');
      const day = dates[index];
      detail.innerHTML = `<span class="civ-trend-snapshot">截至 ${escape(day.date)}</span>` + series.map(line => {
        const point = day[line.key];
        return `<span class="civ-trend-stat"><span>${escape(line.label)}</span>${point
          ? `<strong class="civ-trend-${line.key}">${percent(point.winRate)}</strong><span>（${number.format(point.games)}${line.key === 'overall' ? '次参赛' : '场'}）</span>`
          : `<span>${day.comparable ? '无样本' : '统计口径不同，无法比较'}</span>`}</span>`;
      }).join('');
    }
    chart.onpointermove = inspect; chart.onclick = inspect; inspectTrend = inspect;
    detail.textContent = opponent && !dates.some(day => day.matchup)
      ? '当前筛选下暂无该对手的历史对位样本' : dates.length === 1 ? '目前仅有一次累计统计，显示单个数据点；后续周更新后形成折线。' : '悬停、点击或使用 Tab 查看各次周更新的累计胜率与样本量';
  }
  let trendWidth = 0;
  const trendObserver = new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width > 0 && width !== trendWidth) { trendWidth = width; renderTrend(); }
  });
  trendObserver.observe(find('#civ-trend-chart'));
  async function json(url, signal) {
    const response = await fetch(url, { signal }); const result = await response.json();
    if (!response.ok) throw new Error(result.error || '读取民族统计失败'); return result;
  }
  async function load({ locate = true } = {}) {
    request?.abort(); request = new AbortController(); const id = ++sequence;
    root.classList.add('civ-pending'); root.setAttribute('aria-busy','true'); message('正在读取统计数据……');
    try {
      if (!metadata) {
        metadata = await json('/api/civilization-stats/meta', request.signal);
        find('#civ-map').innerHTML = '<option value="all">全部地图</option>' + [...metadata.maps].sort((a,b) => mapName(a.slug).localeCompare(mapName(b.slug),'zh-CN')).map(item => `<option value="${item.id}">${escape(mapName(item.slug))}</option>`).join('');
        for (const [key,selector] of [['ratings','#civ-rating'],['durations','#civ-duration']]) find(selector).innerHTML = `<option value="all">全部${key === 'ratings' ? '分数段' : '时长'}</option>` + metadata[key].map(item => `<option value="${item.id}">${escape(item.label)}</option>`).join('');
        const civilizationOptions = [...metadata.civs].sort((a,b) => civName(a.slug).localeCompare(civName(b.slug),'zh-CN')).map(item => `<option value="${escape(item.slug)}">${escape(civName(item.slug))}</option>`).join('');
        find('#civ-overview-select').innerHTML = civilizationOptions;
        find('#civ-opponent-select').innerHTML = '<option value="">全部对手</option>' + civilizationOptions;
      }
      for (const [key,list] of [['map',metadata.maps],['elo',ratingBands()],['duration',metadata.durations]]) {
        if (state[key] !== 'all' && !list.some(item => String(item.id) === state[key])) state[key] = 'all';
      }
      syncControls(); updateURL();
      const params = new URLSearchParams(); for (const [key,value] of Object.entries(state)) if (value && value !== 'all') params.set(key,value);
      const result = await json(`/api/civilization-stats?${params}`, request.signal);
      if (id !== sequence) return;
      data = result; state.civ = result.selectedCiv || state.civ;
      find('#civ-overview-select').value = state.civ;
      find('#civ-games').textContent = number.format(result.games);
      find('#civ-game-share').textContent = percent(result.gameShare);
      find('#civ-count').textContent = number.format(result.civilizations.length);
      find('#civ-date-short').innerHTML = `<span>${escape(result.dateFrom.replaceAll('-','/'))}</span><span>—${escape(result.dateTo.replaceAll('-','/'))}</span>`;
      renderOverview(); renderMatchups(); renderTrend(); updateURL();
      message(result.games ? '数据来自已清洗的随机地图天梯对局' : '当前组合没有样本，可尝试放宽筛选条件');
      if (locate) {
        const row = find('#civ-overview-body tr.selected');
        if (row) {
          const list = find('.civ-table-scroll');
          const bounds = list.getBoundingClientRect();
          const scale = bounds.height / list.offsetHeight || 1;
          list.scrollTop += (row.getBoundingClientRect().top - bounds.top - find('.civ-overview thead').getBoundingClientRect().height) / scale;
        } else message('所选民族在当前筛选下暂无样本');
      }
    } catch (error) {
      if (error.name !== 'AbortError' && id === sequence) message(error.message,true);
    } finally {
      if (id === sequence) { root.classList.remove('civ-pending'); root.setAttribute('aria-busy','false'); }
    }
  }
  root.addEventListener('click', event => {
    const mode = event.target.closest('[data-mode]'); if (mode && mode.dataset.mode !== state.mode) { state.mode = mode.dataset.mode; load(); }
    const sorting = event.target.closest('[data-sort]'); if (sorting) { const field=sorting.dataset.sort; descending=field === sort ? !descending : true; sort=field; renderOverview(); }
  });
  for (const [key,selector] of [['map','#civ-map'],['elo','#civ-rating'],['duration','#civ-duration']]) find(selector).addEventListener('change',event => { state[key]=event.target.value; load(); });
  find('#civ-overview-select').addEventListener('change', event => { state.civ = event.target.value; load({ locate: true }); });
  find('#civ-opponent-select').addEventListener('change',()=>{ renderMatchups(); renderTrend(); });
  find('#civ-retry').addEventListener('click',load);
  find('#civ-reset').addEventListener('click',()=>{ state={mode:state.mode,map:'all',elo:'all',duration:'all',civ:''};find('#civ-opponent-select').value='';load(); });
  const controller = { activate() {
    const params = new URLSearchParams(location.search);
    const next = { mode:params.get('mode') === 'rm_team' ? 'rm_team' : 'rm_1v1',map:params.get('map') || 'all',elo:params.get('elo') || 'all',duration:params.get('duration') || 'all',civ:params.get('civ') || '' };
    if (!data || JSON.stringify(next) !== JSON.stringify(state)) { state=next; return load(); }
  } };
  mounted.set(root,controller); return controller.activate();
}
