import test from 'node:test';
import assert from 'node:assert/strict';
import { liveNotificationChanges } from '../server/services/live-notifications.js';

const twitch = { name:'T90', platform:'twitch', url:'https://www.twitch.tv/t90official', profileIds:['42'] };
const youtube = { name:'T90', platform:'youtube', url:'https://www.youtube.com/watch?v=one', profileIds:['42'] };

test('switching the displayed platform never announces the streamer offline or online again', () => {
  assert.deepEqual(liveNotificationChanges([twitch],[youtube]), { started:[], ended:[] });
  assert.deepEqual(liveNotificationChanges([youtube],[twitch]), { started:[], ended:[] });
  assert.deepEqual(liveNotificationChanges([youtube],[{...youtube,url:'https://www.youtube.com/watch?v=two'}]), { started:[], ended:[] });
});

test('one end notification only after the last selected platform goes offline', () => {
  const first = liveNotificationChanges([twitch],[youtube]);
  const last = liveNotificationChanges([youtube],[]);
  const next = liveNotificationChanges([],[]);
  assert.equal(first.ended.length + last.ended.length + next.ended.length,1);
  assert.equal(last.ended[0].name,'T90');
});

test('multiple sources for the same streamer generate one start and one end', () => {
  assert.equal(liveNotificationChanges([],[twitch,youtube]).started.length,1);
  assert.equal(liveNotificationChanges([twitch,youtube],[]).ended.length,1);
});

test('names match without profile metadata; linked profiles match despite display name differences', () => {
  assert.deepEqual(liveNotificationChanges([{...twitch,profileIds:[]}],[{...youtube,profileIds:[]}]), { started:[], ended:[] });
  assert.deepEqual(liveNotificationChanges([twitch],[{...youtube,name:'T90Official'}]), { started:[], ended:[] });
});

test('source request errors do not generate an end notification', () => {
  assert.deepEqual(liveNotificationChanges([twitch],[],new Set([`twitch|${twitch.url}`])), { started:[], ended:[] });
});

test('an unrelated streamer does not suppress the previous streamer going offline', () => {
  const other = {...youtube,name:'Hera',profileIds:['43']};
  assert.deepEqual(liveNotificationChanges([twitch],[other]), { started:[other], ended:[twitch] });
});
