import assert from 'node:assert/strict';
import { createRealtimeChat } from '../server/services/realtime-chat.js';

let clock = 1_800_000_000_000;
const chat = createRealtimeChat({ path: ':memory:', now: () => clock });
try {
  assert.deepEqual(chat.list(), []);
  const visitorA = chat.viewer('a');
  assert.equal(chat.viewer('a').uid, visitorA.uid);
  assert.notEqual(chat.viewer('b').uid, visitorA.uid);
  assert.equal(visitorA.canRenameAt, 0);
  assert.throws(() => chat.post({ name: '游客', message: '加微信 abc123456', ip: 'a' }), { statusCode: 422 });
  assert.throws(() => chat.post({ name: '游客', message: '你去死吧', ip: 'a' }), { statusCode: 422 });
  assert.throws(() => chat.post({ name: '游客', message: '<script>alert(1)</script>', ip: 'a' }), { statusCode: 422 });
  assert.equal(chat.list().length, 0);
  assert.equal(chat.post({ name: '游客', message: 'test123, ViVi >>> Yo, 测试测试洞妖洞妖茨歌仙', ip: 'comparison' }).content, 'test123, ViVi >>> Yo, 测试测试洞妖洞妖茨歌仙');
  const first = chat.post({ name: '测试访客', message: '大家好，今晚有比赛吗？', ip: 'a' });
  assert.equal(first.kind, 'user');
  assert.equal(first.uid, visitorA.uid);
  assert.equal(chat.viewer('a').nickname, '测试访客');
  assert.throws(() => chat.rename({ name: '改名太快', ip: 'a' }), { statusCode: 429 });
  assert.equal(chat.list().find(item => item.id === first.id)?.content, first.content);
  assert.throws(() => chat.post({ name: '测试访客', message: '第二条', ip: 'a' }), { statusCode: 429 });
  clock += 10_000;
  assert.throws(() => chat.post({ name: '测试访客', message: first.content, ip: 'a' }), { statusCode: 429 });
  assert.equal(chat.post({ name: '测试访客', message: '第二条', ip: 'a' }).kind, 'user');
  const notice = chat.announceLive({ name: 'Clearlove', title: '帝国时代直播', url: 'https://live.douyin.com/579136196080' });
  assert.equal(notice.kind, 'system');
  assert.equal(chat.announceLive({ name: 'Clearlove', url: notice.url }), null);
  assert.equal(chat.list().at(-1).url, notice.url);
  clock += 61 * 60_000;
  assert.equal(chat.announceLive({ name: 'Clearlove', url: notice.url }).kind, 'system');
  assert.equal(chat.announceLiveEnd({ name: 'Clearlove', url: notice.url }).content, 'Clearlove 已结束直播');
  assert.equal(chat.announceLiveEnd({ name: 'Clearlove', url: notice.url }), null);
  const match={id:'match-1',tournament:{name:'测试杯',url:'https://liquipedia.net/ageofempires/Test'},opponents:[{name:'Yo'},{name:'Vivi'}],score:['3','2']};
  assert.match(chat.announceMatch({phase:'start',match,tier:'S'}).content,/S级赛事开始/);
  assert.equal(chat.announceMatch({phase:'start',match,tier:'S'}),null);
  assert.match(chat.announceMatch({phase:'end',match,tier:'S'}).content,/3–2/);
  assert.match(chat.announceSchedule({day:'2026-10-27',matches:[{timestamp:clock/1000+3600,tier:'A',opponents:[{name:'A'},{name:'B'}]}]}).content,/未来12小时比赛预告/);
  clock += 15 * 24 * 60 * 60_000;
  assert.equal(chat.rename({ name: '新昵称', ip: 'a' }).nickname, '新昵称');
  assert.equal(chat.list().find(item => item.id === first.id)?.author, '新昵称'); // history is retained for thirty days
  assert.throws(() => chat.rename({ name: '又改名', ip: 'a' }), { statusCode: 429 });
  console.log('realtime chat tests passed');
} finally {
  chat.close();
}
