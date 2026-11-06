import assert from 'node:assert/strict';
import { qualifiesForSchedule, scheduleTierLabel } from '../public/realtime-schedule.js';
import { createRealtimeChat } from '../server/services/realtime-chat.js';
for (const tier of ['S','A','B','B-Tier']) assert.equal(qualifiesForSchedule({tournament:{tier}}),true);
for (const tier of ['', 'C']) {
  assert.equal(qualifiesForSchedule({tournament:{tier},opponents:[{countryCode:'CN'}]}),true);
  assert.equal(qualifiesForSchedule({tournament:{tier},opponents:[{country:'China'}]}),true);
  assert.equal(qualifiesForSchedule({tournament:{tier},opponents:[{countryCode:'DE'}]}),false);
}
assert.equal(qualifiesForSchedule({}),false);
assert.equal(scheduleTierLabel({tournament:{tier:''}}),'未定级');
const chat=createRealtimeChat({path:':memory:'});
try {
  const notice=chat.announceSchedule({day:'china-test',matches:[{timestamp:Date.now()/1000+3600,tournament:{name:'中国选手测试赛'},opponents:[{name:'A',countryCode:'CN'},{name:'B'}]}]});
  assert.match(notice.content,/未定级[|｜]中国选手测试赛/);
  assert.doesNotMatch(notice.content,/undefined/);
} finally {chat.close();}
console.log('schedule qualification and notice tests passed');
