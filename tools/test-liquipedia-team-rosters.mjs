import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTeam, createTeamRosterSync, indexTeamRosters, parseTeamDirectory } from '../server/services/liquipedia-team-rosters.js';

const row = (name, title = name, role = '') => '<tr><td><span class="inline-player">' +
  '<a href="/ageofempires/' + title + '">' + name + '</a></span></td><td></td><td>' + role + '</td></tr>';
const table = (name, title, rows) => '<table><tr><th><span class="team-template-text">' +
  '<a href="/ageofempires/' + title + '">' + name + '</a></span></th></tr>' + rows + '</table>';
const portal = '<h2 id="Active_Teams">Active</h2>' +
  table('CN ZhongSheng', 'CN_ZhongSheng', row('CC', 'CC_(Chinese_player)') + row('ique')) +
  table('Multi', 'Multi', row('Other player', 'Other_player', 'AoEO')) +
  '<h2 id="Disbanded_Teams">Disbanded</h2>' + table('Old', 'Old', row('Former'));
const refs = new Map([
  ['42', { name: 'CC', canonicalProfileId: '42' }],
  ['43', { name: 'CC', canonicalProfileId: '42' }]
]);

test('uses the active directory and identifies AoE2 from team metadata', () => {
  const teams = parseTeamDirectory(portal);
  assert.deepEqual(teams.map(t => t.title), ['CN ZhongSheng', 'Multi']);
  assert.equal(teams[0].members[0].title, 'CC (Chinese player)');
  assert.equal(classifyTeam('|games=aoe4, aoe2', []), 'aoe2');
  assert.equal(classifyTeam('|games=aom', []), 'other');
  assert.equal(classifyTeam('', [{ role: 'AoE2/Captain' }]), 'aoe2');
  assert.throws(() => parseTeamDirectory('<h2 id="Active_Teams">Active</h2>'));
});

test('reports unknown and ambiguous accounts while grouping linked IDs', () => {
  const [team] = parseTeamDirectory(portal);
  assert.equal(indexTeamRosters([team], refs).byProfile.get('42').get('cn zhongsheng'), 'CN ZhongSheng');
  const ambiguous = new Map([...refs, ['44', { name: 'CC', canonicalProfileId: '44' }]]);
  assert.deepEqual(indexTeamRosters([team], ambiguous).unresolved.map(({name, reason}) => [name, reason]), [
    ['CC', 'multiple']
  ]);
  assert.equal(indexTeamRosters([team], ambiguous).byProfile.get('11192068').get('cn zhongsheng'), 'CN ZhongSheng');
});

test('refresh saves a complete roster, keeps accounts with other game roles out and updates linked accounts', async () => {
  let saved;
  const sync = createTeamRosterSync({
    read: async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); },
    save: async text => { saved = JSON.parse(text); },
    fetchDirectory: async () => portal,
    fetchTeamPages: async () => new Map([['CN ZhongSheng', '|games=aoe2'], ['Multi', '|games=aoe2,aoeo']]),
    references: async () => refs,
    onChange: () => done()
  });
  let done;
  const changed = new Promise(resolve => { done = resolve; });
  sync.start();
  await changed;
  assert.deepEqual(saved.teams[1].members, []);
  const verified = new Map([['999', { canonicalProfileId: '42' }]]);
  const result = await sync.apply(new Map([['43', ''], ['999', ''], ['500', 'Original']]), refs, verified);
  assert.deepEqual([...result.values()], ['CN ZhongSheng', 'CN ZhongSheng', 'Original']);
});
