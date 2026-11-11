(() => {
  const { players, civilizations, version, date } = window.guessData;
  const modes = {
    player: { title: '猜选手', items: players, max: 8, columns: ['选手', '国家或地区', '战队', '1v1 历史最高分', 'S/A级参赛次数', '个人最好成绩', '团队最好成绩', '最早活跃时间'] },
    civilization: { title: '猜民族', items: civilizations, max: 7, columns: ['民族', '结果'] }
  };
  const $ = id => document.getElementById(id);
  const input = $('guessInput');
  const form = $('guessForm');
  const civilizationChoices = $('civilizationChoices');
  const beijingDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const rounds = new Map();
  let mode = 'player';
  let playerStats, recordedDay, recording;

  async function refreshPlayerCount(method = 'GET') {
    const response = await fetch('/api/guess/players', { method, cache: 'no-store' });
    if (!response.ok) throw Error('Player count unavailable');
    const stats = await response.json();
    if (!playerStats || stats.date > playerStats.date || (stats.date === playerStats.date && stats.players >= playerStats.players)) {
      playerStats = stats;
      $('todayGuessPlayers').textContent = new Intl.NumberFormat('zh-CN').format(stats.players);
    }
    return stats.date;
  }

  function recordPlay() {
    if (location.protocol === 'file:' || recordedDay === beijingDate.format(new Date()) || recording) return;
    recording = refreshPlayerCount('POST').then(date => { recordedDay = date; })
      .catch(() => {}).finally(() => { recording = null; });
  }

  const normalize = name => String(name || '').normalize('NFKC').trim().toLowerCase();
  const normalizePinyin = value => normalize(value).replace(/ü/g, 'v').normalize('NFD').replace(/[\p{M}\s'-]/gu, '');
  const option = (tag, text) => Object.assign(document.createElement(tag), { textContent: text });
  const roundFinished = round => round.guesses.includes(round.target.id) || round.guesses.length >= modes[mode].max;

  function timeText(round) {
    const finished = roundFinished(round);
    if (finished && (!round.startedAt || !round.finishedAt)) return '未记录';
    if (!round.startedAt) return '00:00';
    const seconds = Math.max(0, Math.floor(((round.finishedAt || Date.now()) - round.startedAt) / 1000));
    return [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
  }

  function updateTime() {
    const round = rounds.get(mode);
    if (round) $('roundTime').textContent = timeText(round);
  }
  const tournamentTiers = ['S-Tier', 'A-Tier'];
  const countryNames = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
  const countryCode = player => /^[a-z]{2}$/i.test(player.country || '') ? player.country.toLowerCase() : '';
  const regionNames = { hk: '中国香港', mo: '中国澳门', tw: '中国台湾' };
  const countryLabel = code => code ? regionNames[code] || countryNames.of(code.toUpperCase()) : '未知';
  const continents = [
    'ca us mx cr cu gt hn ni pa sv do pr',
    'ar bo br cl co ec gy pe py sr uy ve',
    'ad al at ba be bg by ch cz de dk ee es fi fr gb gr hr hu ie is it li lt lu lv md me mk mt nl no pl pt ro rs ru se si sk ua',
    'af am az bd bh bn bt cn cy ge hk id il in iq ir jo jp kh kr kw kz la lb lk mm mn mo my np om ph pk ps qa sa sg sy th tr tw ae uz vn ye',
    'dz eg et gh ke ma ng sn tn za',
    'au nz fj pg'
  ].map(codes => new Set(codes.split(' ')));

  function drawTeams() {
    const current = Math.random() < 0.1;
    const former = {};
    if (!current) {
      for (const player of players) {
        const teams = player.formerTeams || [];
        if (teams.length < 2) continue;
        const index = Math.floor(Math.random() * teams.length);
        former[player.id] = teams[index];
      }
    }
    return { current, former };
  }

  const currentTeamRound = round => round.teamDraw?.current;
  function teamClue(player, round) {
    if (currentTeamRound(round)) return player.team || '';
    const former = player.formerTeams || [];
    const picked = round.teamDraw?.former?.[player.id];
    return former.includes(picked) ? picked : former[0] || player.team || '';
  }

  function newRound(previous) {
    const { items } = modes[mode];
    const isPlayer = mode === 'player';
    const targetItems = isPlayer ? items.filter(player => {
      const appearances = tier => player.tournaments?.find(group => group.tier === tier + '-Tier')?.count || 0;
      const sTier = appearances('S');
      const aTier = appearances('A');
      return sTier + aTier > 5;
    }) : items;
    let drawn = new Set(previous?.drawnPlayers);
    if (previous) drawn.add(previous.target.id);
    let choices = targetItems.filter(item => !drawn.has(item.id));
    if (!choices.length) {
      drawn = new Set();
      choices = targetItems.filter(item => item.id !== previous?.target.id);
    }
    const target = choices[Math.floor(Math.random() * choices.length)] || targetItems[0];
    drawn.add(target.id);
    return { target, guesses: [], startedAt: null, finishedAt: null,
      teamDraw: isPlayer ? drawTeams() : null, drawnPlayers: isPlayer ? drawn : undefined };
  }

  function getRound() {
    if (!rounds.has(mode)) rounds.set(mode, newRound());
    return rounds.get(mode);
  }

  function appendCell(row, value, state, meaning) {
    const cell = option('td', value);
    if (state) cell.className = state;
    if (meaning) cell.setAttribute('aria-label', value + '，' + meaning);
    row.append(cell);
  }

  function appendTierCell(row, lines) {
    const cell = document.createElement('td');
    cell.className = 'guess-tier-cell';
    for (const { value, difference, unmatched } of lines) {
      const line = option('span', value + comparisonIcon(difference));
      line.className = 'guess-tier-line' + (difference === 0 ? ' hit' : difference != null || unmatched ? ' near' : '');
      cell.append(line);
    }
    row.append(cell);
  }

  function appendPlayerGuess(row, guess, round) {
    const { target } = round;
    appendCell(row, guess.name);
    const country = countryCode(guess), answerCountry = countryCode(target);
    const sameCountry = country && country === answerCountry;
    const sameContinent = continents.some(group => group.has(country) && group.has(answerCountry));
    const geography = !country || !answerCountry ? '' : sameCountry ? 'hit' : sameContinent ? 'near' : 'miss';
    appendCell(row, countryLabel(country), geography,
      !geography ? '无法比较' : sameCountry ? '国家或地区相同' : sameContinent ? '同一大洲' : '不同大洲');
    const team = teamClue(guess, round), answerTeam = teamClue(target, round);
    const teamKnown = Boolean(team && answerTeam);
    const sameTeam = normalize(team) === normalize(answerTeam);
    const fallback = team && !currentTeamRound(round) && !guess.formerTeams?.length;
    appendCell(row, team ? team + (fallback ? '（现役）' : '') : '未知', teamKnown ? sameTeam ? 'hit' : 'miss' : '',
      teamKnown ? sameTeam ? '战队相同' : '战队不同' : '无法比较');
    const delta = target.peakRating && guess.peakRating ? target.peakRating - guess.peakRating : null;
    const rating = guess.peakRating ?? '无记录';
    if (delta == null) appendCell(row, rating, '', '无法比较');
    else if (!delta) appendCell(row, rating + ' ✓', 'hit', '分数相同');
    else appendCell(row, rating + (delta > 0 ? ' ↑' : ' ↓'), 'near',
      delta > 0 ? '答案分数更高' : '答案分数更低');
    appendTierCell(row, tournamentTiers.map(tier => {
      const count = player => player.tournaments?.length ? player.tournaments.find(group => group.tier === tier)?.count || 0 : null;
      const guessed = count(guess), answer = count(target);
      return { value: tier[0] + '级 ' + (guessed == null ? '未知' : guessed + ' 次'),
        difference: guessed == null || answer == null ? null : answer - guessed };
    }));
    for (const key of ['bestSolo', 'bestTeam']) {
      const matches = guess[key] || [], answers = target[key] || [];
      appendTierCell(row, tournamentTiers.map(name => {
        const tier = name[0];
        const place = matches.find(item => item.tier === tier);
        const other = answers.find(item => item.tier === tier);
        const comparable = !guess.partialResults && !target.partialResults;
        return { value: tier + '级 ' + (place ? formatBest(place) : guess.partialResults ? '未知' : '无记录'),
          difference: comparable && place && other ? place.rank - other.rank || place.last - other.last : null,
          unmatched: comparable && Boolean(place) !== Boolean(other) };
      }));
    }
    const firstYear = guess.firstActiveYear, answerYear = target.firstActiveYear;
    appendCompared(row, firstYear ? firstYear + ' 年' : '未知', firstYear && answerYear ? answerYear - firstYear : null);
  }

  const comparisonIcon = difference => difference == null ? '' : difference > 0 ? ' ↑' : difference < 0 ? ' ↓' : ' ✓';
  const formatPlacement = (rank, last) => rank === last && rank <= 3 ? ['冠军','亚军','季军'][rank - 1] : last + '强';
  const formatBest = ({ rank, last, top }) => top ? '前 ' + top + ' 名' : formatPlacement(rank, last);
  function appendCompared(row, value, difference) {
    appendCell(row, value + comparisonIcon(difference), difference == null ? '' : difference === 0 ? 'hit' : 'near',
      difference == null ? '无法比较' : difference > 0 ? '答案数值更高' : difference < 0 ? '答案数值更低' : '相同');
  }

  function renderAnswerProfile(player, round) {
    const panel = $('answerProfile');
    const facts = $('answerProfileFacts');
    const evidence = $('answerEligibility');
    panel.hidden = !player;
    facts.replaceChildren();
    evidence.replaceChildren();
    if (!player) return;
    const best = key => (player[key] || []).map(place => place.tier + '级 ' + formatBest(place)).join(' / ') || (player.partialResults ? '未知' : '无记录');
    const appearances = tier => player.partialResults ? '未知' : player.tournaments?.find(group => group.tier === tier + '-Tier')?.count || 0;
    const country = countryLabel(countryCode(player));
    for (const [label,value] of [
      ['国家或地区',country], ['本题战队线索',teamClue(player, round) || '未知'], ['现役战队',player.team || '未知'],
      ['1v1 历史最高分',player.peakRating ?? '无记录'], ['S / A 级参赛次数',appearances('S') + ' / ' + appearances('A')],
      [player.partialResults ? '已核实个人最好成绩' : '个人最好成绩',best('bestSolo')],
      [player.partialResults ? '已核实团队最好成绩' : '团队最好成绩',best('bestTeam')],
      ['最早活跃时间',player.firstActiveYear ? player.firstActiveYear + ' 年' : '未知']
    ]) {
      const item = document.createElement('div');
      item.append(option('dt',label),option('dd',value));
      facts.append(item);
    }
    if (player.eligibility) {
      const {tier,rank,last,event,url,top} = player.eligibility;
      const link = option('a',event);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const place = top ? '正赛前 ' + top + ' 名' : rank === last ? '第 ' + rank + ' 名' : '并列第 ' + rank + '–' + last + ' 名';
      evidence.append('入选依据 · ',link,'（' + tier + ' 级，' + place + '）');
    }
  }

  function render(message = '') {
    const { items, max, title, columns } = modes[mode];
    const round = getRound();
    const { target, guesses } = round;
    const won = guesses.includes(target.id);
    const finished = won || guesses.length >= max;
    const started = Boolean(round.startedAt);
    const isPlayer = mode === 'player';
    for (const button of document.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    $('roundTitle').textContent = title;
    $('attempts').textContent = '已猜 ' + guesses.length + ' / ' + max;
    updateTime();
    $('rules').textContent = isPlayer
      ? '国家或地区命中显示绿色，同洲显示黄色，其他显示红色。↑↓ 表示答案的数值更高或更低；成绩用 ↑ 表示答案名次更好。'
      : '根据多个民族共有的兵种和科技猜答案。每次猜错后揭开一条线索，第 6 次前提示民族加成，第 7 次前提示团队加成。';
    $('source').textContent = isPlayer
      ? '选手题库包含 ' + players.length + ' 人。只有 S/A 级参赛总次数超过 5 次的选手会成为谜底，其他选手仍可用于猜测。1v1 历史最高分取已关联账号的随机地图天梯记录。最早活跃时间取 Liquipedia 公开的活跃起始年份或已收录的最早赛事记录。快照日期 ' + date + '。'
      : '民族题库包含 ' + civilizations.length + ' 个民族，线索来自本站科技树（版本 ' + version + '）。';

    const clues = $('clues');
    clues.hidden = isPlayer || (!started && !finished);
    clues.replaceChildren();
    if (!clues.hidden) {
      for (const clue of target.clues.slice(0, finished ? undefined : guesses.length + 1)) {
        const item = document.createElement('li');
        item.title = clue.english || '';
        const label = option('span', clue.name);
        label.className = 'clue-name';
        const icon = document.createElement('img');
        icon.src = clue.icon;
        icon.alt = '';
        label.prepend(icon);
        item.append(option('small', clue.type === 'Unit' ? '可用兵种' : '可研究科技'), label);
        clues.append(item);
      }
      for (const [threshold, label, text] of [[max - 2, '民族加成', target.bonus], [max - 1, '团队加成', target.teamBonus]]) {
        if (guesses.length < threshold || !text) continue;
        const item = document.createElement('li');
        item.className = 'bonus-clue';
        item.append(option('small', label), option('span', text));
        clues.append(item);
      }
    }
    input.placeholder = isPlayer ? '输入选手名' : '输入中文、英文或拼音';
    input.setAttribute('aria-label', input.placeholder);
    if (isPlayer) input.setAttribute('list', 'choices');
    else input.removeAttribute('list');
    $('choices').replaceChildren(...(isPlayer ? items.filter(item => !guesses.includes(item.id))
      .map(item => Object.assign(option('option', item.english || ''), { value: item.name })) : []));
    civilizationChoices.hidden = true;
    $('startRound').hidden = started || finished;
    form.hidden = !started || finished;
    $('status').textContent = finished ? '' : message;
    $('roundResult').hidden = !finished;
    renderAnswerProfile(finished && isPlayer ? target : null, round);
    if (finished) {
      $('roundResultSummary').textContent = (won ? '猜中了！' : '机会用完了。') + '答案是 ' + target.name + '。';
      $('roundResultAttempts').textContent = guesses.length + ' / ' + max;
      $('roundResultTime').textContent = timeText(round);
    }

    $('results').hidden = (!started && !finished) || !guesses.length;
    $('results').classList.toggle('player-results', isPlayer);
    const header = document.createElement('tr');
    const labels = columns.map(label => label === '战队' ? currentTeamRound(round) ? '现役战队' : '曾服役战队' : label);
    header.append(...labels.map(label => option('th', label)));
    $('columns').replaceChildren(header);
    const rows = [...guesses].reverse().map(id => {
      const guess = items.find(item => item.id === id);
      const row = document.createElement('tr');
      if (isPlayer) {
        appendPlayerGuess(row, guess, round);
        [...row.cells].forEach((cell, index) => { cell.dataset.label = labels[index]; });
      }
      else {
        appendCell(row, guess.name);
        appendCell(row, id === target.id ? '正确 ✓' : '不正确 ✗', id === target.id ? 'hit' : 'miss');
      }
      return row;
    });
    $('guesses').replaceChildren(...rows);
  }

  function showCivilizationChoices() {
    if (mode !== 'civilization' || form.hidden) return;
    const query = normalize(input.value);
    const pinyin = normalizePinyin(query);
    const { guesses } = getRound();
    const choices = civilizations.filter(item => !guesses.includes(item.id) &&
      (!query || normalize(item.name).includes(query) || normalize(item.english).includes(query) ||
        (pinyin && normalizePinyin(item.pinyin).includes(pinyin))));
    civilizationChoices.replaceChildren(...choices.map(item =>
      Object.assign(option('button', item.name), { type: 'button', value: item.name })));
    civilizationChoices.hidden = !choices.length;
  }

  input.addEventListener('click', showCivilizationChoices);
  input.addEventListener('input', showCivilizationChoices);
  civilizationChoices.addEventListener('mousedown', event => {
    if (event.target.closest('button')) event.preventDefault();
  });
  civilizationChoices.addEventListener('click', event => {
    const choice = event.target.closest('button');
    if (!choice) return;
    input.value = choice.value;
    civilizationChoices.hidden = true;
    input.focus();
  });
  const guessSearch = input.parentElement;
  guessSearch.addEventListener('focusout', event => {
    if (!guessSearch.contains(event.relatedTarget)) civilizationChoices.hidden = true;
  });
  guessSearch.addEventListener('keydown', event => {
    if (mode !== 'civilization') return;
    if (event.key === 'Escape' && !civilizationChoices.hidden) {
      event.preventDefault();
      civilizationChoices.hidden = true;
      input.focus();
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    if (civilizationChoices.hidden) showCivilizationChoices();
    if (civilizationChoices.hidden) return;
    event.preventDefault();
    const choices = [...civilizationChoices.children];
    const index = choices.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? index + 1 : index < 0 ? choices.length - 1 : index - 1;
    (choices[next] || input).focus();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const round = getRound();
    const { guesses, target } = round;
    const { items, max } = modes[mode];
    if (!round.startedAt || guesses.length >= max || guesses.includes(target.id)) return;
    const query = normalize(input.value);
    const guess = items.find(item => [item.name, item.english].some(name => name && normalize(name) === query) ||
      (item.pinyin && normalizePinyin(item.pinyin) === normalizePinyin(query)));
    if (!guess) return render('请选择题库中的名称。');
    if (guesses.includes(guess.id)) return render('这个答案已经猜过了。');
    guesses.push(guess.id);
    if (roundFinished(round)) round.finishedAt = Date.now();
    recordPlay();
    input.value = '';
    render(guess.id === target.id ? '' : '还没猜中，再试一次。');
    if (!form.hidden) input.focus();
  });

  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
    mode = button.dataset.mode || mode;
    input.value = '';
    render();
  });
  $('startRound').addEventListener('click', () => {
    const round = getRound();
    if (round.startedAt || roundFinished(round)) return;
    round.startedAt = Date.now();
    render();
    input.focus();
  });
  $('next').addEventListener('click', () => {
    rounds.set(mode, newRound(getRound()));
    input.value = '';
    render();
    $('startRound').focus();
  });
  render();
  setInterval(updateTime, 1000);
  if (location.protocol !== 'file:') refreshPlayerCount().catch(() => {});
})();
