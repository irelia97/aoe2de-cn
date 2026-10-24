import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayJobs } from '../server/services/replay-jobs.js';

test('replay submission responds immediately, merges duplicate jobs and limits concurrency', async () => {
  let complete, calls = 0;
  const jobs = createReplayJobs({ replayService: { get: async () => { calls++; await new Promise(resolve => { complete = resolve; }); return { cached: false }; } } });
  const task = jobs.submit('123', '456');
  assert.equal(jobs.submit('123', '456').jobId, task.jobId);
  assert.throws(() => jobs.submit('124', '456'), { statusCode: 429 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(task.jobId).state, 'running'); complete();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(task.jobId).state, 'ready'); assert.equal(calls, 1); assert.equal(jobs.stats().active, 0);
});

test('failed jobs return a failure and allow an explicit new submission', async () => {
  let clock = 1000;
  const jobs = createReplayJobs({ now: () => clock, replayService: { get: async () => { throw new Error('download timeout'); } } });
  const first = jobs.submit('123', '456');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.get(first.jobId).state, 'failed');
  assert.equal(jobs.get(first.jobId).error, 'download timeout');
  assert.notEqual(jobs.submit('123', '456').jobId, first.jobId);
});
