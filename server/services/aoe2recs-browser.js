const origin = 'https://aoe2recs.com';
const socketUrl = 'wss://aoe2recs.com/dashboard/api/';

const captureSource = `(() => {
  if (window.__aoe2recsCaptureInstalled) return;
  window.__aoe2recsCaptureInstalled = true;
  window.__aoe2recsSockets = [];
  window.__aoe2recsProfileFrames = [];
  const NativeWebSocket = window.WebSocket;
  function CapturedWebSocket(url, protocols) {
    const socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    if (String(url) === ${JSON.stringify(socketUrl)}) {
      window.__aoe2recsSockets.push(socket);
      socket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          if (message?.cls === 13) window.__aoe2recsProfileFrames.push(message);
          else if (message?.cls === 3 && Array.isArray(message.data)) {
            for (const item of message.data) if (item?.cls === 13) window.__aoe2recsProfileFrames.push(item);
          }
        } catch {}
      });
    }
    return socket;
  }
  CapturedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(CapturedWebSocket, NativeWebSocket);
  window.WebSocket = CapturedWebSocket;
})();`;

export function createAoE2RecsBrowser({ connect, now = Date.now, timeoutMs = 45_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let connection = null, connecting = null, context = null, page = null, preparedPage = null, tail = Promise.resolve();
  const stats = { requests:0, successes:0, failures:0, verificationRequired:false, lastSuccessAt:null, socketReuseCount:0 };

  async function browser() {
    if (connection?.isConnected()) return connection;
    if (!connecting) connecting = Promise.resolve().then(connect).then(value => {
      connection = value;
      context = null;
      page = null;
      preparedPage = null;
      return value;
    }).finally(() => { connecting = null; });
    return connecting;
  }

  async function challengeVisible(target) {
    const title = await target.title().catch(() => '');
    return /just a moment|security verification|安全验证/i.test(title);
  }

  const verificationError = () => Object.assign(
    new Error('AoE2Recs 浏览器需要人工验证，继续使用已有缓存'),
    { code:'AOE2RECS_VERIFICATION_REQUIRED' }
  );

  async function ensurePage(profileId, deadline) {
    const connectedBrowser = await browser();
    if (!context) {
      // Re-adopt an already verified ephemeral context after the website
      // process restarts; never fall back to Chrome's blank default profile.
      context = (connectedBrowser.contexts?.() || []).find(candidate =>
        candidate.pages().some(item => item.url().startsWith(origin + '/'))
      ) || await connectedBrowser.newContext();
    }
    if (!page || page.isClosed?.()) {
      page = context.pages().find(item => item.url().startsWith(origin + '/'))
        || context.pages().find(item => item.url() === 'about:blank') || await context.newPage();
      preparedPage = null;
    }
    if (preparedPage !== page) {
      await page.addInitScript({ content:captureSource });
      const target = page.url().startsWith(origin + '/') ? page.url() : `${origin}/profile/${profileId}`;
      await page.goto(target, { waitUntil:'domcontentloaded', timeout:Math.max(1, deadline - now()) });
      preparedPage = page;
    }
    if (await challengeVisible(page)) {
      stats.verificationRequired = true;
      throw verificationError();
    }
    while (now() < deadline) {
      const state = await page.evaluate(url => {
        const sockets = window.__aoe2recsSockets || [];
        const socket = [...sockets].reverse().find(item => item.url === url);
        return socket ? socket.readyState : -1;
      }, socketUrl).catch(() => -1);
      if (state === 1) return page;
      if (await challengeVisible(page)) {
        stats.verificationRequired = true;
        throw verificationError();
      }
      await sleep(500);
    }
    throw new Error('AoE2Recs 网页 WebSocket 连接超时');
  }

  function responseMatches(message, profileId) {
    const data = message?.data;
    if (!data || typeof data !== 'object') return false;
    if (data.found === false) return true;
    const ids = [data.player?.id, ...(Array.isArray(data.accounts) ? data.accounts.map(account => account?.id) : [])]
      .filter(value => value !== undefined && value !== null).map(String);
    // The socket can emit an intermediate cls=13 frame whose player and
    // accounts are still empty. Wait for the completed frame for this ID.
    return ids.includes(String(profileId));
  }

  async function readOnce(profileId) {
    profileId = String(profileId);
    if (!/^[1-9]\d*$/.test(profileId)) throw new Error('无效的选手 ID');
    stats.requests++;
    const deadline = now() + timeoutMs;
    try {
      const target = await ensurePage(profileId, deadline);
      await sleep(300);
      const sent = await target.evaluate(({ url, id }) => {
        const sockets = window.__aoe2recsSockets || [];
        const socket = [...sockets].reverse().find(item => item.url === url && item.readyState === 1);
        if (!socket) return { ok:false, reason:'no_open_socket' };
        const baseline = (window.__aoe2recsProfileFrames || []).length;
        socket.send(JSON.stringify({ profile_id:Number(id) }));
        return { ok:true, baseline };
      }, { url:socketUrl, id:profileId });
      if (!sent?.ok) throw new Error('AoE2Recs WebSocket 已关闭，未发送资料请求');

      while (now() < deadline) {
        const result = await target.evaluate(({ url, baseline }) => {
          const frames = (window.__aoe2recsProfileFrames || []).slice(baseline);
          const sockets = window.__aoe2recsSockets || [];
          const socket = [...sockets].reverse().find(item => item.url === url);
          return { frames, state:socket ? socket.readyState : -1 };
        }, { url:socketUrl, baseline:sent.baseline });
        const matched = (result?.frames || []).find(message => responseMatches(message, profileId));
        if (matched) {
          if (!matched.data) throw Object.assign(new Error('AoE2Recs 网页返回空资料'), { code:'AOE2RECS_PROFILE_UNAVAILABLE' });
          stats.successes++;
          stats.verificationRequired = false;
          stats.lastSuccessAt = new Date(now()).toISOString();
          stats.socketReuseCount++;
          return matched.data;
        }
        if (result?.state !== 1) throw new Error('AoE2Recs WebSocket 已关闭或断开');
        await sleep(250);
      }
      throw new Error('AoE2Recs 网页资料加载超时');
    } catch (error) {
      stats.failures++;
      throw error;
    }
  }

  return {
    read(profileId) {
      const result = tail.then(() => readOnce(profileId));
      tail = result.catch(() => {});
      return result;
    },
    stats: () => ({ ...stats, connected:Boolean(connection?.isConnected()),
      pageUrl:page?.url?.() || '', socketPersistent:Boolean(page && preparedPage === page) })
  };
}
