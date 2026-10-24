import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { formatReplayDanmaku, matchRatingChange } from './replay-danmaku-summary.js';

// Track observed games only. Persist retries across service restarts; never backfill history.
export function createReplayEndedNotifier({ statePath, profileIds, replayService, send, prepare = async () => {}, cancelPreparation = () => {}, fetchImpl = fetch, now = Date.now }) {
  let jobs, activeTask;
  let mutations = Promise.resolve();
  const ready = readFile(statePath,'utf8').then(text => { jobs = JSON.parse(text); }).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    jobs = {};
  });
  const save = async () => {
    await mkdir(dirname(statePath),{recursive:true});
    await writeFile(`${statePath}.tmp`,JSON.stringify(jobs),{mode:0o600});
    await rename(`${statePath}.tmp`,statePath);
  };
  function mutate(fn) {
    const task = mutations.then(async () => { await ready; return fn(); });
    mutations = task.catch(() => {});
    return task;
  }
  function observe(match) {
    return mutate(async () => {
      if (match.finished || match.abandoned || !match.players || match.players.length < 2) return;
      const id = String(match.matchId ?? match.id ?? '');
      if (!/^\d+$/.test(id) || jobs[id]) return;
      const watched = profileIds.filter(id => match.players.some(p => String(p.profileId ?? p.id) === String(id)));
      if (!watched.length) return;
      const playerNames = Object.fromEntries(match.players.map(player => [
        String(player.profileId ?? player.id), String(player.name || '未知玩家').trim()
      ]));
      jobs[id] = {match:structuredClone(match), playerNames, watched, observedAt:now(), nextAt:now()+30000, sent:[], failures:0};
      await save();
    });
  }
  async function runTick() {
    try {
      await ready;
      for (const [id,job] of Object.entries(jobs)) {
        if (job.done || job.nextAt > now()) continue;
        if ((job.failures ?? (job.lastError ? 1 : 0)) >= 2) {
          await mutate(async () => { job.done = true; await save(); });
          continue;
        }
        if (now()-job.observedAt > 12*3600000 || (job.endedAt && now()-job.endedAt > 30*60000)) {
          console.warn(`[danmaku] matchEnded ${id} expired without successful summary`);
          await mutate(async () => { job.done = true; await save(); });
          continue;
        }
        try {
          if (!job.endedAt || !job.ratingMatch) {
            const response = await fetchImpl(`https://data.aoe2companion.com/api/matches/${id}`,{signal:AbortSignal.timeout(15000),headers:{accept:'application/json','user-agent':'AOE2DE-CN/1.0'}});
            if (!response.ok) throw new Error(`结束状态查询 HTTP ${response.status}`);
            const match = await response.json();
            if (String(match.matchId ?? match.id) !== id) throw new Error('结束状态对局 ID 不匹配');
            if (match.abandoned) { await mutate(async () => { job.done=true; await save(); }); continue; }
            if (!match.finished) { await mutate(async () => { job.nextAt=now()+30000; await save(); }); continue; }
            await mutate(async () => {
              job.endedAt ||= now();
              job.ratingMatch = {
                leaderboard: match.leaderboardId || match.leaderboard || '',
                players: (match.teams || []).flatMap(team => team.players || []).concat(match.players || [])
                  .map(player => ({ profileId: player.profileId ?? player.id, ratingDiff: player.ratingDiff ?? player.ratingDelta }))
              };
              await save();
            });
          }
          const pendingProfiles = job.watched.filter(profileId => !job.sent.includes(String(profileId)));
          if (pendingProfiles.length) await prepare(job.match, String(pendingProfiles[0]));
          const result = await replayService.get(id,String(job.watched[0]));
          const replay = JSON.parse(gunzipSync(result.data));
          if (String(replay.matchId) !== id) throw new Error('录像对局 ID 不匹配');
          for (const profileId of job.watched) {
            if (job.sent.includes(String(profileId))) continue;
            if (String(profileId) !== String(pendingProfiles[0])) await prepare(job.match, String(profileId));
            // Older jobs already persisted the opening match, so they can use
            // the same names without consulting the latest profile or replay.
            const playerNames = job.playerNames || Object.fromEntries((job.match.players || []).map(player => [
              String(player.profileId ?? player.id), String(player.name || '未知玩家').trim()
            ]));
            const message = formatReplayDanmaku(replay,profileId,playerNames,matchRatingChange(job.ratingMatch,profileId));
            await send(job.match,String(profileId),message);
            await mutate(async () => { job.sent.push(String(profileId)); await save(); });
          }
          await mutate(async () => { job.done=true; job.completedAt=now(); await save(); });
        } catch (error) {
          for (const profileId of job.watched) cancelPreparation(job.match, String(profileId));
          if (error.terminal || /返回码\s*356/.test(String(error.message))) {
            console.warn(`[danmaku] matchEnded ${id} send failed; automatic retries stopped: ${error.message}`);
            await mutate(async () => { job.done=true; job.lastError=error.message; await save(); });
            continue;
          }
          const failures = (job.failures ?? (job.lastError ? 1 : 0)) + 1;
          console.warn(`[danmaku] matchEnded ${id} failed; ${failures >= 2 ? 'retry exhausted; summary cancelled' : 'retry once in 10s'}: ${error.message}`);
          await mutate(async () => {
            job.failures = failures;
            job.lastError = error.message;
            if (failures >= 2) { job.done = true; job.failedAt = now(); }
            else job.nextAt = now() + 10000;
            await save();
          });
        }
      }
      await mutate(async () => {
        let changed = false;
        for (const [id,job] of Object.entries(jobs)) if (job.done && now()-job.observedAt>7*86400000) { delete jobs[id]; changed = true; }
        if (changed) await save();
      });
    } catch(error) { console.warn('[danmaku] matchEnded monitor failed:',error.message); }

  }
  function tick() {
    if (!activeTask) activeTask=runTick().finally(() => { activeTask=null; });
    return activeTask;
  }
  const timer = setInterval(tick,1000); timer.unref?.();
  ready.then(tick).catch(error => console.warn('[danmaku] matchEnded state unavailable:',error.message));
  return {observe,tick,stop:()=>clearInterval(timer)};
}
