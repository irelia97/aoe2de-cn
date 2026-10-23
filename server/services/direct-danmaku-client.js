import { spawn } from 'node:child_process';

export function createDirectDanmakuClient({ pythonExecutable, scriptPath, room, statePath, spawnImpl = spawn }) {
  let queue = Promise.resolve();
  function run(mode, payload) {
    return new Promise((resolve, reject) => {
      const args = [scriptPath, '--mode', mode, '--room', String(room), '--state', statePath];
      const child = spawnImpl(pythonExecutable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', settled = false;
      const timer = setTimeout(() => { child.kill(); finish(new Error('斗鱼直连发送超时')); }, 180000);
      timer.unref?.();
      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        const receipts = events.filter(event => event?.res === '0');
        const safeOutput = receipts.map((event, index) => `DANMAKU_SENT ${JSON.stringify({ index })}`).join('\n');
        const refused = events.find(event => event?.res != null && event.res !== '0');
        if (refused) error = new Error(`斗鱼直连返回码 ${refused.res}`);
        if (error) {
          error.stdout = safeOutput;
          error.terminal = mode === 'send'; // Never resend after an uncertain send.
          reject(error);
        } else if (mode === 'format-start') {
          const messages = events.findLast(event => Array.isArray(event));
          if (!messages || messages.length !== 2 || messages.some(message => typeof message !== 'string' || !message || [...message].length > 60)) {
            reject(new Error('开局弹幕格式无效'));
          } else resolve(messages);
        } else if (receipts.length !== payload.messages.length) {
          reject(Object.assign(new Error('斗鱼直连回执不完整'), { terminal: true, stdout: safeOutput }));
        } else resolve({ stdout: safeOutput });
      }
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', () => {}); // Do not expose auth diagnostics or private storage.
      child.stdin.on('error', () => {});
      child.once('error', finish);
      child.once('close', code => finish(code === 0 ? null : new Error(`斗鱼直连进程退出 ${code}`)));
      child.stdin.end(JSON.stringify(payload) + '\n');
    });
  }
  return {
    noRetry: true,
    messageLimit: 60,
    start: async () => {},
    formatStart: (match, profileId) => run('format-start', { match, profileId }),
    send(messages) {
      const task = queue.then(() => run('send', { messages }));
      queue = task.catch(() => {});
      return task;
    }
  };
}
