import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync, gzipSync } from 'node:zlib';

const maxReplaySize = 128 * 1024 * 1024;

export function extractReplay(input) {
  const data = Buffer.from(input);
  if (data.readUInt32LE(0) !== 0x04034b50) return data;
  // Use the central directory: ZIP entries may store sizes in a trailing descriptor.
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, data.length - 65557)) throw new Error('录像压缩包不完整');
  let offset = data.readUInt32LE(end + 16);
  const count = data.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('录像压缩包目录无效');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!/\.(aoe2record|mgz)$/i.test(name)) continue;
    if (flags & 1 || size > maxReplaySize) throw new Error('录像压缩包超出支持范围');
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('录像压缩包文件无效');
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    if (start + compressedSize > data.length) throw new Error('录像压缩包文件不完整');
    const bytes = data.subarray(start, start + compressedSize);
    const replay = method === 0 ? bytes : method === 8 ? inflateRawSync(bytes, { maxOutputLength: maxReplaySize }) : null;
    if (!replay || replay.length !== size) throw new Error('录像压缩格式不受支持');
    return replay;
  }
  throw new Error('压缩包中没有录像文件');
}

function plain(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) return Array.from(value, plain);
  const output = {};
  for (const key of new Set([...Object.keys(value), ...Object.getOwnPropertyNames(Object.getPrototypeOf(value))])) {
    if (key.startsWith('__') || key === 'constructor' || key === 'free') continue;
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), key);
    if (descriptor?.get || Object.hasOwn(value, key)) {
      const item = value[key];
      if (typeof item !== 'function') output[key] = plain(item);
    }
  }
  return output;
}

export function compactReplay(full) {
  return { chapters: (full.chapters || []).map(chapter => {
    const operations = [];
    let elapsed = 0;
    for (const operation of chapter.operations || []) {
      if (operation.Sync) elapsed += Number(operation.Sync.time_increment) || 0;
      if (!operation.Action && !operation.Chat) continue;
      if (elapsed) operations.push({ Sync: { time_increment: elapsed } });
      elapsed = 0;
      operations.push(operation.Action ? { Action: operation.Action } : { Chat: operation.Chat });
    }
    return { operations };
  }) };
}

if (parentPort) {
  try {
    const glue = await import(pathToFileURL(join(workerData.assetsDir, 'aoe2rec_js_bg.js')).href);
    const wasm = await WebAssembly.instantiate(await readFile(join(workerData.assetsDir, 'aoe2rec_js_bg.wasm')), { './aoe2rec_js_bg.js': glue });
    glue.__wbg_set_wasm(wasm.instance.exports);
    wasm.instance.exports.__wbindgen_start();
    const bytes = extractReplay(workerData.bytes);
    if (bytes.length > maxReplaySize) throw new Error('录像文件过大');
    const summary = glue.parse_rec_summary(bytes);
    const summaryData = plain(summary);
    const outcomes = new Map((workerData.metadata.matchInfo?.results || []).map(player => [String(player.profileId), player.won]));
    for (const team of summaryData.teams) {
      const values = team.players.map(player => outcomes.get(String(player.profile_id)));
      team.winner = values.some(value => value === true) ? true : values.length && values.every(value => value === false) ? false : null;
    }
    const result = {
      ...workerData.metadata,
      summary: summaryData,
      full: compactReplay(glue.parse_rec(bytes)),
      file: { name: `AgeIIDE_Replay_${workerData.metadata.matchId}.aoe2record`, size: bytes.length },
    };
    summary.free?.();
    const compressed = gzipSync(JSON.stringify(result));
    parentPort.postMessage({ data: compressed });
  } catch (error) {
    parentPort.postMessage({ error: error.message || '录像解析失败' });
  }
}
