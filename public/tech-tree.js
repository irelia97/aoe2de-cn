import { armorClassNames, armorClassNotes } from './tech-tree-classes.js?v=1';
import { portraitColors,portraitAssetUrl } from './tech-tree-fixed-portraits.js?v=5';
import { searchableCivilizationSelect } from './civilization-combobox.js?v=4';
const mounted = new WeakMap();
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const compactName = value => String(value ?? '').replace(/\s+/g, '');
export const fullwidthChinesePunctuation = value => {
  const text = String(value ?? '');
  if (!/[\u3400-\u9fff]/u.test(text)) return text;
  const punctuation = {',':'，',';':'；',':':'：','!':'！','?':'？','(':'（',')':'）','[':'［',']':'］','&':'＆'};
  return text.replace(/[,;:!?()\[\]&]/g, character => punctuation[character])
    .replace(/\./g, (character, index) => /\d/.test(text[index-1] || '') && /\d/.test(text[index+1] || '') ? character : '。');
};
const types = {Unit:'单位', Building:'建筑', Tech:'科技'};
const resourceNames = {Food:'食物', Wood:'木材', Gold:'黄金', Stone:'石料'};
const statIcons = {HP:'hp', Attack:'damage', MeleeArmor:'armor', PierceArmor:'range-armor', Range:'range', MinRange:'range', LineOfSight:'vision', Speed:'movementSpeed', ReloadTime:'reloadTime', AttackDelaySeconds:'reloadTime', AccuracyPercent:'blastRadius', GarrisonCapacity:'garrison'};
function technologyBenefits(line) {
  return String(line || '').replace(/^升级[：:]\s*/, '').split(/[；;]/).map(part => {
    const value=part.trim().replace(/[。．.]+$/,''), match=value.match(/^(.*?)\s*[（(]([^）)]+)[）)]\s*$/);
    const effects=(match?.[1] || value).split(/[，,、]/).map(item=>item.trim()).filter(Boolean);
    return {source:match?.[2] || '',effects};
  }).filter(group=>group.effects.length);
}

const standardBenefitTechs = {
  meleeAttack:[67,68,75], rangedAttack:[199,200,201], infantryArmor:[74,76,77],
  cavalryArmor:[81,82,80], archerArmor:[211,212,219], stableSpeed:[39], stableHp:[435],
  rangeAccuracy:[437], universityAccuracy:[93], universityAttack:[47], castleProduction:[315],
  barracksSpeed:[215], conversionResistance:[46,45,439]
};
export const benefitTechAliases = {
  石匠:'石工术',苏丹王:'大干道',强制兵役:'强征兵役',加固堡垒:'强化堡垒',羽箭:'箭羽',预热射击:'加热射击',
  弗兰芒民兵:'弗拉芒革命',弗拉芒民兵:'弗拉芒革命',希腊火:'希腊之火',海上霸权:'海上霸主',独轮手推车:'独轮推车',攻城:'操练',热情:'狂热',
  健康之家:'穆斯林诊所',哈马斯克:'哈马思克',弩匣:'弩箭匣',环球旅行:'环游世界',重弩:'弩炮',马龙突袭:'突袭',
  火箭:'火箭术',医疗团队:'医疗部队',曼尼普尔骑兵:'曼尼普尔马',阿祖瑙里骑兵:'阿兹瑙里骑兵',采石法:'钻井采石法',
  采金法:'钻井采金法',大干路:'大干道',胡尔切标枪兵:'胡尔切掷矛兵',边防卫队:'边防部队',大篷车:'篷车',
  文德尔之遗:'文德尔传承',雇佣兵:'科维尼安军队'
};
export const compactEnglish = value => String(value || '').toLocaleLowerCase().replace(/[^a-z0-9]/g,'');
const categoryNames = {all:'全部', military:'军事', economy:'经济', defense:'城防与大学', naval:'海军'};
const datasetVersion = '188329-1';
const json = async path => {
  const response = await fetch(`${path}?v=${datasetVersion}`,{cache:'force-cache'});
  if (!response.ok) throw new Error(`读取失败（${response.status}）`);
  return response.json();
};
const historyText = async id => {
  const response = await fetch(`/tech-tree-data/history/${encodeURIComponent(id)}.txt?v=${datasetVersion}`, {cache:'force-cache'});
  if (!response.ok) throw new Error(`历史资料读取失败（${response.status}）`);
  return response.text();
};
const parseHistory = (raw, civilization) => {
  const paragraphs = raw.replace(/<[^>]*>/g, '').replace(/\r/g, '').split(/\n\s*\n/).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const title = paragraphs.shift() || `${civilization.name}人`;
  return {period:'游戏内“历史”板块', summary:paragraphs.shift() || `${civilization.name}文明历史资料`, paragraphs, image:`/tech-tree-data/history/${encodeURIComponent(civilization.id)}.png`, source:`AoE2DE resources/zh/strings/history/${civilization.id}-utf8.txt`, title};
};

export function filterTechTree(tree, entities, {category='all', age=0, query='', unavailable=true}={}) {
  const search = query.trim().toLocaleLowerCase();
  const groups = tree.groups.filter(group => category==='all' || group.category===category);
  const keys = new Set(groups.map(group => group.id));
  const nodes = tree.nodes.filter(node => keys.has(node.group) && (!age || node.age===Number(age)) &&
    (unavailable || node.available) && (!search || [compactName(entities[node.entity]?.name), entities[node.entity]?.englishName].some(value => value?.toLocaleLowerCase().includes(search.replace(/\s+/g,'')))));
  return {groups:groups.filter(group => nodes.some(node => node.group===group.id)),nodes};
}

export function techTreeRelations(tree, key) {
  const node = tree.nodes.find(node => node.key===key);
  // Cross-building unlocks are omitted from the export's drawing links.
  // Chemistry's in-game help explicitly lists these four unlocks.
  const unlocks={'Unit:5':['Tech:47'],'Unit:36':['Tech:47'],'Unit:420':['Tech:47'],
    'Tech:64':['Tech:47'],'Building:236':['Tech:64']};
  const required=new Set(),visited=new Set();
  function collect(item) {
    if (!item || visited.has(item.key)) return;
    visited.add(item.key);
    for(const entity of unlocks[item.entity] || []) {
      required.add(entity);
      collect(tree.nodes.find(n=>n.entity===entity));
    }
    collect(tree.nodes.find(n=>n.key===item.parent));
  }
  collect(node);
  const prerequisites=[...required].map(entity=>tree.nodes.find(n=>n.entity===entity)).filter(Boolean);
  return {parent:tree.nodes.find(item => item.key===node?.parent) || null,
    prerequisites,
    children:tree.nodes.filter(item => item.parent===key)};
}

export function uniqueUnitNodes(tree, entities={}) {
  const additionalUniqueUnits=new Set(['Unit:2703','Unit:753']);
  const units=tree.nodes.filter(node=>node.available && (node.unique || additionalUniqueUnits.has(node.entity)) && node.entity.startsWith('Unit:'))
    .sort((a,b)=>Number(b.group==='building-82')-Number(a.group==='building-82'));
  const keys=new Set(units.map(node=>node.key));
  const seenIcons=new Set(),seenNames=new Set();
  // Castle and Krepost/Barracks variants can have different game IDs while
  // referring to the same unique unit and portrait. Show its artwork once.
  return units.filter(node=>{
    const name=entities[node.entity]?.englishName?.replace(/^Elite\s+/i,'').toLocaleLowerCase();
    if (keys.has(node.parent) || seenIcons.has(node.icon) || (name && seenNames.has(name))) return false;
    seenIcons.add(node.icon);
    if (name) seenNames.add(name);
    return true;
  });
}

export function civilizationBonusSections(description) {
  const [heading,...lines]=description.split('\n');
  const sections=[{title:'民族加成',lines:[]}];
  for (const line of lines) {
    if (/^(独特单位|独特科技|特色单位|特色科技|团队加成)[：:]$/.test(line)) {
      sections.push({title:line.replace(/[：:]$/,''),lines:[]});
    } else {
      const section=sections.at(-1);
      if(section.title==='民族加成' && !line.startsWith('•') && section.lines.length) {
        section.lines[section.lines.length-1]+=line.trim();
      } else section.lines.push(line);
    }
  }
  return {heading:heading || '',sections};
}

export function orderedCosts(value) {
  return ['Wood','Food','Gold','Stone'].filter(resource=>Number(value?.[resource])>0).map(resource=>[resource,value[resource]]);
}

function costs(value) {
  return orderedCosts(value).map(([resource,amount]) =>
    `<span class="tt-cost tt-cost-${resource.toLowerCase()}"><img src="/assets/build-orders/icons/resource-${resource.toLowerCase()}.webp" alt="">${escape(amount)}<small>${escape(resourceNames[resource] || resource)}</small></span>`).join('') || '<span class="tt-muted">无需资源 / 未提供费用</span>';
}

// Keep the game's original columns and rows. Repacking nodes by age makes
// independent upgrade lines share positions and their connectors overlap.
export function layoutTechTree(tree, filtered) {
  const groups=filtered.groups.map(group=>({ ...group, nodes:filtered.nodes.filter(node=>node.group===group.id && node.entity!==group.building).map(node=>({...node})) }));
  for (const group of groups) {
    const occupied=new Set();
    for (const node of group.nodes) {
      while (occupied.has(`${node.row}:${node.column}`)) node.column++;
      occupied.add(`${node.row}:${node.column}`);
    }
    group.columns=Math.max(4,...group.nodes.map(node=>node.column+1));
  }
  const ageRows=new Map([1,2,3,4].map(age=>{
    const rows=groups.flatMap(group=>group.nodes.filter(node=>node.age===age).map(node=>node.row));
    const first=rows.length?Math.min(...rows):age*2-2;
    return [age,{first,count:rows.length?Math.max(...rows)-first+1:1}];
  }));
  return {groups,ageRows};
}

export async function mountTechTree(root) {
  if (mounted.has(root)) return mounted.get(root).activate();
  root.innerHTML = '<div class="tt-loading" role="status"><span class="loader"></span>正在载入民族与科技树…</div>';
  let manifest, entities, benefitData, descriptionOverrides;
  try {
    [manifest,entities,benefitData,descriptionOverrides] = await Promise.all([
      json('/tech-tree-data/manifest.json'),
      json('/tech-tree-data/entities.json'),
      json('/tech-tree-data/benefit-techs.json'),
      json('/tech-tree-data/description-overrides.json?v=21'),
    ]);
  } catch {
    root.innerHTML = '<div class="tt-loading" role="alert">科技树加载失败。<button type="button" id="tt-retry">重新加载</button></div>';
    root.querySelector('#tt-retry').onclick = () => mountTechTree(root);
    return;
  }
  for (const [key, description] of Object.entries(descriptionOverrides)) {
    if (entities[key]?.type === 'Tech') entities[key].description = description;
    if (key.startsWith('Civilization:')) {
      const civilization = manifest.civilizations.find(item => item.id === key.slice('Civilization:'.length));
      if (civilization) civilization.description = description;
    }
  }
  if (entities['Tech:1404']) entities['Tech:1404'].name = '环球探险';
  let tree, civilization, loadSequence=0, searchTimer, frame, winrates=null;
  const techById=new Map(Object.values(entities).filter(entity=>entity.type==='Tech').map(entity=>[entity.id,entity]));
  const benefitByName=new Map();
  const benefitByEnglish=new Map();
  for(const entry of benefitData.entries || []) {
    benefitByName.set(`${entry.kind}:${compactName(entry.name)}`,entry);
    if(entry.englishName) benefitByEnglish.set(`${entry.kind}:${compactEnglish(entry.englishName)}`,entry);
  }
  const cache = new Map();
  const state = {category:'all',age:0,query:'',unavailable:true};
  const civs = [...manifest.civilizations].sort((a,b) => a.englishName.localeCompare(b.englishName,'en',{sensitivity:'base'}));
  const ageLabel = age => manifest.ages[age-1] || '特殊条件';
    root.innerHTML = `
    <header class="tt-heading"><div><div class="section-kicker">CIVILIZATION FIELD GUIDE</div><h2 id="tt-title">民族<span>科技树</span></h2><p>从一个民族出发，查看它能建造、训练和研究的一切。</p></div><a class="tt-version" href="${escape(manifest.patchUrl)}" target="_blank" rel="noopener noreferrer">游戏版本 ${escape(manifest.gameVersion)} <span>↗</span></a></header>
    <div class="tt-selector-bar"><label class="tt-civ-select">查看民族<select id="tt-civ" aria-label="查看民族">${civs.map(civ => `<option value="${civ.id}" data-icon="${escape(civ.icon)}">${escape(civ.name)} · ${escape(civ.englishName)}</option>`).join('')}</select></label><label class="tt-search"><span class="sr-only">搜索单位、建筑或科技</span><span aria-hidden="true">⌕</span><input id="tt-search" type="search" placeholder="搜索单位、建筑、科技 / English" maxlength="80" autocomplete="off"></label><button id="tt-reset" class="tt-reset" type="button">重置筛选</button></div>
    <section id="tt-civ-info" class="tt-civ-info" aria-label="民族特色"></section>
    <section class="tt-workspace" aria-label="科技树"><div class="tt-toolbar"><div class="tt-categories" role="group" aria-label="建筑类别">${Object.entries(categoryNames).map(([id,label]) => `<button type="button" data-category="${id}" aria-pressed="${id===state.category}">${label}</button>`).join('')}</div><div class="tt-controls"><label><span class="sr-only">时代</span><select id="tt-age"><option value="0">全部时代</option>${manifest.ages.map((name,i) => `<option value="${i+1}">${escape(name)}</option>`).join('')}</select></label><label class="tt-checkbox"><input id="tt-unavailable" type="checkbox" checked>显示不可用</label></div></div><div class="tt-board-heading"><p id="tt-result" aria-live="polite"></p><div class="tt-legend"><span class="unit">单位</span><span class="building">建筑</span><span class="tech">科技</span><span class="unavailable">不可用</span></div></div><p class="tt-scroll-hint">按时代向下阅读 · 左右滚动查看更多建筑 · 按住鼠标左键拖动 · 点击节点查看详情</p><div id="tt-scroll" class="tt-scroll" tabindex="0" role="region" aria-label="可横向滚动的科技树"><div id="tt-board" class="tt-board"></div></div></section>
    <p class="tt-base-note">数值为基础数据，未叠加民族加成、已研究科技或游戏模式修正。节点中的时代表示解锁时代；连线表示数据中提供的前置或升级关系，已收录的额外解锁条件见详情。</p>
    <footer class="tt-sources"><span>资料版本 ${escape(manifest.gameVersion)} · 数据源日期 ${escape(manifest.sourceDate)} · ${manifest.civilizations.length} 个民族 / ${manifest.counts.Unit} 种单位 / ${manifest.counts.Building} 种建筑 / ${manifest.counts.Tech} 项科技</span><span><a href="${escape(manifest.sourceUrl)}" target="_blank" rel="noopener noreferrer">Siege Engineers 数据</a> · <a href="/tech-tree-data/NOTICE.txt" target="_blank" rel="noopener noreferrer">来源与版权</a></span></footer>
    <dialog id="tt-detail" class="tt-detail" aria-labelledby="tt-detail-title"><button id="tt-close" class="tt-close" type="button" aria-label="关闭详情">×</button><div id="tt-detail-body"></div></dialog>
    <dialog id="tt-history" class="tt-history" aria-labelledby="tt-history-title"><button id="tt-history-close" class="tt-close" type="button" aria-label="关闭历史">×</button><div id="tt-history-body"></div></dialog>`;
  const find = selector => root.querySelector(selector);
  const dialog = find('#tt-detail');
  const historyDialog = find('#tt-history');
  const civSelect = find('#tt-civ');
  const civCombo = searchableCivilizationSelect(civSelect);
  const board = find('#tt-board');
  const scroll = find('#tt-scroll');
  const detailBody = find('#tt-detail-body');
  function closeDetail() { if (dialog.open) dialog.close(); }
  find('#tt-close').onclick = closeDetail;
  find('#tt-history-close').onclick = () => { if (historyDialog.open) historyDialog.close(); };
  dialog.addEventListener('click', event => { if (event.target===dialog && event.clientX<dialog.getBoundingClientRect().left) closeDetail(); });
  dialog.addEventListener('close', () => { board.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected')); });
  historyDialog.addEventListener('click', event => { if (event.target === historyDialog) historyDialog.close(); });

  function drawLinks() {
    if (root.hidden || !tree) return;
    for (const lane of board.querySelectorAll('.tt-lane')) {
      const svg = lane.querySelector('svg');
      const rect = lane.getBoundingClientRect();
      if (!rect.width) continue;
      const scaleX=rect.width/lane.offsetWidth, scaleY=rect.height/lane.offsetHeight;
      const points = new Map([...lane.querySelectorAll('[data-node]')].map(element => {
        const r=element.getBoundingClientRect();
        return [element.dataset.node,{x:(r.left-rect.left+r.width/2)/scaleX,top:(r.top-rect.top)/scaleY,bottom:(r.bottom-rect.top)/scaleY}];
      }));
      const paths = tree.nodes.filter(node => node.parent && points.has(node.key) && points.has(node.parent)).map(node => {
        const from=points.get(node.parent),to=points.get(node.key);
        const middle=(from.bottom+to.top)/2;
        return `<path data-from="${escape(node.parent)}" data-to="${escape(node.key)}" d="M${from.x},${from.bottom} V${middle} H${to.x} V${to.top}" class="${node.available?'':'unavailable'}"/>`;
      }).join('');
      svg.setAttribute('viewBox',`0 0 ${lane.offsetWidth} ${lane.offsetHeight}`);
      svg.innerHTML = paths;
    }
  }
  function render() {
    if (!tree) return;
    const filtered = filterTechTree(tree,entities,state);
    const ages = state.age ? [Number(state.age)] : [1,2,3,4];
    const layout=layoutTechTree(tree,filtered);
    const heights = new Map(ages.map(age => [age,layout.ageRows.get(age).count*72+12]));
    find('#tt-result').textContent = `${civilization.name} · ${categoryNames[state.category]} · ${state.age?ageLabel(state.age):'全部时代'} · ${filtered.nodes.length} 项（${filtered.nodes.filter(node=>node.available).length} 项可用）${state.query?` · 搜索“${state.query}”`:''}`;
    root.querySelectorAll('[data-category]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.category===state.category)));
    find('#tt-age').value=String(state.age);
    find('#tt-unavailable').checked=state.unavailable;
    const card = node => {
      const entity=entities[node.entity];
      const name=compactName(entity.name);
      return `<button type="button" class="tt-node tt-${entity.type.toLowerCase()}${node.available?'':' is-unavailable'}${node.unique?' is-unique':''}" data-node="${escape(node.key)}" style="grid-column:${node.column+1};grid-row:${node.row-layout.ageRows.get(node.age).first+1}" aria-label="${escape(name)}，${ageLabel(node.age)}，${node.available?'可用':'不可用'}，查看详情" title="${escape(name)} · ${escape(entity.englishName)}${node.available?'':' · 该民族不可用'}"><span class="tt-node-image"><img src="${escape(node.icon)}" alt="" loading="lazy">${node.available?'':'<b aria-hidden="true">×</b>'}${node.unique?'<i title="特色单位或科技" aria-hidden="true">◆</i>':''}</span><span class="tt-node-name">${escape(name)}</span></button>`;
    };
    const ageRail = `<div class="tt-age-rail"><div class="tt-rail-top">时代</div>${ages.map(age=>`<div style="height:${heights.get(age)}px"><span>${['Ⅰ','Ⅱ','Ⅲ','Ⅳ'][age-1]}</span><b>${ageLabel(age)}</b></div>`).join('')}</div>`;
    const lanes = layout.groups.map(group => {
      const rows = ages.map(age => {
        const nodes = group.nodes.filter(node=>node.age===age);
        return `<div class="tt-era" style="height:${heights.get(age)}px;grid-template-columns:repeat(${group.columns},70px)" aria-label="${ageLabel(age)}">${nodes.map(card).join('')}</div>`;
      }).join('');
      const building=tree.nodes.find(node=>node.entity===group.building && node.group===group.id);
      const groupName=civilization.id==='khitans' && group.building==='Building:68' ? '牧场' : compactName(group.name);
      const buildingIcon=civilization.id==='khitans' && group.building==='Building:68' ? '/assets/build-orders/icons/farm.webp' : building?.icon;
      const title=building?`<button type="button" class="tt-building-title" data-node="${escape(building.key)}"><span>${escape(groupName)}</span><img src="${escape(buildingIcon)}" alt=""><small>${ageLabel(building.age)}</small></button>`:`<span>${escape(groupName)}</span>`;
      return `<section class="tt-lane" style="width:${group.columns*79+10}px;flex-basis:${group.columns*79+10}px" aria-label="${escape(groupName)}"><h3>${title}</h3><svg class="tt-links" aria-hidden="true"></svg>${rows}</section>`;
    }).join('');
    board.innerHTML = filtered.groups.length ? ageRail+lanes : '<div class="tt-empty" role="status">没有符合条件的项目。试试其他关键词，或点击“重置筛选”。</div>';
    cancelAnimationFrame(frame); frame=requestAnimationFrame(drawLinks);
  }
  function renderCivilization() {
    const civDescription = civilization.id === 'slavs'
      ? civilization.description.replace('• 农民工作速度 +15%', '• 农夫耕田效率 +23%；农田生产效率 +15%')
      : civilization.description;
    const {heading,sections}=civilizationBonusSections(civDescription);
    const playerColor=portraitColors[civilization.id];
    const rate=winrates?.civilizations?.[civilization.id];
    const formatRate=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
    const rateLine=(mode,cutoff)=>`<div class="tt-civ-winrate-line"><span>${mode==='rm_1v1'?'1v1':'TG'}(&lt;&gt;${cutoff})</span><span>${formatRate(rate?.[mode]?.low?.winRate)}</span><span aria-hidden="true">|</span><span>${formatRate(rate?.[mode]?.high?.winRate)}</span></div>`;
    const rateMarkup=`<div class="tt-civ-winrates" aria-label="整体胜率，竖线左侧为低于分界线，右侧为达到或高于分界线">${rateLine('rm_1v1',1950)}${rateLine('rm_team',1650)}</div>`;
    const uniqueIcons=uniqueUnitNodes(tree,entities).map(node=>`<button type="button" class="tt-unique-unit" data-node="${escape(node.key)}" title="${escape(entities[node.entity].name.replace(/\n/g,''))}" aria-label="${escape(entities[node.entity].name.replace(/\n/g,''))}，独特单位，查看详情"><img decoding="async" fetchpriority="high" data-color-ready="true" data-player-color="${playerColor}" data-portrait="${escape(portraitAssetUrl(node.icon,civilization.id))}" src="${escape(portraitAssetUrl(node.icon,civilization.id))}" alt=""></button>`).join('');
    find('#tt-civ-info').innerHTML = `<div class="tt-civ-banner"><div class="tt-civ-profile"><img class="tt-civ-emblem" src="${escape(civilization.icon)}" alt=""><div class="tt-civ-name"><span>${escape(civilization.englishName.toUpperCase())}</span><h3>${escape(civilization.name)}</h3><p>${escape(fullwidthChinesePunctuation(heading))}</p></div>${rateMarkup}<button type="button" class="tt-history-button" data-history="${escape(civilization.id)}">查看历史</button></div><div class="tt-unique-units" role="group" aria-label="独特单位">${uniqueIcons}</div><div class="tt-civ-count"><b>${tree.nodes.filter(node=>node.available).length}</b><span>可用项目</span></div></div><details class="tt-bonuses" open><summary>民族特色与团队加成<span>展开 / 收起</span></summary><div class="tt-bonus-grid">${sections.filter(section=>section.lines.length).map(section=>`<section><h4>${escape(section.title)}</h4>${section.lines.map(line=>`<p>${escape(fullwidthChinesePunctuation(line.replace(/^•\s*/,'')))}</p>`).join('')}</section>`).join('')}</div></details>`;
  }
  async function showHistory() {
    if (!civilization) return;
    let history;
    try { history = parseHistory(await historyText(civilization.id), civilization); }
    catch { history = {period:'游戏内历史资料', summary:'暂时无法读取本地游戏历史资料。', paragraphs:[], image:civilization.icon, source:'AoE2DE resources/zh/strings/history'}; }
    detailBody.scrollTop = 0;
    historyDialog.querySelector('#tt-history-body').innerHTML = `<article class="tt-history-card"><div class="tt-history-art"><img src="${escape(history.image || civilization.icon)}" alt="${escape(civilization.name)}历史配图"></div><div class="tt-history-copy"><span class="tt-history-kicker">${escape(civilization.englishName.toUpperCase())} · ${escape(history.period)}</span><h2 id="tt-history-title">${escape(civilization.name)}的历史</h2><p class="tt-history-summary">${escape(fullwidthChinesePunctuation(history.summary))}</p>${history.paragraphs.map(paragraph => `<p>${escape(fullwidthChinesePunctuation(paragraph))}</p>`).join('')}<small class="tt-history-source">资料参考：${escape(history.source)}</small></div></article>`;
    if (!historyDialog.open) historyDialog.showModal();
  }
  function relationButton(node) {
    return `<button type="button" data-detail-node="${escape(node.key)}">${escape(compactName(entities[node.entity].name))}${node.available?'':' · 不可用'} <span>↗</span></button>`;
  }
  function benefitTechnologies(entity,node,group,relations) {
    // Only inspect the unit identity sentence. Suitability text such as
    // “不适于攻击骑兵” describes a counter relationship, not the unit class.
    const identity=compactName(String(entity.description || '').split('\n').slice(0,2).join(' ').split(/(?:不)?适于/)[0]);
    const infantry=/步兵|步行/.test(identity);
    const cavalry=!infantry && /骑兵|骑射手|骑乘|象兵|战象|骆驼/.test(identity);
    const rangedAttack=entity.stats?.Attacks?.some(value=>value.Class===3 && value.Amount>0) && !/远程进行近战攻击/.test(identity);
    const ids=[];
    const add=key=>ids.push(...(standardBenefitTechs[key] || []));
    for(const effect of group.effects) {
      if(/铁匠铺/.test(group.source) && /攻击力|射程/.test(effect)) add(rangedAttack?'rangedAttack':'meleeAttack');
      if(/铁匠铺/.test(group.source) && /护甲/.test(effect)) add(rangedAttack?'archerArmor':cavalry?'cavalryArmor':'infantryArmor');
      if(/马厩/.test(group.source) && /速度/.test(effect)) add('stableSpeed');
      if(/马厩/.test(group.source) && /生命值|血量/.test(effect)) add('stableHp');
      if(/靶场/.test(group.source) && /准确/.test(effect)) add('rangeAccuracy');
      if(/大学/.test(group.source) && /准确/.test(effect)) add('universityAccuracy');
      if(/大学/.test(group.source) && /攻击|伤害/.test(effect)) add('universityAttack');
      if(/城堡/.test(group.source) && /生产|训练/.test(effect)) add('castleProduction');
      if(/兵营/.test(group.source) && /速度/.test(effect)) add('barracksSpeed');
      if(/修道院/.test(group.source) || /抵抗.*僧侣|招降/.test(effect)) add('conversionResistance');
    }
    const available=id=>tree.nodes.some(item=>item.entity===`Tech:${id}` && item.available);
    const result=[...new Set(ids)].filter(available).map(id=>techById.get(id)).filter(Boolean).map(tech=>({name:compactName(tech.name),icon:tech.icon}));
    for(const effect of group.effects) {
      if(!/升级(?:为|到)/.test(effect)) continue;
      const target=relations.children.find(item=>compactName(entities[item.entity]?.name)===effect.replace(/^升级(?:为|到)/,'').trim()) || relations.children[0];
      if(target) result.push({name:`升级为${compactName(entities[target.entity].name)}`,icon:target.icon});
    }
    return result.filter((item,index,items)=>items.findIndex(other=>other.name===item.name)===index);
  }
  function verifiedBenefitGroups(entity) {
    const chineseName=compactName(entity.name), englishName=compactEnglish(entity.englishName);
    const entry=benefitByName.get(`${entity.type}:${chineseName}`)
      || benefitByEnglish.get(`${entity.type}:${englishName}`)
      || (entity.type==='Unit' ? benefitByName.get(`Unit:${chineseName.replace(/^精锐/,'')}`) : null)
      || (entity.type==='Unit' ? benefitByEnglish.get(`Unit:${englishName.replace(/^elite/,'')}`) : null);
    if(!entry) return null;
    const grouped=new Map();
    for(const benefit of entry.benefits || []) {
      // Seicing's generic Villager entry includes the Inca-only blacksmith
      // effects. Keep those benefits scoped to Incas instead of showing them
      // for every civilization that happens to research the same techs.
      const incaVillagerBlacksmith = entity.type === 'Unit'
        && compactName(entity.name) === '村民'
        && civilization.id !== 'incas'
        && ['锻造','铸铁','鼓风炉','步兵鳞甲','步兵锁甲','步兵钢甲'].includes(compactName(benefit.tech));
      if (incaVillagerBlacksmith) continue;
      const wanted=benefitTechAliases[compactName(benefit.tech)] || compactName(benefit.tech);
      const matches=tree.nodes.filter(item=>item.available && item.entity.startsWith('Tech:') && compactName(entities[item.entity]?.name)===wanted);
      for(const match of matches) {
        const tech=entities[match.entity];
        const source=compactName(tree.groups.find(group=>group.id===match.group)?.name || '其他');
        if(!grouped.has(source)) grouped.set(source,{source,effects:[],technologies:[]});
        const row=grouped.get(source);
        if(!row.effects.includes(benefit.stat)) row.effects.push(benefit.stat);
        if(!row.technologies.some(item=>item.name===compactName(tech.name))) row.technologies.push({name:compactName(tech.name),icon:tech.icon});
      }
    }
    return [...grouped.values()];
  }
  function showDetail(key) {
    const node=tree.nodes.find(item=>item.key===key);
    if (!node) return;
    const entity=entities[node.entity],stats=entity.stats;
    const relations=techTreeRelations(tree,key);
    const fields=[['HP','生命值'],['Attack','基础攻击'],['MeleeArmor','近战护甲'],['PierceArmor','远程护甲'],['Range','射程'],['MinRange','最小射程'],['LineOfSight','视野'],['Speed','移动速度'],['ReloadTime','攻击间隔','秒'],['AttackDelaySeconds','攻击前摇','秒'],['AccuracyPercent','准确度','%'],['GarrisonCapacity','驻扎容量']].filter(([field])=>Number.isFinite(stats[field]) && (field!=='MinRange' || stats[field]>0) && (field!=='GarrisonCapacity' || stats[field]>0));
    const descriptionLines=entity.description.split('\n').filter(Boolean);
    const upgradeLine=descriptionLines.find(line=>/^升级[：:]/.test(line));
    const description=descriptionLines.filter(line=>line!==upgradeLine);
    const benefits=technologyBenefits(upgradeLine);
    const verifiedBenefits=verifiedBenefitGroups(entity);
    const benefitGroups=(verifiedBenefits ?? benefits.map(group=>({...group,technologies:benefitTechnologies(entity,node,group,relations)})))
      .map(group=>({
        ...group,
        technologies: group.technologies.filter(tech => !(entity.type === 'Unit'
          && compactName(entity.name) === '村民'
          && civilization.id !== 'incas'
          && ['锻造','铸铁','鼓风炉','步兵鳞甲','步兵锁甲','步兵钢甲'].includes(compactName(tech.name))))
      }))
      .filter(group=>group.technologies.length);
    const benefitsMarkup=benefitGroups.length?`<section class="tt-detail-section"><h4>本民族科技收益</h4><div class="tt-tech-benefits">${benefitGroups.map(group=>`<div role="group" aria-label="${escape(group.source || group.effects.join('、'))}"><small>${escape(group.source || '其他')}</small><div>${group.technologies.map(tech=>`<span title="${escape(tech.name)}" aria-label="${escape(tech.name)}"><img src="${escape(tech.icon)}" alt=""></span>`).join('')}</div></div>`).join('')}</div></section>`:'';
    const timeField=entity.type==='Tech'?'ResearchTime':'TrainTime';
    const timeLabel=entity.type==='Tech'?'研究时间':entity.type==='Building'?'建造时间':'训练时间';
    const timeMarkup=Number.isFinite(stats[timeField])?`<p class="tt-cost-time">${timeLabel} <b>${stats[timeField]}</b> 秒</p>`:'';

    const advanced=Object.entries({Attacks:'攻击加成',Armours:'护甲标签'}).map(([field,label])=>{
      const values=(stats[field] || []).filter(value=>![3,4].includes(Number(value.Class)));
      return values.length?`<section class="tt-detail-section"><h4>${label}</h4><div class="tt-class-values">${values.map(value=>`<span title="${escape(armorClassNotes[value.Class] || '')}">${escape(armorClassNames[value.Class] || '待核对的攻防类型')}<b>${field==='Attacks' && value.Amount>0?'+':''}${escape(value.Amount)}</b></span>`).join('')}</div></section>`:'';
    }).join('');
    const advancedMarkup=`<details class="tt-advanced" open><summary>攻击加成与护甲标签（进阶）</summary>${advanced || '<p>此项目没有攻击加成或护甲标签。</p>'}<p class="tt-detail-note">类别数值不等于对所有目标的最终伤害，还需结合目标对应护甲及其他规则。</p></details>`;
    detailBody.innerHTML = `<div class="tt-detail-hero"><img src="${escape(node.icon)}" alt=""><div><span>${types[entity.type]} · ${ageLabel(node.age)}</span><h3 id="tt-detail-title">${escape(compactName(entity.name))}</h3><small>${escape(entity.englishName)}</small></div></div><p class="tt-availability${node.available?'':' unavailable'}">${escape(civilization.name)}${node.available?'可用':'不可用'}${node.unique?' · 特色项目':''}${node.status==='ResearchRequired'?' · 需研究解锁':''}</p>${entity.upgrade?`<section class="tt-detail-section"><h4>升级至该单位</h4><div class="tt-cost-row"><div class="tt-costs">${costs(entity.upgrade.Cost)}</div><p class="tt-cost-time">研究时间 <b>${entity.upgrade.ResearchTime}</b> 秒</p></div></section>`:''}<section class="tt-detail-section"><h4>${entity.type==='Tech'?'研究费用':entity.type==='Building'?'建造费用':'训练费用'}</h4><div class="tt-cost-row"><div class="tt-costs">${costs(stats.Cost)}</div>${timeMarkup}</div></section><section class="tt-detail-section tt-description"><h4>说明与用途</h4>${description.length?description.map(line=>`<p>${escape(fullwidthChinesePunctuation(line))}</p>`).join(''):'<p>当前数据未提供详细说明。</p>'}</section>${fields.length?`<section class="tt-detail-section"><h4>基础属性</h4><div class="tt-stats">${fields.map(([field,label,unit=''])=>`<div><span>${label}</span><b>${escape(stats[field])}<small>${unit}</small></b></div>`).join('')}</div><p class="tt-detail-note">未叠加民族加成与科技；时间以游戏内秒为单位。</p></section>`:''}${advancedMarkup}${benefitsMarkup}<section class="tt-detail-section"><h4>前置 / 升级路线</h4><div class="tt-relations">${relations.prerequisites.length?`<small>解锁所需科技（含升级路线继承）</small>${relations.prerequisites.map(relationButton).join('')}${tree.id==='turks' && relations.prerequisites.some(n=>n.entity==='Tech:47')?'<p class="tt-detail-note">土耳其的化学由民族加成免费获得。</p>':''}`:''}${relations.parent?`<small>前置 / 升级起点</small>${relationButton(relations.parent)}`:relations.prerequisites.length?'':'<span class="tt-muted">当前未收录额外前置条件，解锁时代及民族限制见上方。</span>'}${relations.children.length?`<small>后续项目</small>${relations.children.map(relationButton).join('')}`:''}</div></section>`;
    detailBody.querySelectorAll('.tt-stats>div>span').forEach((label,index) => {
      const icon = statIcons[fields[index][0]];
      if (!icon) return;
      const image = document.createElement('img');
      image.src = `/assets/tech-tree/stats/${icon}.png`;
      image.alt = '';
      image.decoding = 'async';
      label.classList.add('tt-stat-label');
      label.prepend(image);
    });
    board.querySelectorAll('[data-node]').forEach(button=>button.classList.toggle('is-selected',button.dataset.node===key));
    detailBody.scrollTop=0;
    if (!dialog.open) dialog.showModal();
    dialog.scrollTop=0;
    const url=new URL(location.href);url.searchParams.set('node',key);history.replaceState(history.state,'',url);
  }
  async function chooseCivilization(id) {
    const selected=manifest.civilizations.find(civ=>civ.id===id) || manifest.civilizations.find(civ=>civ.id==='chinese');
    const sequence=++loadSequence;
    closeDetail();
    if (historyDialog.open) historyDialog.close();
    civSelect.value=selected.id;
    civCombo.sync();
    scroll.setAttribute('aria-busy','true');
    find('#tt-result').textContent=`正在读取${selected.name}科技树…`;
    board.inert=true;
    try {
      const next=cache.get(selected.id) || await json(`/tech-tree-data/civs/${selected.id}.json`);
      if (sequence!==loadSequence) return;
      cache.set(selected.id,next); tree=next; civilization=selected;
      const url=new URL(location.href);url.searchParams.set('civ',selected.id);url.searchParams.delete('node');history.replaceState(history.state,'',url);
      renderCivilization();render();scroll.scrollLeft=0;

    } catch {
      if (sequence!==loadSequence) return;
      find('#tt-result').textContent='科技树读取失败，请重新选择民族重试。';
      if (civilization) {civSelect.value=civilization.id;civCombo.sync();}
      else board.innerHTML='<div class="tt-empty">加载失败，请重新选择民族重试。</div>';
    } finally {
      if (sequence===loadSequence) {scroll.removeAttribute('aria-busy');board.inert=false;}
    }
  }
  civSelect.onchange=()=>chooseCivilization(civSelect.value);
  find('#tt-search').addEventListener('input',event=>{state.query=event.target.value;clearTimeout(searchTimer);searchTimer=setTimeout(render,100);});
  find('#tt-age').onchange=event=>{state.age=Number(event.target.value);render();};
  find('#tt-unavailable').onchange=event=>{state.unavailable=event.target.checked;render();};
  find('#tt-reset').onclick=()=>{Object.assign(state,{query:'',age:0,category:'all',unavailable:true});find('#tt-search').value='';render();scroll.scrollLeft=0;};
  root.addEventListener('click',event=>{
    const node=event.target.closest('[data-node],[data-detail-node]');
    if (node) return showDetail(node.dataset.node || node.dataset.detailNode);
    const historyButton=event.target.closest('[data-history]');
    if (historyButton) return showHistory();
    const category=event.target.closest('[data-category]');
    if (category) {state.category=category.dataset.category;render();scroll.scrollLeft=0;}

  });
  let drag=null, suppressDragClick=false;
  const endDrag=event=>{
    if(!drag || event.pointerId!==drag.pointerId)return;
    if(drag.dragging){
      suppressDragClick=true;
      setTimeout(()=>{suppressDragClick=false;},0);
      if(scroll.hasPointerCapture(event.pointerId))scroll.releasePointerCapture(event.pointerId);
    }
    drag=null;
    scroll.classList.remove('is-dragging');
  };
  scroll.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='mouse' || event.button!==0 || scroll.scrollWidth<=scroll.clientWidth)return;
    drag={pointerId:event.pointerId,x:event.clientX,left:scroll.scrollLeft,dragging:false};
  });
  scroll.addEventListener('pointermove',event=>{
    if(!drag || event.pointerId!==drag.pointerId || !(event.buttons&1))return;
    const distance=event.clientX-drag.x;
    if(!drag.dragging && Math.abs(distance)<6)return;
    if(!drag.dragging){drag.dragging=true;scroll.setPointerCapture(event.pointerId);scroll.classList.add('is-dragging');}
    scroll.scrollLeft=drag.left-distance;
    event.preventDefault();
  });
  scroll.addEventListener('pointerup',endDrag);
  scroll.addEventListener('pointercancel',endDrag);
  scroll.addEventListener('click',event=>{if(suppressDragClick){event.preventDefault();event.stopPropagation();suppressDragClick=false;}},true);
  scroll.addEventListener('selectstart',event=>{if(drag)event.preventDefault();});
  scroll.addEventListener('dragstart',event=>event.preventDefault());
  const resize=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(drawLinks);});
  resize.observe(scroll);
  const refreshWinrates=()=>fetch('/api/civilization-stats/winrates',{cache:'no-store'})
    .then(response=>response.ok?response.json():null)
    .then(data=>{if(data && JSON.stringify(data)!==JSON.stringify(winrates)){winrates=data;if(civilization)renderCivilization();}})
    .catch(()=>{});
  setInterval(()=>{if(!root.hidden && !document.hidden)refreshWinrates();},5*60_000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && !root.hidden)refreshWinrates();});
  const controller={activate:async()=>{
    const params=new URLSearchParams(location.search), id=params.get('civ') || civilization?.id || 'chinese', key=params.get('node');
    refreshWinrates();
    await chooseCivilization(id);
    if (key && !root.hidden) showDetail(key);
  }};
  mounted.set(root,controller);
  await controller.activate();
}
