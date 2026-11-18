function createRealtimePolling({ render, showLoading, showError, updateClocks, refreshSchedule }) {
  let session = null;
  let payload = null;
  let version = null;
  let etag = null;

  async function loadStates(signal) {
    try {
      const headers = etag ? { 'If-None-Match': etag } : {};
      const response = await fetch('/api/realtime', { cache: 'no-cache', headers, signal });
      if (response.status === 304) {
        if (!signal.aborted && payload) render(payload);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (signal.aborted) return;
      payload = data;
      version = data?.checkedAt || null;
      etag = response.headers.get('etag');
      render(payload);
    } catch (error) {
      if (!signal.aborted && error?.name !== 'AbortError') showError();
    }
  }

  async function poll(current) {
    const { signal } = current.controller;
    if (signal.aborted) return;
    void refreshSchedule();
    if (current.pending) return;
    current.pending = true;
    try {
      const response = await fetch('/api/realtime/version', { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (signal.aborted) return;
      if (!payload || data?.version !== version) await loadStates(signal);
      else updateClocks();
    } catch (error) {
      if (!signal.aborted && error?.name !== 'AbortError' && !payload) await loadStates(signal);
    } finally {
      current.pending = false;
    }
  }

  function stop() {
    if (!session) return;
    clearInterval(session.timer);
    session.controller.abort();
    session = null;
  }

  function start() {
    stop();
    if (payload) render(payload);
    else showLoading();
    const current = { controller: new AbortController(), pending: false, timer: null };
    session = current;
    void poll(current);
    current.timer = setInterval(() => void poll(current), 1500);
  }

  return { start, stop };
}
