import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityCutoff, personalActivity } from '../server/services/realtime-pool-activity.js';
test('activity cutoff is exactly 45 days across month boundaries', () => {
  assert.equal(new Date(activityCutoff(new Date('2026-11-04T10:00:00Z')) * 1000).toISOString(), '2026-09-20T10:00:00.000Z');
  const now = new Date('2026-03-15T10:00:00Z');
  assert.equal(now.getTime() / 1000 - activityCutoff(now), 45 * 24 * 60 * 60);
});
test('official stat groups map latest activity to profile IDs', () => {
  const times = personalActivity({ result: { code: 0 }, statGroups: [{ id: 4, members: [{ profile_id: 10 }] }], leaderboardStats: [{ statgroup_id: 4, lastmatchdate: 100 }, { statgroup_id: 4, lastmatchdate: 200 }] });
  assert.equal(times.get('10'), 200);
  assert.throws(() => personalActivity({ result: { code: 1 } }));
});
