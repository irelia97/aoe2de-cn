import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'public/tech-tree-data/manifest.json');
const entitiesPath = resolve(root, 'public/tech-tree-data/entities.json');
const overridesPath = resolve(root, 'public/tech-tree-data/description-overrides.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entities = JSON.parse(readFileSync(entitiesPath, 'utf8'));

const changes = {
  armenians: [['骡车科技效率', '骡车科技提供的效率 +40%']],
  aztecs: [['军事单位训练', '军事单位（僧侣除外）训练时间 -13%']],
  bengalis: [['象兵单位受到', '象兵单位受到的额外伤害 -25% 并且最小/最大招降时间 +3/+1']],
  britons: [['羊倌工作', '牧羊人工作速度 +25%'], ['步弓手在', '步弓手系、长弓兵的射程/视野/搜索范围在城堡/帝王时代 +1/+2 (不叠加)']],
  bulgarians: [['城镇中心石料', '城镇中心石料费用 -50% (对游牧模式的首个城镇中心无效)']],
  burgundians: [['可提前一个时代', '经济科技可提前一个时代研究，且食物费用 -40%'], ['在城堡时代可', '在城堡时代可研究重装骑士']],
  byzantines: [['喷火船', '喷火船系和德罗蒙战舰攻击间隔 -20%']],
  celts: [['攻城武器攻击', '攻城武器的攻击间隔 -20%']],
  danes: [['捕鱼船和村民', '捕鱼船和村民额外获得 5% 采集量的食物'], ['每摧毁一座建筑', '每摧毁一座建筑，获得其 25% 建造费用']],
  dravidians: [['升级到下一时代', '升级到下一时代时获得 200 木材'], ['掷矛手', '掷矛手系、标枪骑兵和骑象射手攻击间隔 -20%']],
  ethiopians: [['升级到下一时代', '升级到下一时代时获得 100 黄金和 100 食物'], ['步弓手攻击', '步弓手系单位攻击间隔 -15%']],
  georgians: [['开始游戏时拥有', '开始游戏时拥有一辆骡车 (游牧模式时在第一个城镇中心建成后获得)'], ['在高海拔战斗', '在高海拔战斗时，己方单位和建筑受到的伤害 -15%'], ['强化教堂可', '强化教堂可使 9 格范围内的村民采集/建造/修理效率 +10%']],
  goths: [['可立即研究织布机', '织布机研究时间降低为 1 秒'], ['猎人携带量', '猎人食物携带量 +15, 可采集量 +23%'], ['在帝王时代人口', '帝王时代人口上限 +10']],
  gurjaras: [['开局', '开局时城镇中心下拥有 2 片果树丛'], ['可将牲畜', '可将牲畜驻扎于磨坊, 每分钟自增 15*ln(驻扎动物总食物量/200+1) 食物']],
  hindustanis: [['骆驼骑兵攻击', '骆驼斥候系单位攻击间隔 -16.67%']],
  huns: [['巨型投石机', '巨型投石机准确度 +35%'], ['在游牧民族', '在游牧模式下, 第一座城镇中心建造完成后获得一匹匈奴马']],
  japanese: [['从封建时代开始步兵', '从封建时代开始步兵攻击间隔 -25%'], ['骑射手对', '骑射手类单位对射手类单位 (掷矛手和标枪骑兵除外) 伤害 +2']],
  jurchens: [['从封建时代开始', '从封建时代开始，骑乘单位和火矛兵的攻击间隔 -20%'], ['攻城工程技师在', null], ['攻城和防御', '攻城技师、石匠、建筑学、脚踏起重机、射箭槽、工兵、垛墙、警戒箭塔、大型箭塔、炮塔、跺墙、重型弩炮、重型火箭推车科技木材费用 -75%，研究时间 -50%'], ['单位受到', '军事单位 (僧侣除外) 受到友军误伤伤害 -50%']],
  khitans: [['掷矛手', '掷矛手系、长矛兵系、斥候骑兵系和标枪骑兵训练和升级时间 -13%']],
  khmer: [['农民不需要', '农夫不需要上交就可以存放食物, 但耕田效率 -5%']],
  koreans: [['远程士兵', '步兵类、射手类、骑射手类单位木材费用 -50%，战船类单位木材费用 -20%'], ['战船的木材', null]],
  lithuanians: [['每座城镇中心', '每建造一个城镇中心 (包括游戏开始时) 获得 100 食物']],
  magyars: [['村民', '村民一击就能杀死狼']],
  malay: [['升级至', '升级时代时间 -40%']],
  malians: [['村民存放', '金矿产量 +10%, 金矿工采矿效率和携带量 +10%'], ['建筑的木材', '所有建筑的木材费用 -15% (城镇中心从城堡时代开始)']],
  mayans: [['资源持续', '资源可采集量 +15% (降低采集时造成的实际消耗)'], ['步弓手', '步弓手系、羽箭手费用在封建/城堡/帝王时代分别 -10%/-20%/-30%']],
  mongols: [['骑射手攻击', '骑射手类单位攻击间隔 -20%']],
  persians: [['初始木材', '游戏开始时木材 +50, 食物 +50 (游牧模式时在第一个城镇中心建成后获得)']],
  poles: [['石矿工', '石矿工每采集 2.96 石料额外获得 1 黄金']],
  portuguese: [['采果工', '浆果采集者每采集 2.96 食物额外获得 1 木材']],
  romans: [['蝎式弩黄金', '弩炮黄金费用 -50%']],
  saracens: [['市场贸易', '市场交易费用降低为 5%'], ['箭船系攻击', '箭船系攻击间隔 -20%']],
  saxons: [['磨坊', '磨坊、木料和采矿场建成后，获得 35 食物和 10 石料'], ['塔和城堡', '从城堡时代开始，塔类建筑放箭数/最大放箭数 +1, 城堡和营垒放箭数/最大放箭数 +5']],
  shu: [['伐木工', '伐木工工作时每分钟产生 2.7 食物']],
  sicilians: [['初始石料', '游戏开始时石料 +100 (游牧模式时在第一个城镇中心建成后获得)'], ['士兵受到', '非攻城武器的军事单位受到额外伤害 -40%'], ['防御工事建造', '城镇中心建造时间 -50%, 城堡、塔类、城门和城墙类建筑建造时间 -33%']],
  spanish: [['建筑工', '渔船、建筑工的工作速度 +30% (对游牧模式的首个城镇中心无效)'], ['研究一项科技', '每完成一项科技研究获得 20 黄金 (升级时代科技除外)'], ['火药单位攻击', '火枪类、火炮系和炮舰系单位攻击间隔 -15%'], ['炮舰攻击', '炮舰弹道速度增加到 7 并具有弹道学效果']],
  turks: [['化学免费', '化学免费；炮塔和精锐炮舰科技费用 -50%']],
  varangians: [['牧羊', '牧羊人、渔夫和猎人额外获得采集量 10% 的黄金'], ['瓦兰吉卫队', '瓦兰吉卫队的攻击间隔 -14%, 产生的黄金 +50%'], ['维京长船', '维京长船和大型投石战舰攻击间隔 -13%']],
  vietnamese: [['经济升级', '经济科技升级无须花费木材且研究时间 -50%']],
  wei: [['每研究一次经济', '每研究一项经济科技，就可免费获得一个村民']],
  wu: [['军事生产建筑', '军事建筑、城堡和码头建造完成后获得 55 食物']],
};

const teamBonuses = {
  britons: '靶场生产和研究时间 -9.09%', bulgarians: '铁匠铺研究时间 -44.44%', burgundians: '圣物每分钟生产 30 食物', bohemians: '市场生产和研究时间 -44.44%',
  celts: '攻城武器厂生产和研究时间 -16.67%', dravidians: '船坞提供 5 人口容量', franks: '骑士系视野/搜索范围 +2',
  goths: '兵营生产和研究时间 -16.67%', gurjaras: '骆驼和象兵单位的训练时间 -20%', huns: '马厩生产和研究时间 -16.67%',
  khmer: '弩炮系单位射程/视野/搜索范围 +1', lithuanians: '修道院生产和研究时间 -16.67%', magyars: '骑射手类单位训练时间 -20%', malians: '大学研究时间 -44.44%',
  mayans: '城墙和城门费用 -50%', portuguese: '所有科技研究时间 -20% (升级时代除外)', romans: '弩炮系单位最小射程降低为 1',
};

for (const civ of manifest.civilizations) {
  let lines = civ.description.split('\n');
  for (const [prefix, value] of changes[civ.id] || []) {
    const index = lines.findIndex(line => line.replace(/^•\s*/, '').startsWith(prefix));
    if (index < 0 && value !== null && lines.includes(`• ${value}`)) continue;
    if (index < 0 && value === null) continue;
    if (index < 0) throw new Error(`Missing ${civ.id}: ${prefix}`);
    if (value === null) lines.splice(index, 1);
    else lines[index] = `• ${value}`;
  }
  if (teamBonuses[civ.id]) {
    const index = lines.indexOf('团队加成：');
    if (index < 0) throw new Error(`Missing team bonus: ${civ.id}`);
    lines.splice(index + 1, lines.length - index - 1, teamBonuses[civ.id]);
  }
  if (civ.id === 'goths') lines = lines.map(line => line.replaceAll('侍从战士', '近卫军'));
  if (civ.id === 'burgundians') lines = lines.map(line => line.replace('农民不仅能产生食物，还能缓慢地产生黄金', '农夫每生产 26.5 食物获得 1 黄金'));
  if (civ.id === 'muisca') lines = lines.map(line => line.replace(/瓦拉卡斯 \([^)]*\)/, '瓦拉卡斯 (投石手射程/视野/搜索范围 +1, 训练时间 -33%)'));
  if (civ.id === 'portuguese') lines = lines.map(line => line.replace(/环球探险 \([^)]*\)/, '环球探险 (将整个地图设置为待探索；船只训练时间 -25%)'));
  if (civ.id === 'romans') lines = lines.map(line => line.replace('• 弩炮 (弩炮攻击速度', '• 重弩 (弩炮攻击速度'));
  if (civ.id === 'saxons') lines = lines.map(line => line.replace(/神职人员招募 \([^)]*\)/, '神职人员招募 (僧侣类单位的招降距离/视野/搜索范围 +1，训练时间 -25%)'));
  if (civ.id === 'saxons') lines = lines.map(line => line.replace(/盾墙 \([^)]*\)/, '盾墙 (步兵类单位 7 圆形范围内每 15 个其他友方步兵类单位可使自身获得 +1 护甲/+1 盾牌, 最多叠加 3 层)'));
  if (civ.id === 'saracens') lines = lines.map(line => line.startsWith('• 穆斯林诊所 ') ? '• 穆斯林诊所 (距离僧侣 5 格圆形范围内己方&同盟方的单位生命自愈速率 +75 HP/min (效果无法叠加))' : line);
  if (civ.id === 'shu') lines = lines.map(line => line.startsWith('• 盘蛇阵 ') ? '• 盘蛇阵 (长矛兵系单位和白毦兵能相互增加 15 圆形范围内 0.5% 生命值, 最多叠加 30 层)' : line);
  if (civ.id === 'shu') lines = lines.map(line => /^• 弩(?:箭)?匣 /.test(line) ? '• 弩匣 (步弓手系单位和战车 (集火模式) 放箭/最大放箭数 +2, 战车 (散射模式) 和楼船放箭/最大放箭数 +3)' : line);
  if (civ.id === 'tupi') lines = lines.map(line => line === '独有单位：' ? '独特单位：' : line);
  civ.description = lines.join('\n').replaceAll('蝎式弩', '弩炮');
}

for (const entity of Object.values(entities)) {
  entity.name = entity.name.replaceAll('蝎式弩', '弩炮');
  entity.description = entity.description.replaceAll('蝎式弩', '弩炮');
}
entities['Unit:75'].name = '剑士';
entities['Unit:75'].description = entities['Unit:75'].description.replaceAll('武士', '剑士');
entities['Unit:74'].description = entities['Unit:74'].description.replace('升级为武士', '升级为剑士');
entities['Tech:883'].name = '重弩';
entities['Tech:883'].description = entities['Tech:883'].description.replace(/^研究弩炮/m, '研究重弩');
entities['Tech:1069'].name = '弩匣';
entities['Tech:1069'].description = entities['Tech:1069'].description.replace(/^研究弩箭匣/m, '研究弩匣');
entities['Unit:41'].description = entities['Unit:41'].description.replaceAll('侍从战士', '近卫军');
entities['Unit:555'].description = entities['Unit:555'].description.replaceAll('侍从战士', '近卫军');
entities['Unit:759'].description = entities['Unit:759'].description.replaceAll('侍从战士', '近卫军');
entities['Unit:761'].description = entities['Unit:761'].description.replaceAll('侍从战士', '近卫军');

writeFileSync(manifestPath, JSON.stringify(manifest));
writeFileSync(entitiesPath, JSON.stringify(entities));

const overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
for (const civ of manifest.civilizations) {
  if (changes[civ.id] || teamBonuses[civ.id] || ['burgundians', 'goths', 'muisca', 'tupi'].includes(civ.id)) {
    overrides[`Civilization:${civ.id}`] = civ.description;
  }
}
overrides['Tech:513'] = '研究皇家卫队\n步兵类单位溅射范围 +0.5，具有 5 溅射伤害';
overrides['Tech:1366'] = '研究瓦拉卡斯\n投石手射程/视野/搜索范围 +1, 训练时间 -33%';
overrides['Tech:1404'] = '研究环球探险\n将整个地图设置为待探索；船只训练时间 -25%';
overrides['Tech:883'] = '研究重弩\n弩炮攻击间隔 -25%；箭船系攻击力 +2';
overrides['Tech:482'] = '研究堡垒\n城堡和瞭望箭塔系的攻击间隔 -25%，城堡能治疗 7 格范围内的盟军步兵';
overrides['Tech:1491'] = '研究神职人员招募\n僧侣类单位的招降距离/视野/搜索范围 +1，训练时间 -25%';
overrides['Tech:1464'] = '研究盾墙\n步兵类单位 7 圆形范围内每 15 个其他友方步兵类单位可使自身获得 +1 护甲/+1 盾牌, 最多叠加 3 层';
overrides['Tech:28'] = '研究穆斯林诊所\n距离僧侣 5 格圆形范围内己方&同盟方的单位生命自愈速率 +75 HP/min (效果无法叠加)';
overrides['Tech:1070'] = '研究盘蛇阵\n长矛兵系单位和白毦兵能相互增加 15 圆形范围内 0.5% 生命值, 最多叠加 30 层';
overrides['Tech:1069'] = '研究弩匣\n步弓手系单位和战车 (集火模式) 放箭/最大放箭数 +2, 战车 (散射模式) 和楼船放箭/最大放箭数 +3';
overrides['Tech:578'] = '研究土堡\n团队的城堡生产和研究时间 -20%';
overrides['Tech:493'] = '研究骑士精神\n马厩生产和研究时间 -28.57%';
overrides['Tech:457'] = '研究井喷\n兵营生产和研究时间 -50%';
writeFileSync(overridesPath, JSON.stringify(overrides, null, 2) + '\n');

for (const file of readdirSync(resolve(root, 'public/tech-tree-data/civs')).filter(file => file.endsWith('.json'))) {
  const path = resolve(root, 'public/tech-tree-data/civs', file);
  const tree = JSON.parse(readFileSync(path, 'utf8'));
  if (tree.id === 'varangians') {
    const parents = { 'Unit:2704': 'Unit_2703_12', 'Unit:533': 'Unit_250_45' };
    for (const node of tree.nodes) if (parents[node.entity]) node.parent = parents[node.entity];
  }
  writeFileSync(path, JSON.stringify(tree));
}

console.log(`Applied requested technology-tree fixes to ${Object.keys(changes).length} civilizations.`);
