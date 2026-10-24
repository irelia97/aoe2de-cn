import { randomUUID } from 'node:crypto';

export function createReplayJobs({ replayService, now = Date.now, maxJobs = 32 }) {
  const jobs = new Map(), keys = new Map();
  let active = 0;
  function prune() {
    for (const [id, job] of jobs) if (job.state !== 'running' && now() - job.updatedAt >= 30 * 60000) {
      jobs.delete(id); if (keys.get(job.key) === id) keys.delete(job.key);
    }
  }
  return {
    stats: () => ({ active, jobs: jobs.size }),
    get: id => jobs.get(id),
    submit(matchId, profileId) {
      if (!/^[1-9]\d{0,15}$/.test(String(matchId)) || !/^[1-9]\d{0,15}$/.test(String(profileId))) {
        throw Object.assign(new Error('无效的比赛或玩家 ID'), { statusCode: 400 });
      }
      prune();
      const key = `${matchId}:${profileId}`, existing = jobs.get(keys.get(key));
      if (existing && existing.state !== 'failed') return { jobId: existing.id, state: existing.state };
      if (active >= 1 || jobs.size >= maxJobs) throw Object.assign(new Error('录像处理繁忙，请稍后重试'), { statusCode: 429 });
      if (existing) jobs.delete(existing.id);
      const job = { id: randomUUID(), key, state: 'running', updatedAt: now() };
      jobs.set(job.id, job); keys.set(key, job.id); active++;
      Promise.resolve().then(() => replayService.get(matchId, profileId)).then(result => {
        // Results remain in the service's bounded disk cache, not retained in RAM.
        job.state = 'ready'; job.cached = result.cached;
      }, error => { job.state = 'failed'; job.error = error.message; }).finally(() => { job.updatedAt = now(); active--; });
      return { jobId: job.id, state: job.state };
    }
  };
}
