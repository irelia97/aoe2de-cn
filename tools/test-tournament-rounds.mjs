import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTournamentRounds, findTournamentRound, tournamentRoundNameZh } from '../server/services/tournament-rounds.js';
test('bracket headers map nested matches to Chinese rounds and exact fixture dates',()=>{
  const source = `{{Bracket|Bracket/32
|R3M1header=Quarterfinals ({{abbr/Bo5}})
|R4M1header=Semifinals ({{abbr/Bo7}})
|R3M2={{Match|date=November 4, 16:30 {{abbr/GMT}}
|bestof=5
|opponent1={{SoloOpponent|TheViper}}
|opponent2={{SoloOpponent|Lucho}}
|map1={{Map|map=Test}}
}}
|R4M1={{Match|date=November 7, 2026 - 16:30 {{abbr/GMT}}
|opponent1={{SoloOpponent|TheViper}}
|opponent2={{SoloOpponent|Lucho}}
}}
}}`;
  const rows = parseTournamentRounds(source);
  assert.equal(rows.length,2);
  const match = {timestamp:Date.parse('2026-11-04T16:30:00Z')/1000,opponents:[{name:'Lucho'},{name:'TheViper'}]};
  assert.equal(findTournamentRound(match,rows)?.round,'1/4决赛');
  assert.equal(findTournamentRound(match,rows)?.bestOf,5);
  assert.equal(findTournamentRound({...match,timestamp:match.timestamp+10*86400},rows),null);
  assert.equal(tournamentRoundNameZh('Semifinals'),'半决赛');
  assert.equal(tournamentRoundNameZh('Final'),'决赛');
  assert.equal(tournamentRoundNameZh('Round of 16'),'16强');
});
