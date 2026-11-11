import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = new URL('./sync-guess-former-teams.mjs', import.meta.url).pathname;
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], { stdio:'inherit' });
const dbArg = process.argv.find(value => value.startsWith('--chat-db='));
const dbPath = dbArg?.slice('--chat-db='.length);

child.on('exit', (code, signal) => {
  if (code === 0) process.exit(0);
  if (dbPath) {
    const db = new DatabaseSync(dbPath);
    const marker = `guess-former-teams-process-failure-20261110-${Date.now()}`;
    db.prepare("INSERT INTO messages(kind,author,content,url,ip_hash,created_at) VALUES('system','系统',?,'',?,?)")
      .run(`猜选手历史战队任务异常停止（${signal || `退出码 ${code}`}），需要重新检查。`, marker, Date.now());
    db.close();
  }
  process.exit(code || 1);
});
