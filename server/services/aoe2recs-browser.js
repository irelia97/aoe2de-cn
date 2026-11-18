import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const origin = 'https://aoe2recs.com';
const socketUrl = 'wss://aoe2recs.com/dashboard/api/';
const checkboxDetector = fileURLToPath(new URL('./aoe2recs-checkbox.py', import.meta.url));

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

export function createAoE2RecsBrowser({ connect, now = Date.now, timeoutMs = 45_000, verificationTimeoutMs = 180_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), maxRecoveryAttempts = 3,
  recoverVerification = null }) {
  let connection = null, connecting = null, context = null, page = null, preparedPage = null, tail = Promise.resolve();
  const stats = { requests:0, successes:0, failures:0, verificationRequired:false, lastSuccessAt:null, socketReuseCount:0,
    recoveryAttempts:0, recoverySuccesses:0, lastRecoveryAt:null };

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

  const recoverableConnectionError = error => error?.code === 'AOE2RECS_VERIFICATION_REQUIRED'
    || /WebSocket|资料加载超时/.test(String(error?.message || ''));

  async function clickVerification(target, deadline) {
    let clicks = 0;
    let readyForNextCheckbox = true;
    while (now() < deadline) {
      if (!(await challengeVisible(target))) return true;
      let checkbox = null;
      let checkboxPoint = null;
      for (const frame of target.frames()) {
        if (!frame.url().startsWith('https://challenges.cloudflare.com/')) continue;
        for (const candidate of [frame.getByRole('checkbox'), frame.locator('input[type="checkbox"]'), frame.getByText('Verify you are human')]) {
          if (await candidate.first().isVisible().catch(() => false)) {
            checkbox = candidate.first();
            break;
          }
        }
        if (!checkbox) {
          const element = await frame.frameElement().catch(() => null);
          const box = await element?.boundingBox().catch(() => null);
          if (box?.width >= 200 && box?.height >= 40) {
            const screenshot = await element.screenshot({ timeout: 3000 }).catch(() => null);
            if (screenshot) {
              const detected = spawnSync('python3', [checkboxDetector], { input:screenshot, encoding:'utf8', timeout:3000, maxBuffer:100 });
              if (detected.status === 0 && detected.stdout.trim() === '1') checkboxPoint = { x:box.x + 25, y:box.y + box.height / 2 };
            }
          }
        }
        if (checkbox || checkboxPoint) break;
      }
      if (!checkbox && !checkboxPoint) {
        readyForNextCheckbox = true;
      } else if (readyForNextCheckbox && clicks < 3) {
        if (checkbox) await checkbox.click();
        else await target.mouse.click(checkboxPoint.x, checkboxPoint.y);
        clicks++;
        readyForNextCheckbox = false;
        console.log(`[aoe2recs-browser] verification checkbox clicked ${clicks}/3`);
      }
      await sleep(500);
    }
    return !(await challengeVisible(target));
  }

  async function refreshAndVerify(profileId, attempt) {
    stats.recoveryAttempts++;
    stats.lastRecoveryAt = new Date(now()).toISOString();
    if (recoverVerification) {
      await recoverVerification({ profileId, attempt, page, context });
      preparedPage = null;
      return;
    }
    const connectedBrowser = await browser();
    if (!context) context = (connectedBrowser.contexts?.() || []).find(candidate =>
      candidate.pages().some(item => item.url().startsWith(origin + '/'))
    ) || await connectedBrowser.newContext();
    if (!page || page.isClosed?.()) page = context.pages().find(item => item.url().startsWith(origin + '/')) || await context.newPage();
    await page.goto(`${origin}/profile/${profileId}`, { waitUntil:'domcontentloaded', timeout:timeoutMs });
    if (await challengeVisible(page)) {
      const verified = await clickVerification(page, now() + verificationTimeoutMs);
      if (!verified) {
        stats.verificationRequired = true;
        throw verificationError();
      }
    }
    preparedPage = null;
  }

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

  async function readAttempt(profileId) {
    profileId = String(profileId);
    const deadline = now() + timeoutMs;
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
          return matched.data;
        }
        if (result?.state !== 1) throw new Error('AoE2Recs WebSocket 已关闭或断开');
        await sleep(250);
      }
    throw new Error('AoE2Recs 网页资料加载超时');
  }

  async function readOnce(profileId) {
    profileId = String(profileId);
    if (!/^[1-9]\d*$/.test(profileId)) throw new Error('无效的选手 ID');
    stats.requests++;
    try {
      const finish = (result, recovered = false) => {
        stats.successes++;
        stats.verificationRequired = false;
        stats.lastSuccessAt = new Date(now()).toISOString();
        stats.socketReuseCount++;
        if (recovered) stats.recoverySuccesses++;
        return result;
      };
      try {
        return finish(await readAttempt(profileId));
      } catch (initialError) {
        if (!recoverableConnectionError(initialError)) throw initialError;
        let lastError = initialError;
        const recoveryLimit = initialError?.code === 'AOE2RECS_VERIFICATION_REQUIRED' ? 1 : maxRecoveryAttempts;
        for (let attempt = 1; attempt <= recoveryLimit; attempt++) {
          console.warn(`[aoe2recs-browser] connection recovery ${attempt}/${recoveryLimit} for profile=${profileId}: ${lastError.message}`);
          try {
            await refreshAndVerify(profileId, attempt);
          } catch (recoveryError) {
            lastError = recoveryError;
            console.warn(`[aoe2recs-browser] verification recovery ${attempt}/${recoveryLimit} failed for profile=${profileId}: ${recoveryError.message}`);
            if (attempt === recoveryLimit) throw recoveryError;
            continue;
          }
          try {
            return finish(await readAttempt(profileId), true);
          } catch (retryError) {
            lastError = retryError;
            if (!recoverableConnectionError(retryError) || attempt === recoveryLimit) throw retryError;
          }
        }
        throw lastError;
      }
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
