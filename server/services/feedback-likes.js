import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

export function createFeedbackLikes(path) {
  let db, secret;
  function open() {
    if (db) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS likes(card TEXT NOT NULL,ip TEXT NOT NULL,created_at INTEGER NOT NULL,
        PRIMARY KEY(card,ip)) WITHOUT ROWID;`);
    db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('secret', randomBytes(32).toString('hex'));
    secret = db.prepare('SELECT value FROM metadata WHERE key=?').get('secret').value;
  }
  function identity(value) {
    let ip = String(value || '').replace(/^::ffff:/i, '');
    const version = isIP(ip);
    if (!version) throw Object.assign(new Error('无法确认访问地址，请稍后重试'), { statusCode: 400 });
    if (version === 6) ip = new URL(`http://[${ip}]/`).hostname;
    open();
    return createHmac('sha256', secret).update(ip).digest('hex');
  }
  function state(card, hash) {
    return { likes: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE card=?').get(card).n,
      liked: Boolean(db.prepare('SELECT 1 FROM likes WHERE card=? AND ip=?').get(card, hash)) };
  }
  return {
    decorate(items, ip) {
      const hash = identity(ip);
      return items.map(item => ({ ...item, ...state(item.id, hash) }));
    },
    like(card, ip) {
      if (!/^[a-f0-9]{64}$/.test(card || '')) throw Object.assign(new Error('反馈编号无效'), { statusCode: 400 });
      const hash = identity(ip);
      // The unique primary key enforces one vote even across concurrent requests.
      const inserted = db.prepare('INSERT OR IGNORE INTO likes VALUES(?,?,?)').run(card, hash, Date.now());
      return { ...state(card, hash), added: inserted.changes === 1 };
    },
    close() { db?.close(); db = null; },
  };
}
