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

test('winner and loser matches in the same bracket column use their own headers', () => {
  const source = `{{Bracket|Bracket/8U4L2DSL1D
|R2M1header=WB Semifinals ({{abbr/Bo5}})
|R4M1header=WB Final ({{abbr/Bo5}})
|R2M3header=LB Round of 6 ({{abbr/Bo5}})
|R4M2header=LB Final ({{abbr/Bo7}})
|R2M2={{Match
|date=November 26, 2026 - 18:45 {{abbr/GMT}}
|opponent1={{SoloOpponent|Liereyy}}
|opponent2={{SoloOpponent|Sebastian}}
}}
|R2M4={{Match
|date=November 27, 2026 - 15:00 {{abbr/GMT}}
|opponent1={{SoloOpponent|Vinchester}}
|opponent2={{SoloOpponent|ACCM}}
}}
|R4M1={{Match
|date=November 27, 2026- 17:30 {{abbr/GMT}}
|opponent1={{SoloOpponent|Hera}}
|opponent2={{SoloOpponent|Sebastian}}
}}
|R4M2={{Match
|date=November 29, 2026 - 13:30 {{abbr/GMT}}
|opponent1={{SoloOpponent|Sebastian}}
|opponent2={{SoloOpponent|Liereyy}}
}}
}}`;
  const rows = parseTournamentRounds(source);
  assert.deepEqual(rows.map(row => row.round), ['WB Semifinals', 'LB Round of 6', 'WB Final', 'LB Final']);
  const match = { timestamp: Date.parse('2026-11-27T17:30:00Z') / 1000, opponents: [{ name: 'Hera' }, { name: 'Sebastian' }] };
  assert.equal(findTournamentRound(match, rows)?.round, 'WB Final');
});
