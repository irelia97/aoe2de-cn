import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const parser = source.slice(source.indexOf('function decodeLiquipediaHtml('), source.indexOf('function normalizedTournamentTier('));
const { parseLiquipediaMatches } = vm.runInNewContext(`${parser};({parseLiquipediaMatches})`, { createHash, URL });
// Captured from the Liquipedia parse API on 2026-11-20 (CC BY-SA 3.0).
const fixture = readFileSync(new URL('./fixtures/liquipedia-match-ticker-20261120.html', import.meta.url), 'utf8');

test('current ticker cards preserve players, teams, scores, flags, BO and both logos', () => {
  for (const html of [fixture, fixture.replaceAll('&#95;', '_')]) {
    const result = parseLiquipediaMatches(html);
    assert.equal(result.upcoming.length, 1);
    assert.equal(result.completed.length, 2);
    const match = result.upcoming[0];
    assert.equal(match.opponents[0].name, 'iBUYPOWER');
    assert.equal(match.opponents[0].countryCode, 'CN');
    assert.equal(match.opponents[0].isTeam, undefined);
    assert.equal(match.timestamp, 1795183200);
    assert.equal(match.bestOf, 5);
    assert.equal(match.tournament.name, 'CNZS Int Inv: Nov 2026');
    assert.ok(match.tournament.url.endsWith('/2026/November#Results'));
    const team = result.completed[0];
    assert.equal(team.opponents[0].name, 'The 105 Gang');
    assert.equal(team.opponents[1].name, 'Panda Panda Panda');
    assert.equal(team.opponents[0].flag, '');
    assert.equal(team.opponents[0].isTeam, true);
    assert.match(team.opponents[0].logo, /^https:\/\/liquipedia\.net\/commons\/images\//);
    assert.equal(team.opponents[1].isTeam, true);
    assert.equal(team.opponents[1].winner, true);
    assert.equal(team.opponents[0].loser, true);
    assert.equal(JSON.stringify(team.score), '["0","3"]');
    assert.equal(JSON.stringify(result.completed[1].score), '["1","2"]');
    assert.match(result.completed[1].tournament.logoLight, /lightmode/);
    assert.match(result.completed[1].tournament.logoDark, /darkmode/);
  }
});

test('legacy match cards remain supported and duplicate cards are merged', () => {
  const card = `<div class="match-info"><span data-timestamp="1795105800" data-finished="finished"></span>
    <div class="match-info-header-opponent match-info-header-winner"><span class="name"><a href="/ageofempires/Liereyy">Liereyy</a></span></div>
    <div class="match-info-header-opponent match-info-header-loser"><span class="name">Hera</span></div>
    <span class="match-info-header-scoreholder-score">3</span><span class="match-info-header-scoreholder-score">1</span>
    <div class="match-info-tournament"><span class="match-info-tournament-name"><a href="/ageofempires/Test">Test</a></span></div>(Bo5)</div>`;
  const result = parseLiquipediaMatches(card + card);
  assert.equal(result.completed.length, 1);
  assert.equal(result.completed[0].opponents[0].name, 'Liereyy');
  assert.equal(result.completed[0].bestOf, 5);
  assert.equal(JSON.stringify(result.completed[0].score), '["3","1"]');
});

test('tier enrichment retains snapshot metadata in API and cache paths', async () => {
  const code = source.slice(source.indexOf('async function addMatchTiers('), source.indexOf('function announceMatchTransitions('));
  const enrich = vm.runInNewContext(`${code};addMatchTiers`, {
    getLiquipediaTournamentsSnapshot: async () => ({ tournaments: [] }),
    loadLiquipediaMatchTiersCache: async () => ({ pages: {} }),
    resolveTournament: () => null, liquipediaMatchTierPage: () => '',
    normalizedTournamentTier: value => value || '', addMatchRounds: async value => value,
  });
  const snapshot = { fetchedAt: '2026-11-20T05:28:53Z', source: { name: 'Liquipedia' }, refreshIntervalMs: 60000, ...parseLiquipediaMatches(fixture) };
  for (const includeRounds of [true, false]) {
    const enriched = await enrich(snapshot, includeRounds);
    assert.equal(enriched.fetchedAt, snapshot.fetchedAt);
    assert.equal(enriched.source, snapshot.source);
    assert.equal(enriched.refreshIntervalMs, 60000);
    assert.equal(enriched.completed.length, 2);
  }
});

test('unrecognized responses cannot overwrite the matches cache with empty results', async () => {
  const start = source.indexOf('    const html = String(payload?.parse?.text');
  const end = source.indexOf('    const next = {', start);
  const validate = vm.runInNewContext(`async function validate(payload) { ${source.slice(start, end)};return parsed; };validate`, {
    parseLiquipediaMatches, liquipediaMatchesCache: {}, addMatchTiers: async value => value,
    addTournamentEloTop32Qualification: async value => value,
  });
  await assert.rejects(validate({ parse: { text: '<div class="match-info-links"></div>' } }), /保留已有缓存/);
  const parsed = await validate({ parse: { text: fixture } });
  assert.equal(parsed.completed.length, 2);
});
