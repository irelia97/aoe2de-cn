import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readLobbyMapSeed, extractReplayMapSeed } from '../public/replay-map-seed.js';

const summary = { header: { version_major: 68, replay: { random_seed: 15774 }, game_settings: {
  reveal_map: 0, fog_of_war: true, map_size: 120, population_limit: 200, game_type: 0, lock_teams: true, treaty_length: 0,
} } };
function header(seed, chats = ['']) {
  const settings = Buffer.alloc(28);
  [0,1,120,200].forEach((value,i) => settings.writeUInt32LE(value,i*4));
  settings[16]=0; settings[17]=1;
  const count = Buffer.alloc(4); count.writeUInt32LE(chats.length);
  const messages = chats.map(text => {
    const bytes = Buffer.from(text+'\0'), size=Buffer.alloc(4);size.writeUInt32LE(bytes.length);
    return Buffer.concat([size,bytes]);
  });
  const end = Buffer.alloc(28);end.writeInt32LE(seed);end.writeUInt32LE(3,23);
  return Buffer.concat([Buffer.alloc(128,0x77),settings,count,...messages,end]);
}

test('read the lobby map seed instead of the unrelated replay RNG state', () => {
  assert.equal(readLobbyMapSeed(header(1355428952),summary),1355428952);
  for (const seed of [0,-1,2147483647,-2147483648]) assert.equal(readLobbyMapSeed(header(seed,['hello','测试']),summary),seed);
});

test('mismatched settings, unsupported versions and truncated or bad chat framing fail closed', () => {
  assert.equal(readLobbyMapSeed(header(1),{header:{...summary.header,version_major:69}}),null);
  assert.equal(readLobbyMapSeed(header(1),{header:{...summary.header,game_settings:{...summary.header.game_settings,map_size:144}}}),null);
  assert.equal(readLobbyMapSeed(header(1).subarray(0,150),summary),null);
  const bad=header(1);bad.writeUInt32LE(1000000,128+28);
  assert.equal(readLobbyMapSeed(bad,summary),null);
  const badTerm=header(1);badTerm[128+28+4+4]=65;
  assert.equal(readLobbyMapSeed(badTerm,summary),null);
});

test('browser-compatible extraction decompresses the header and rejects corrupt recordings', async () => {
  const compressed=deflateRawSync(header(1355428952)),prefix=Buffer.alloc(8);prefix.writeUInt32LE(compressed.length+8);
  assert.equal(await extractReplayMapSeed(Buffer.concat([prefix,compressed,Buffer.alloc(20)]),summary),1355428952);
  assert.equal(await extractReplayMapSeed(Buffer.from('bad'),summary),null);
  assert.equal(await extractReplayMapSeed(Buffer.alloc(20),summary),null);
});

test('page and server analysis use the dedicated map seed and never display RNG as fallback', () => {
  const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(app.includes('Number.isInteger(summary?.mapSeed)'));
  assert.ok(!app.includes('String(header.replay.random_seed)'));
  assert.ok(app.includes('summary.mapSeed = await extractReplayMapSeed(buffer, summary)'));
  const worker=readFileSync(new URL('../server/services/replay-analysis-worker.js',import.meta.url),'utf8');
  assert.ok(worker.includes('summaryData.mapSeed = readLobbyMapSeed('));
});
