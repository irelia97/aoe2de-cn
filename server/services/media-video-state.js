import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { nextScheduledVideoRound } from './media-video-schedule.js';

export function mediaTimestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createMediaVideoStateStore(path, { now = Date.now } = {}) {
  const state = {
    nextRequestAt: 0,
    blockedUntil: 0,
    apiBlockedUntil: 0,
    rateLimitStrikes: 0,
    sources: new Map(),
    cycleSeen: new Set(),
    cycleOrder: [],
    cycleActive: false,
  };
  let loading;

  async function load() {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      state.nextRequestAt = mediaTimestamp(saved.nextRequestAt);
      state.blockedUntil = mediaTimestamp(saved.blockedUntil);
      state.apiBlockedUntil = mediaTimestamp(saved.apiBlockedUntil);
      state.rateLimitStrikes = Math.max(0, Number(saved.rateLimitStrikes) || 0);
      state.cycleOrder = [...new Set(Array.isArray(saved.cycleOrder) ? saved.cycleOrder.map(String) : [])];
      for (const key of Array.isArray(saved.cycleSeen) ? saved.cycleSeen : []) state.cycleSeen.add(String(key));
      for (const [key, value] of Object.entries(saved.sources || {})) {
        state.sources.set(key, {
          nextCheckAt: mediaTimestamp(value.nextCheckAt),
          lastAttemptAt: mediaTimestamp(value.lastAttemptAt),
          lastSuccessAt: mediaTimestamp(value.lastSuccessAt),
          failureCount: Math.max(0, Number(value.failureCount) || 0),
          idleSuccesses: Math.max(0, Number(value.idleSuccesses) || 0)
        });
      }
      if (saved.scheduleVersion === 'fixed-beijing-v1') {
        state.cycleActive = saved.cycleActive === true;
      } else {
        state.cycleSeen.clear();
        state.cycleOrder = [];
        state.nextRequestAt = nextScheduledVideoRound(now());
        for (const source of state.sources.values()) source.nextCheckAt = 0;
      }
    } catch {
      // The scheduler state is optional and will be created after the first check.
      state.nextRequestAt = nextScheduledVideoRound(now());
    }
  }

  async function save() {
    const sources = {};
    for (const [key, value] of state.sources) {
      sources[key] = {
        nextCheckAt: value.nextCheckAt ? new Date(value.nextCheckAt).toISOString() : null,
        lastAttemptAt: value.lastAttemptAt ? new Date(value.lastAttemptAt).toISOString() : null,
        lastSuccessAt: value.lastSuccessAt ? new Date(value.lastSuccessAt).toISOString() : null,
        failureCount: value.failureCount,
        idleSuccesses: value.idleSuccesses
      };
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      savedAt: new Date(now()).toISOString(),
      nextRequestAt: state.nextRequestAt ? new Date(state.nextRequestAt).toISOString() : null,
      blockedUntil: state.blockedUntil ? new Date(state.blockedUntil).toISOString() : null,
      apiBlockedUntil: state.apiBlockedUntil ? new Date(state.apiBlockedUntil).toISOString() : null,
      videoFetchMode: 'browser-dynamic-v1',
      scheduleVersion: 'fixed-beijing-v1',
      cycleActive: state.cycleActive,
      rateLimitStrikes: state.rateLimitStrikes,
      cycleOrder: state.cycleOrder,
      cycleSeen: [...state.cycleSeen],
      sources
    }, null, 2), 'utf8');
  }

  return { state, load: () => loading ??= load(), save };
}
