import test from 'node:test';
import assert from 'node:assert/strict';
import {tournamentFinalScore} from '../server/services/liquipedia-tournament-scores.js';

test('grand-final map winners become a winner-first score',()=>{
  const source=`{{Match|opponent1={{SoloOpponent|Liereyy}}|opponent2={{SoloOpponent|Hera}}
  |map1={{Map|winner=1}}|map2={{Map|winner=2}}|map3={{Map|winner=1}}
  |map4={{Map|winner=2}}|map5={{Map|winner=2}}|map6={{Map|winner=2}}}}`;
  assert.equal(tournamentFinalScore(source,'Hera','Liereyy'),'4–2');
});

test('the largest winning match is selected and unresolved matches stay blank',()=>{
  const source='{{Match|opponent1=A|opponent2=B|score1=2|score2=1}}{{Match|opponent1=A|opponent2=B|score1=4|score2=2}}';
  assert.equal(tournamentFinalScore(source,'A','B'),'4–2');
  assert.equal(tournamentFinalScore(source,'TBD','B'),'');
});

test('legacy brackets expose scores inside opponent templates',()=>{
  const source='{{Match|opponent1={{SoloOpponent|name=TheViper|score=5}}\n|opponent2={{SoloOpponent|name=JorDan_23|score=1}}}}';
  assert.equal(tournamentFinalScore(source,'TheViper','JorDan_23'),'5–1');
});
