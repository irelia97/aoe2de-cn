import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTournamentResultsHtml, tournamentResultCategories } from '../server/services/liquipedia-tournament-results.js';

const row = (name,extra) => `<tr class="table2&#95;&#95;row--body"><td>S-Tier</td><td></td><td></td><td class="column&#95;&#95;tournament"><a href="/ageofempires/${name}">${name}</a></td><td>Oct 01–03, 2026</td><td>$50,000</td><td>World</td><td>8</td>${extra}</tr>`;

test('tournament result tables retain year, links, artwork, flags, and placements',()=>{
  const html=`<h3 id="2026">2026</h3><table class="table2&#95;&#95;table">${row('Example_Event','<td>Hera</td><td>TheViper</td>')}</table>`;
  const [result]=parseTournamentResultsHtml(html);
  assert.equal(result.year,'2026');
  assert.equal(result.tier,'S-Tier');
  assert.equal(result.name,'Example_Event');
  assert.equal(result.url,'https://liquipedia.net/ageofempires/Example_Event');
  assert.equal(result.winnerEntries[0].name,'Hera');
  assert.equal(result.runnerUpEntries[0].name,'TheViper');
  assert.equal(result.score,'');
});

test('Liquipedia images are restricted to its asset host and retain flag metadata',()=>{
  const image='<span class="flag"><img alt="Canada" src="/commons/images/ca.png"></span>';
  const html=`<h3 id="2026">2026</h3><table class="table2__table"><tr><td>S-Tier</td><td></td><td><img src="/commons/images/event.png"></td><td class="column__tournament"><a href="/ageofempires/Event">Event</a></td><td>Oct 01, 2026</td><td>$1</td><td>${image}World</td><td>2</td><td>${image}<span class="name">Hera</span></td><td><span class="name">Viper</span></td></tr></table>`;
  const [result]=parseTournamentResultsHtml(html);
  assert.equal(result.logo,'https://liquipedia.net/commons/images/event.png');
  assert.equal(result.locationFlags[0].country,'Canada');
  assert.equal(result.winnerEntries[0].flag,'https://liquipedia.net/commons/images/ca.png');
});

test('qualifiers expose qualified players instead of winner and runner-up',()=>{
  const html=`<h3 id="2027">2027</h3><table class="table2__table">${row('Qualifier','<td class="column__qualified">Hera</td>')}</table>`;
  const [result]=parseTournamentResultsHtml(html);
  assert.equal(result.year,'2027');
  assert.equal(result.qualified,'Hera');
  assert.equal(result.winner,'');
  assert.equal(result.runnerUp,'');
  assert.deepEqual(Object.keys(tournamentResultCategories),['s','a','b','c','show','qualifier']);
});

test('team links and logos become separate placement entries',()=>{
  const teams='<span><img src="/commons/images/team-a.png"><a href="/ageofempires/Team_A">Team A</a></span><span><img src="/commons/images/team-b.png"><a href="/ageofempires/Team_B">Team B</a></span>';
  const html=`<h3 id="2026">2026</h3><table class="table2__table">${row('Qualifier',`<td class="column__qualified">${teams}</td>`)}</table>`;
  const [result]=parseTournamentResultsHtml(html);
  assert.deepEqual(result.qualifiedEntries.map(entry=>[entry.name,entry.logo]),[
    ['Team A','https://liquipedia.net/commons/images/team-a.png'],
    ['Team B','https://liquipedia.net/commons/images/team-b.png']
  ]);
});

test('known team pages contribute team logos when list pages omit them',()=>{
  const teams='<a href="/ageofempires/SY">SY</a> <a href="/ageofempires/Team_Vitality">Team Vitality</a>';
  const html=`<h3 id="2026">2026</h3><table class="table2__table">${row('Qualifier',`<td class="column__qualified">${teams}</td>`)}</table>`;
  const [result]=parseTournamentResultsHtml(html);
  assert.match(result.qualifiedEntries[0].logo,/SY_logo_screenshot/);
  assert.match(result.qualifiedEntries[1].logo,/Team_Vitality/);
});
