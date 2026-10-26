import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';

export function feedbackId(record) {
  return createHash('sha256').update(JSON.stringify([record.ip, record.sentAt, record.content])).digest('hex');
}

export function maskFeedbackIp(value) {
  const ip = String(value || '').replace(/^::ffff:/i, '');
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 2).join('.')}.*.*`;
  if (isIP(ip) === 6) return `${ip.split(':').filter(Boolean).slice(0, 2).join(':')}::*`;
  return '未知';
}

export async function recentFeedback(path) {
  const items = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (typeof record.content !== 'string' || !record.content.trim() || !Number.isFinite(Date.parse(record.sentAt))) continue;
        items.unshift({ id: feedbackId(record), ip: maskFeedbackIp(record.ip), content: record.content, sentAt: record.sentAt });
        items.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
        if (items.length > 15) items.length = 15;
      } catch { /* Skip interrupted or malformed log entries. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
  }
  return items;
}
