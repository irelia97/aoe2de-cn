import { mkdir, writeFile } from 'node:fs/promises';
import { mediaTimestamp } from './media-video-state.js';
import { nextScheduledVideoRound, mediaVideoSourceKey, shuffledMediaVideoKeys } from './media-video-schedule.js';
import { liveNotificationChanges } from './live-notifications.js';

export function createMediaScheduler({
    mediaCache, mediaSources, mediaVideoState, mediaVideoPaused, mediaVideoPauseUntil,
    loadPersistentMediaVideos, loadPersistentMediaVideoState, savePersistentMediaVideoState,
    loadPersistentMediaLive, fetchMediaVideoSource, fetchMediaLive, isBilibiliRateLimit,
    mediaVideoRequestGapMin, mediaVideoRequestGapMax, mediaVideoCircuitMaxDelay, mediaVideoCircuitBaseDelay,
    mediaLiveRoundTimeout, mediaLiveFailedSourceGrace, mediaLiveRefreshInterval, withMediaTimeout,
    dataDir, mediaVideoCachePath, mediaLiveCachePath, realtimeChat
}) {
  let mediaVideosRefreshPromise = null;
  let mediaVideoSchedulerTimer = null;
  let mediaLiveRefreshPromise = null;

  function randomMediaDelay(min, max) {
    return Math.round(min + Math.random() * Math.max(0, max - min));
  }

  function ensureMediaVideoSourceStates() {
    const keys = (mediaSources.videos || []).map(mediaVideoSourceKey);
    mediaVideoState.cycleOrder = mediaVideoState.cycleOrder.filter(key => keys.includes(key));
    const missing = keys.filter(key => !mediaVideoState.cycleOrder.includes(key));
    mediaVideoState.cycleOrder.push(...shuffledMediaVideoKeys(missing));
    const now = Date.now();
    for (const source of Array.isArray(mediaSources.videos) ? mediaSources.videos : []) {
      const key = mediaVideoSourceKey(source);
      if (!mediaVideoState.sources.has(key)) {
        mediaVideoState.sources.set(key, { nextCheckAt: now, lastAttemptAt: 0, lastSuccessAt: 0, failureCount: 0, idleSuccesses: 0 });
      }
    }
  }

  function mediaVideoNextDueAt() {
    const sources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
    if (!sources.length) return 0;
    if (!mediaVideoState.cycleActive) return mediaVideoState.nextRequestAt || nextScheduledVideoRound(Date.now());
    const due = sources.filter(source => !mediaVideoState.cycleSeen.has(mediaVideoSourceKey(source))).map(source => {
      const state = mediaVideoState.sources.get(mediaVideoSourceKey(source));
      const sourceDue = state?.nextCheckAt || Date.now();
      return source.platform === 'bilibili' ? Math.max(sourceDue, mediaVideoState.blockedUntil) : sourceDue;
    });
    return Math.max(mediaVideoState.nextRequestAt, Math.min(...due));
  }

  function updateMediaVideoNextRefreshAt() {
    if (mediaVideoPaused()) {
      mediaCache.data.nextVideosRefreshAt = null;
      mediaCache.data.nextRefreshAt = mediaCache.data.nextLiveRefreshAt || null;
      return;
    }
    const nextAt = mediaVideoNextDueAt();
    mediaCache.data.nextVideosRefreshAt = nextAt ? new Date(nextAt).toISOString() : null;
    const liveNext = mediaTimestamp(mediaCache.data.nextLiveRefreshAt);
    const nextRefresh = [nextAt, liveNext].filter(Boolean);
    mediaCache.data.nextRefreshAt = nextRefresh.length ? new Date(Math.min(...nextRefresh)).toISOString() : null;
  }

  function scheduleMediaVideoRefresh() {
    if (mediaVideoSchedulerTimer) clearTimeout(mediaVideoSchedulerTimer);
    if (mediaVideoPaused()) {
      const resumeAt = mediaVideoPauseUntil();
      if (resumeAt > Date.now()) {
        mediaVideoSchedulerTimer = setTimeout(() => {
          mediaVideoSchedulerTimer = null;
          refreshMediaVideos()
            .catch(error => console.warn('[media] 视频刷新失败:', error.message))
            .finally(scheduleMediaVideoRefresh);
        }, Math.max(0, resumeAt - Date.now()));
      } else {
        mediaVideoSchedulerTimer = null;
      }
      updateMediaVideoNextRefreshAt();
      return;
    }
    const nextAt = mediaVideoNextDueAt();
    updateMediaVideoNextRefreshAt();
    if (!nextAt) return;
    mediaVideoSchedulerTimer = setTimeout(() => {
      mediaVideoSchedulerTimer = null;
      refreshMediaVideos()
        .catch(error => console.warn('[media] video refresh failed:', error.message))
        .finally(scheduleMediaVideoRefresh);
    }, Math.max(0, nextAt - Date.now()));
  }


  function refreshMediaVideos() {
    if (mediaVideoPaused()) {
      updateMediaVideoNextRefreshAt();
      return Promise.resolve(mediaCache.data);
    }
    if (mediaVideosRefreshPromise) return mediaVideosRefreshPromise;
    mediaVideosRefreshPromise = (async () => {
      await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState()]);
      ensureMediaVideoSourceStates();
      const now = Date.now();
      if (now < mediaVideoState.nextRequestAt) {
        updateMediaVideoNextRefreshAt();
        return mediaCache.data;
      }

      const videoSources = Array.isArray(mediaSources.videos) ? mediaSources.videos : [];
      if (!mediaVideoState.cycleActive) {
        mediaVideoState.cycleActive = true;
        mediaVideoState.cycleSeen.clear();
        mediaVideoState.cycleOrder = shuffledMediaVideoKeys(videoSources.map(mediaVideoSourceKey));
        for (const state of mediaVideoState.sources.values()) state.nextCheckAt = now;
        await savePersistentMediaVideoState();
      }
      const candidates = videoSources
        .map(source => ({ source, state: mediaVideoState.sources.get(mediaVideoSourceKey(source)) }))
        .filter(({ source, state }) => state && !mediaVideoState.cycleSeen.has(mediaVideoSourceKey(source)) && state.nextCheckAt <= now && (source.platform !== 'bilibili' || now >= mediaVideoState.blockedUntil))
        .sort((a, b) => {
          return mediaVideoState.cycleOrder.indexOf(mediaVideoSourceKey(a.source)) - mediaVideoState.cycleOrder.indexOf(mediaVideoSourceKey(b.source));
        });
      const candidate = candidates[0];
      if (!candidate) {
        updateMediaVideoNextRefreshAt();
        return mediaCache.data;
      }

      const { source, state } = candidate;
      const key = mediaVideoSourceKey(source);
      state.lastAttemptAt = now;
      mediaVideoState.nextRequestAt = now + randomMediaDelay(mediaVideoRequestGapMin, mediaVideoRequestGapMax);
      try {
        const videos = await fetchMediaVideoSource(source);
        const cachedIds = new Set(mediaCache.data.videos.map(item => String(item?.id || '')).filter(Boolean));
        const hasNewVideo = videos.some(item => item?.id && !cachedIds.has(String(item.id)));
        mediaVideoState.cycleSeen.add(key);
        state.lastSuccessAt = Date.now();
        state.failureCount = 0;
        state.idleSuccesses = hasNewVideo ? 0 : Math.min(4, state.idleSuccesses + 1);
        state.nextCheckAt = Date.now();
        if (source.platform === 'bilibili' && mediaVideoState.rateLimitStrikes > 0) mediaVideoState.rateLimitStrikes -= 1;

        if (videos.length) {
          const mergedById = new Map();
          for (const item of mediaCache.data.videos) if (item?.id) mergedById.set(String(item.id), item);
          for (const item of videos) if (item?.id) mergedById.set(String(item.id), item);
          mediaCache.data.videos = [...mergedById.values()]
            .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
            .slice(0, 50);
          await mkdir(dataDir, { recursive: true });
          await writeFile(mediaVideoCachePath, JSON.stringify({ savedAt: new Date(state.lastSuccessAt).toISOString(), videos: mediaCache.data.videos }, null, 2), 'utf8');
        }
        mediaCache.videosSavedAt = state.lastSuccessAt;
        mediaCache.data.videosUpdatedAt = new Date(state.lastSuccessAt).toISOString();
        mediaCache.data.updatedAt = mediaCache.data.videosUpdatedAt;
        console.log(`[media] video source checked: ${source.name || key}; next check ${new Date(state.nextCheckAt).toISOString()}`);
      } catch (error) {
        state.failureCount += 1;
        if (source.platform === 'bilibili' && isBilibiliRateLimit(error)) {
          mediaVideoState.rateLimitStrikes += 1;
          const baseBackoff = Math.min(mediaVideoCircuitMaxDelay, mediaVideoCircuitBaseDelay * (2 ** (mediaVideoState.rateLimitStrikes - 1)));
          const backoff = Math.min(mediaVideoCircuitMaxDelay, randomMediaDelay(baseBackoff * 0.85, baseBackoff * 1.15));
          mediaVideoState.blockedUntil = Date.now() + Math.max(backoff, Number(error.retryAfterMs) || 0);
          state.nextCheckAt = mediaVideoState.blockedUntil;
          console.warn(`[media] B站触发风控，暂停视频检测至 ${new Date(mediaVideoState.blockedUntil).toISOString()}: ${source.name || key}；原因：${error.message}`);
        } else {
          state.nextCheckAt = Date.now() + 10 * 60_000;
          console.warn(`[media] video source failed: ${source.name || key}`, error.message);
        }
      }
      const cycleComplete = videoSources.length > 0 && videoSources.every(videoSource => mediaVideoState.cycleSeen.has(mediaVideoSourceKey(videoSource)));
      if (cycleComplete) {
        const cycleNextAt = nextScheduledVideoRound(Date.now() + 1);
        mediaVideoState.cycleActive = false;
        for (const videoSource of videoSources) {
          const videoState = mediaVideoState.sources.get(mediaVideoSourceKey(videoSource));
          if (videoState) videoState.nextCheckAt = cycleNextAt;
        }
        mediaVideoState.cycleSeen.clear();
        mediaVideoState.nextRequestAt = cycleNextAt;
        console.log(`[media] video cycle complete; next cycle ${new Date(cycleNextAt).toISOString()}`);
      } else {
        mediaVideoState.nextRequestAt = Date.now() + randomMediaDelay(mediaVideoRequestGapMin, mediaVideoRequestGapMax);
      }
      updateMediaVideoNextRefreshAt();
      await savePersistentMediaVideoState();
      return mediaCache.data;
    })().finally(() => { mediaVideosRefreshPromise = null; });
    return mediaVideosRefreshPromise;
  }

  function refreshMediaLive() {
    if (mediaLiveRefreshPromise) return mediaLiveRefreshPromise;
    const refreshStartedAt = Date.now();
    const refreshWork = loadPersistentMediaLive().then(() => fetchMediaLive()).then(async live => {
      if (Date.now() - refreshStartedAt >= mediaLiveRoundTimeout) {
        throw new Error('直播刷新结果已超过整轮时限，丢弃过期结果');
      }
      const failedSourceKeys = live.failedSourceKeys || new Set();
      const merged = [...live];
      const mergedKeys = new Set(merged.map(item => `${item.platform || ''}|${item.url || ''}`));
      const mergeNow = Date.now();
      for (const previous of Array.isArray(mediaCache.data.live) ? mediaCache.data.live : []) {
        const key = `${previous.platform || ''}|${previous.url || ''}`;
        const checkedAt = Date.parse(previous.checkedAt || '');
        const withinFailureGrace = Number.isFinite(checkedAt) && mergeNow - checkedAt <= mediaLiveFailedSourceGrace;
        if (failedSourceKeys.has(key) && !mergedKeys.has(key) && withinFailureGrace) {
          merged.push(previous);
          mergedKeys.add(key);
        }
      }
      merged.sort((a, b) => {
        if (a.isCN && b.isCN) return Number(a.sourceOrder ?? Number.MAX_SAFE_INTEGER) - Number(b.sourceOrder ?? Number.MAX_SAFE_INTEGER);
        if (!a.isCN && !b.isCN) return Number(b.viewers || 0) - Number(a.viewers || 0);
        return a.isCN ? -1 : 1;
      });
      const previousLive = Array.isArray(mediaCache.data.live) ? mediaCache.data.live : [];
      const notices = liveNotificationChanges(previousLive, merged, failedSourceKeys);
      const now = Date.now();
      mediaCache.data.live = merged;
      for (const item of notices.started) {
        try { realtimeChat.announceLive(item); } catch (error) { console.warn('[realtime-chat] live notice failed:', error.message); }
      }
      for (const item of notices.ended) {
        try { realtimeChat.announceLiveEnd(item); } catch (error) { console.warn('[realtime-chat] live end notice failed:', error.message); }
      }
      mediaCache.data.liveUpdatedAt = new Date(now).toISOString();
      mediaCache.data.nextLiveRefreshAt = new Date(now + mediaLiveRefreshInterval).toISOString();
      mediaCache.data.updatedAt = new Date(now).toISOString();
      mediaCache.data.nextRefreshAt = new Date(Math.min(
        Date.parse(mediaCache.data.nextVideosRefreshAt || mediaCache.data.nextLiveRefreshAt),
        Date.parse(mediaCache.data.nextLiveRefreshAt)
      )).toISOString();
      mediaCache.liveSavedAt = now;
      await writeFile(mediaLiveCachePath, JSON.stringify({ savedAt: new Date(now).toISOString(), live: merged }, null, 2), 'utf8');
      console.log(`[media] live refresh complete: ${merged.length} live streams; next refresh ${mediaCache.data.nextLiveRefreshAt}`);
      return mediaCache.data;
    });
    mediaLiveRefreshPromise = withMediaTimeout(refreshWork, mediaLiveRoundTimeout, '直播刷新整轮任务')
      .finally(() => { mediaLiveRefreshPromise = null; });
    return mediaLiveRefreshPromise;
  }

  async function startMediaVideoScheduler() {
    await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState()]);
    ensureMediaVideoSourceStates();
    if (process.env.MEDIA_VIDEO_RESET === '1') {
      const resetAt = Date.now();
      mediaVideoState.nextRequestAt = nextScheduledVideoRound(resetAt);
      mediaVideoState.cycleActive = false;
      mediaVideoState.blockedUntil = 0;
      mediaVideoState.rateLimitStrikes = 0;
      mediaVideoState.cycleOrder = shuffledMediaVideoKeys((mediaSources.videos || []).map(mediaVideoSourceKey));
      mediaVideoState.cycleSeen.clear();
      for (const source of Array.isArray(mediaSources.videos) ? mediaSources.videos : []) {
        const state = mediaVideoState.sources.get(mediaVideoSourceKey(source));
        if (state) {
          state.nextCheckAt = resetAt;
          state.lastAttemptAt = 0;
          state.lastSuccessAt = 0;
          state.failureCount = 0;
          state.idleSuccesses = 0;
        }
      }
      await savePersistentMediaVideoState();
      console.log('[media] video scheduler reset; starting from the first configured source');
    }
    await refreshMediaVideos();
    await savePersistentMediaVideoState();
    scheduleMediaVideoRefresh();
    return mediaCache.data;
  }

  function refreshMediaCache() {
    return Promise.all([startMediaVideoScheduler(), refreshMediaLive()]).then(() => mediaCache.data);
  }

  async function getMediaCache() {
    await Promise.all([loadPersistentMediaVideos(), loadPersistentMediaVideoState(), loadPersistentMediaLive()]);
    ensureMediaVideoSourceStates();
    if (!mediaVideoSchedulerTimer && !mediaVideosRefreshPromise) scheduleMediaVideoRefresh();
    const now = Date.now();
    const liveStale = !mediaCache.liveSavedAt || now - mediaCache.liveSavedAt >= mediaLiveRefreshInterval;
    if (!mediaCache.data.videos.length && mediaVideoNextDueAt() <= now) {
      await refreshMediaVideos();
      scheduleMediaVideoRefresh();
    }
    if (liveStale) {
      const refresh = refreshMediaLive();
      refresh.catch(error => console.warn('[media] 后台直播刷新失败:', error.message));
    }
    return mediaCache.data;
  }

  return { refreshMediaLive, refreshMediaCache, getMediaCache };
}
