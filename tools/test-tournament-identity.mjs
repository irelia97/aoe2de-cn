import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTournament } from '../server/services/tournament-identity.js';
test('stage anchors inherit main tournament and tier without merging editions', () => {
  const main = { name:'Sudden Dessaster 3', tier:'A-Tier', url:'https://liquipedia.net/ageofempires/Sudden_Dessaster/3' };
  const items = [main, { name:'Sudden Dessaster 4', tier:'B-Tier', url:'https://liquipedia.net/ageofempires/Sudden_Dessaster/4' }];
  assert.equal(resolveTournament({ name:'Sudden Dessaster 3 - Top 32', url:main.url+'#Top_32' },items),main);
  assert.equal(resolveTournament({ name:'Sudden Dessaster 3 - Group Stage', url:main.url+'/Group_Stage' },items),main);
  assert.equal(resolveTournament({ name:'Sudden Dessaster 30', url:main.url+'0' },items),undefined);
  assert.equal(resolveTournament({ name:'Sudden Dessaster 3' },items),main);
});
