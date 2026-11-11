import { readFile, writeFile } from 'node:fs/promises';

const [snapshotPath, outputPath] = process.argv.slice(2);
if (!snapshotPath || !outputPath) throw Error('Usage: node tools/report-liquipedia-team-rosters.mjs <snapshot.json> <report.md>');
const data = JSON.parse(await readFile(snapshotPath, 'utf8'));
const escape = value => String(value).replace(/[\\[\]*_<>|]/g, '\\$&');
const wiki = title => 'https://liquipedia.net/ageofempires/' + encodeURIComponent(title.replaceAll(' ', '_'));
const groups = Map.groupBy(data.unresolved, player => player.teamTitle);
const lines = [
  '# Liquipedia 战队账号待确认清单',
  '',
  '同步时间：' + new Date(data.fetchedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）',
  '共同步 ' + data.teams.length + ' 支战队；' + data.unresolved.length + ' 条成员记录无法确认游戏账号。',
  '',
  '如果知道对应账号，请提供成员名和 Profile ID（或玩家资料页链接）。',
  ''
];
for (const [title, players] of groups) {
  lines.push('## [' + escape(players[0].team) + '](' + wiki(title) + ')', '');
  for (const p of players) {
    const name = p.title ? '[' + escape(p.name) + '](' + wiki(p.title) + ')' : escape(p.name);
    lines.push('- ' + name + (p.reason === 'multiple' ? '：可能对应多个账号（' + p.candidates.join('、') + '）' : '：未找到本站账号对应关系'));
  }
  lines.push('');
}
if (data.conflicts.length) {
  lines.push('## 已有账号对应关系、但列在多支战队名单中的成员', '');
  for (const p of data.conflicts) lines.push('- ' + escape(p.name || p.id) + '（' + p.id + '）：' + p.teams.map(escape).join('、'));
  lines.push('');
}
if (data.unknownTeams.length) {
  lines.push('## Liquipedia 未明确标注项目的队伍', '', ...data.unknownTeams.map(t => '- [' + escape(t) + '](' + wiki(t) + ')'), '');
}
await writeFile(outputPath, lines.join('\n'), 'utf8');
