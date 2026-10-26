import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

const MAX_NAME = 20;
const MAX_MESSAGE = 127;
const RECENT_LIMIT = 150;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RENAME_INTERVAL_MS = 15 * 24 * 60 * 60 * 1000;
const forbidden = [
  /(?:杀了你|弄死你|砍死你|炸死你|去死吧|人肉搜索|开盒|泄露地址)/i,
  /(?:买卖毒品|出售毒品|制作炸弹|教你制毒|枪支交易|贩卖人口)/i,
  /(?:儿童色情|未成年色情|幼女色情|性侵儿童|强奸未成年)/i,
  /(?:诈骗教程|刷单返利|代刷流水|洗钱渠道|出售银行卡)/i,
  /(?:支那猪|黑鬼|种族灭绝|屠杀(?:所有|全部).{0,8}(?:人|族))/i,
  /(?:操你妈|草你妈|傻逼|煞笔|废物东西|狗杂种)/i
];
const contact = /(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+(?:com|cn|net|org|io|tv|gg|cc|xyz)\b|\b1[3-9]\d{9}\b|(?:微信|vx|v信|qq|q群|加群|私聊|私信|电报|telegram|tg群)\s*[:：号]?\s*[a-z0-9_-]{3,})/i;
const control = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g;

function clean(value) {
  return String(value ?? '').normalize('NFKC').replace(control, ' ').replace(/\s+/g, ' ').trim();
}

function moderate(value, max, label) {
  if (typeof value !== 'string') throw Object.assign(new Error(`${label}格式不正确`), { statusCode: 400 });
  const text = clean(value);
  if (!text || [...text].length > max) throw Object.assign(new Error(`${label}须为 1～${max} 个字`), { statusCode: 400 });
  const compact = text.replace(/[\s\p{P}\p{S}_]/gu, '').toLowerCase();
  if (/<\s*\/?\s*(?:script|iframe|img|svg|style|a)\b/i.test(text) || contact.test(text) || contact.test(compact) || forbidden.some(pattern => pattern.test(compact))) {
    throw Object.assign(new Error(`${label}包含不允许发布的内容`), { statusCode: 422 });
  }
  if (/(.)\1{7,}/u.test(text)) throw Object.assign(new Error('请勿重复刷屏'), { statusCode: 422 });
  if (label === '昵称' && /^(?:系统|管理员|站长|官方|客服)$/i.test(text)) throw Object.assign(new Error('该昵称不可使用'), { statusCode: 422 });
  return text;
}

export function createRealtimeChat({ path, now = Date.now } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, author TEXT NOT NULL, content TEXT NOT NULL, url TEXT NOT NULL DEFAULT \'\', ip_hash TEXT NOT NULL DEFAULT \'\', created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at); CREATE INDEX IF NOT EXISTS messages_ip_time ON messages(ip_hash, created_at); CREATE TABLE IF NOT EXISTS chat_users (uid INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL, renamed_at INTEGER NOT NULL DEFAULT 0);');
  db.exec("INSERT OR IGNORE INTO chat_users(ip_hash, nickname, renamed_at) SELECT m.ip_hash, m.author, m.created_at FROM messages m WHERE m.kind = 'user' AND m.ip_hash <> '' AND m.id = (SELECT MAX(id) FROM messages WHERE kind = 'user' AND ip_hash = m.ip_hash) ORDER BY m.id");
  const listQuery = db.prepare("SELECT m.id, m.kind, CASE WHEN m.kind = 'user' THEN COALESCE(u.nickname, m.author) ELSE m.author END AS author, u.uid, m.content, m.url, m.created_at AS createdAt FROM messages m LEFT JOIN chat_users u ON u.ip_hash = m.ip_hash AND m.kind = 'user' WHERE m.created_at >= ? ORDER BY m.id DESC LIMIT ?");
  const getUser = db.prepare('SELECT uid, nickname, renamed_at AS renamedAt FROM chat_users WHERE ip_hash = ?');
  const insertUser = db.prepare("INSERT INTO chat_users(ip_hash, nickname, renamed_at) VALUES (?, '', 0)");
  const setDefaultName = db.prepare('UPDATE chat_users SET nickname = ? WHERE uid = ?');
  const updateName = db.prepare('UPDATE chat_users SET nickname = ?, renamed_at = ? WHERE uid = ?');
  const lastIp = db.prepare("SELECT content, created_at AS createdAt FROM messages WHERE kind = 'user' AND ip_hash = ? ORDER BY id DESC LIMIT 1");
  const countIp = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE kind = 'user' AND ip_hash = ? AND created_at >= ?");
  const countGlobal = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE kind = 'user' AND created_at >= ?");
  const lastNotice = db.prepare("SELECT created_at AS createdAt FROM messages WHERE kind = 'system' AND url = ? ORDER BY id DESC LIMIT 1");
  const lastSystemKey = db.prepare("SELECT created_at AS createdAt FROM messages WHERE kind = 'system' AND ip_hash = ? ORDER BY id DESC LIMIT 1");
  const insert = db.prepare('INSERT INTO messages(kind, author, content, url, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const prune = db.prepare('DELETE FROM messages WHERE created_at < ?');
  let lastPrune = 0;
  const publicRow = row => ({ id: row.id, kind: row.kind, author: row.author, uid: row.uid ?? null, content: row.content, url: row.url, createdAt: row.createdAt });
  const hashIp = ip => createHash('sha256').update(String(ip || 'unknown')).digest('hex');
  function identity(ipHash) {
    let user = getUser.get(ipHash);
    if (!user) {
      const uid = Number(insertUser.run(ipHash).lastInsertRowid);
      setDefaultName.run(`游客${uid}`, uid);
      user = getUser.get(ipHash);
    }
    return user;
  }
  function publicIdentity(user) {
    return { uid: user.uid, nickname: user.nickname, canRenameAt: user.renamedAt ? user.renamedAt + RENAME_INTERVAL_MS : 0 };
  }
  function setName(user, name, timestamp) {
    const nickname = moderate(name, MAX_NAME, '昵称');
    if (nickname !== user.nickname) {
      const next = user.renamedAt + RENAME_INTERVAL_MS;
      if (user.renamedAt && timestamp < next) throw Object.assign(new Error(`昵称须在 ${new Date(next).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 后修改`), { statusCode: 429 });
      updateName.run(nickname, timestamp, user.uid);
      user.nickname = nickname;
      user.renamedAt = timestamp;
    }
    return user;
  }
  function cleanup(timestamp) {
    if (timestamp - lastPrune < 60 * 60 * 1000) return;
    prune.run(timestamp - RETENTION_MS);
    lastPrune = timestamp;
  }
  function announceSystem({ content, url = '', key, repeatMs = 30 * 24 * 60 * 60_000 }) {
    const timestamp = now();
    cleanup(timestamp);
    const message = clean(content).slice(0, 1000);
    const systemKey = clean(key || content).slice(0, 240);
    if (!message || !systemKey) return null;
    const previous = lastSystemKey.get(systemKey);
    if (previous && timestamp - previous.createdAt < repeatMs) return null;
    const result = insert.run('system', '系统', message, String(url || ''), systemKey, timestamp);
    return { id: Number(result.lastInsertRowid), kind: 'system', author: '系统', uid: null, content: message, url: String(url || ''), createdAt: timestamp };
  }
  return {
    viewer(ip) { return publicIdentity(identity(hashIp(ip))); },
    list() {
      const timestamp = now();
      cleanup(timestamp);
      return listQuery.all(timestamp - RETENTION_MS, RECENT_LIMIT).reverse().map(publicRow);
    },
    post({ name, message, ip }) {
      const content = moderate(message, MAX_MESSAGE, '发言');
      const timestamp = now();
      cleanup(timestamp);
      const ipHash = hashIp(ip);
      const user = identity(ipHash);
      const author = moderate(name, MAX_NAME, '昵称');
      if (author !== user.nickname && user.renamedAt && timestamp < user.renamedAt + RENAME_INTERVAL_MS) {
        throw Object.assign(new Error(`昵称须在 ${new Date(user.renamedAt + RENAME_INTERVAL_MS).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 后修改`), { statusCode: 429 });
      }
      const previous = lastIp.get(ipHash);
      if (previous && timestamp - previous.createdAt < 10_000) throw Object.assign(new Error('发送太快，请 10 秒后再试'), { statusCode: 429 });
      if (previous?.content === content && timestamp - previous.createdAt < 10 * 60_000) throw Object.assign(new Error('请勿重复发送相同内容'), { statusCode: 429 });
      if (countIp.get(ipHash, timestamp - 60_000).count >= 5 || countIp.get(ipHash, timestamp - 24 * 60 * 60_000).count >= 100 || countGlobal.get(timestamp - 60_000).count >= 60) {
        throw Object.assign(new Error('发言过于频繁，请稍后再试'), { statusCode: 429 });
      }
      setName(user, author, timestamp);
      const result = insert.run('user', user.nickname, content, '', ipHash, timestamp);
      return { id: Number(result.lastInsertRowid), kind: 'user', author: user.nickname, uid: user.uid, content, url: '', createdAt: timestamp };
    },
    rename({ name, ip }) { return publicIdentity(setName(identity(hashIp(ip)), name, now())); },
    announceLive(live) {
      const timestamp = now();
      cleanup(timestamp);
      const author = clean(live?.name || '选手').slice(0, 40) || '选手';
      const title = clean(live?.title || '').slice(0, 100);
      const url = String(live?.url || '');
      if (!/^https:\/\//i.test(url)) return null;
      const previous = lastNotice.get(url);
      if (previous && timestamp - previous.createdAt < 10 * 60_000) return null;
      const content = `${author} 开始直播${title ? `：${title}` : ''}`;
      const result = insert.run('system', '系统', content, url, '', timestamp);
      return { id: Number(result.lastInsertRowid), kind: 'system', author: '系统', uid: null, content, url, createdAt: timestamp };
    },
    announceLiveEnd(live) {
      const author = clean(live?.name || '选手').slice(0, 40) || '选手';
      const url = String(live?.url || '');
      return announceSystem({ content: `${author} 已结束直播`, key: `live-end:${url}`, repeatMs: 10 * 60_000 });
    },
    announceMatch({ phase, match, tier }) {
      const opponents = Array.isArray(match?.opponents) ? match.opponents.map(item=>clean(item?.name || '待定')).slice(0, 2) : [];
      if (opponents.length < 2) return null;
      const tournament = clean(match?.tournament?.name || '赛事');
      const url = String(match?.tournament?.url || '');
      const prefix = tier ? `${tier}级赛事` : '赛事';
      const score = Array.isArray(match?.score) ? match.score.slice(0, 2).map(value=>clean(value || '0')) : ['0','0'];
      const content = phase === 'end'
        ? `${prefix}结束：${tournament}｜${opponents[0]} ${score[0]}–${score[1]} ${opponents[1]}`
        : `${prefix}开始：${tournament}｜${opponents[0]} vs ${opponents[1]}`;
      return announceSystem({ content, url, key: `match-${phase}:${match?.id}`, repeatMs: 45 * 24 * 60 * 60_000 });
    },
    announceSchedule({ day, matches }) {
      const rows = (Array.isArray(matches) ? matches : []).map(match => {
        const time = new Date(match.timestamp * 1000).toLocaleTimeString('zh-CN', { timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hour12:false });
        const opponents = match.opponents.map(item=>clean(item?.name || '待定')).slice(0,2);
        return `${time} ${match.tier}级 ${opponents[0]} vs ${opponents[1]}`;
      });
      const content = rows.length ? `未来12小时比赛预告：${rows.join('；')}` : '未来12小时暂无 S级、A级或B级比赛';
      return announceSystem({ content, key:`match-preview:${day}`, repeatMs:36 * 60 * 60_000 });
    },
    close() { db.close(); }
  };
}
