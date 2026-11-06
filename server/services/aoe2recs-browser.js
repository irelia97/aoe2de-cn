const origin = 'https://aoe2recs.com';
export function createAoE2RecsBrowser({ connect, now = Date.now, timeoutMs = 20_000 }) {
  let connection = null, connecting = null, tail = Promise.resolve();
  const stats = { requests:0, successes:0, failures:0, verificationRequired:false, lastSuccessAt:null };
  async function browser() {
    if (connection?.isConnected()) return connection;
    if (!connecting) connecting = Promise.resolve().then(connect).then(value => {
      connection = value;
      return value;
    }).finally(() => { connecting = null; });
    return connecting;
  }
  async function readOnce(profileId) {
    if (!/^[1-9]\d*$/.test(String(profileId))) throw new Error('无效的选手 ID');
    stats.requests++;
    let page, leaveForHuman = false;
    const deadline = now() + timeoutMs;
    try {
      const context = (await browser()).contexts()[0];
      if (!context) throw new Error('服务器资料浏览器未就绪');
      page = context.pages().find(item => item.url().startsWith(origin + '/'))
        || context.pages().find(item => item.url() === 'about:blank') || await context.newPage();
      // Observe only the connection created by the upstream profile page itself.
      // Do not create an extra WebSocket or export cookies from the browser.
      let timer, onSocket;
      const sockets = [];
      const response = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('AoE2Recs 网页资料加载超时')), Math.max(1, deadline - now()));
        onSocket = socket => {
          if (socket.url() !== 'wss://aoe2recs.com/dashboard/api/') return;
          const onFrame = event => {
            let message;
            try { message = JSON.parse(String(event.payload)); } catch { return; }
            if (message.cls === 13) resolve(message.data);
          };
          socket.on('framereceived', onFrame);
          sockets.push([socket, onFrame]);
        };
        page.on('websocket', onSocket);
      });
      // Navigation can fail before we begin awaiting the page's data.
      response.catch(() => {});
      let result;
      try {
        await page.goto(`${origin}/profile/${profileId}`, { waitUntil:'domcontentloaded', timeout:Math.max(1, deadline - now()) });
        const title = await page.title();
        if (/just a moment|security verification/i.test(title)) {
          leaveForHuman = true;
          stats.verificationRequired = true;
          throw new Error('AoE2Recs 浏览器需要人工验证，继续使用已有缓存');
        }
        result = await response;
      } finally {
        clearTimeout(timer);
        page.off('websocket', onSocket);
        for (const [socket, onFrame] of sockets) socket.off('framereceived', onFrame);
      }
      if (!result) throw Object.assign(new Error('AoE2Recs 网页返回空资料'), { code:'AOE2RECS_PROFILE_UNAVAILABLE' });
      stats.successes++; stats.verificationRequired = false;
      stats.lastSuccessAt = new Date(now()).toISOString();
      return result;
    } catch (error) {
      stats.failures++;
      throw error;
    } finally {
      // Stop dashboard live/background traffic between profile requests and
      // throughout the user's explicit request pause. Keep challenges visible
      // only when a human needs to complete verification.
      if (page && !leaveForHuman) await page.goto('about:blank', { timeout:5000 }).catch(() => {});
    }
  }
  return {
    read(profileId) {
      const result = tail.then(() => readOnce(profileId));
      tail = result.catch(() => {});
      return result;
    },
    stats: () => ({ ...stats, connected:Boolean(connection?.isConnected()) })
  };
}
