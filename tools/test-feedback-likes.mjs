import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeedbackLikes } from '../server/services/feedback-likes.js';
import { feedbackId, recentFeedback } from '../server/services/feedback-feed.js';

test('likes persist and the same IP cannot vote twice, including from another database connection', async () => {
  const dir=await mkdtemp(join(tmpdir(),'feedback-likes-')),path=join(dir,'likes.sqlite');
  let first=createFeedbackLikes(path),second=createFeedbackLikes(path);
  const card='a'.repeat(64),other='b'.repeat(64);
  try {
    assert.deepEqual(first.like(card,'192.0.2.1'),{likes:1,liked:true,added:true});
    assert.deepEqual(second.like(card,'::ffff:192.0.2.1'),{likes:1,liked:true,added:false});
    assert.equal(second.like(card,'192.0.2.2').likes,2);
    assert.equal(first.like(other,'192.0.2.1').added,true);
    first.close();first=createFeedbackLikes(path);
    assert.deepEqual(first.decorate([{id:card}],'192.0.2.1'),[{id:card,likes:2,liked:true}]);
    assert.deepEqual(first.decorate([{id:card}],'192.0.2.3'),[{id:card,likes:2,liked:false}]);
    assert.equal(first.like(card,'192.0.2.1').added,false);
    assert.throws(()=>first.like('invalid','192.0.2.1'),{statusCode:400});
    assert.throws(()=>first.like(card,'unknown'),{statusCode:400});
  } finally { first.close();second.close();await rm(dir,{recursive:true,force:true}); }
});

test('equivalent IPv6 representations share a single vote', async () => {
  const dir=await mkdtemp(join(tmpdir(),'feedback-ipv6-'));const store=createFeedbackLikes(join(dir,'likes.sqlite'));
  try {
    assert.equal(store.like('a'.repeat(64),'2001:db8::1').added,true);
    assert.equal(store.like('a'.repeat(64),'2001:0DB8:0000:0000:0000:0000:0000:0001').added,false);
  } finally { store.close();await rm(dir,{recursive:true,force:true}); }
});

test('legacy feedback receives stable distinct IDs without exposing raw IPs', async () => {
  const dir=await mkdtemp(join(tmpdir(),'feedback-feed-')),path=join(dir,'feed.jsonl');
  const records=[{ip:'192.0.2.1',content:'旧反馈',sentAt:'2026-10-24T12:00:00Z'},
    {ip:'192.0.2.1',content:'新反馈',sentAt:'2026-10-25T12:00:00Z'}];
  try {
    await writeFile(path,records.map(JSON.stringify).join('\n')+'\nmalformed\n');
    const items=await recentFeedback(path);
    assert.equal(items.length,2);assert.equal(items[0].id,feedbackId(records[1]));
    assert.notEqual(items[0].id,items[1].id);assert.equal(items[0].ip,'192.0.*.*');
    assert.deepEqual(await recentFeedback(path),items);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
