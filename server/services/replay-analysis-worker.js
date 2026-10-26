import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync, gzipSync } from 'node:zlib';
import { extractReplayMap } from '../../public/replay-map.js';
import { readLobbyMapSeed } from '../../public/replay-map-seed.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function initialObjects(bytes, summary) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const python = process.platform === 'win32' ? join(root, '.venv-replay', 'Scripts', 'python.exe') : join(root, '.venv-replay', 'bin', 'python');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [join(root, 'tools', 'replay-initial-objects.py'), '--players', String(summary.header.replay.num_players), '--save-version', String(summary.header.version_major + summary.header.version_minor / 65536)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', error = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('初始物体解析超时')); }, 20000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 8 * 1024 * 1024) child.kill(); });
    child.stderr.on('data', chunk => { if (error.length < 4000) error += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try { if (code !== 0) throw new Error(error || '初始物体解析失败'); resolve(JSON.parse(output)); }
      catch (e) { reject(e); }
    });
    child.stdin.end(bytes);
  });
}

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
  return { mapData: extractReplayMap(full), chapters: (full.chapters || []).map(chapter => {
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
    summaryData.mapSeed = null;
    try {
      const headerSize = bytes.readUInt32LE(0);
      if (headerSize > 8 && headerSize <= bytes.length) summaryData.mapSeed = readLobbyMapSeed(
        inflateRawSync(bytes.subarray(8,headerSize), { maxOutputLength: 64 * 1024 * 1024 }), summaryData);
    } catch { console.warn('[replay] lobby map seed unavailable'); }
    const outcomes = new Map((workerData.metadata.matchInfo?.results || []).map(player => [String(player.profileId), player.won]));
    for (const team of summaryData.teams) {
      const values = team.players.map(player => outcomes.get(String(player.profile_id)));
      team.winner = values.some(value => value === true) ? true : values.length && values.every(value => value === false) ? false : null;
    }
    const fullData = compactReplay(glue.parse_rec(bytes));
    if (fullData.mapData) {
      try { fullData.mapData.initialObjects = await initialObjects(bytes, summaryData); }
      catch (error) {
        fullData.mapData.initialObjects = [];
        fullData.mapData.initialObjectsUnavailable = true;
        console.warn('[replay] initial objects unavailable:', error.message);
      }
    }
    const result = {
      ...workerData.metadata,
      summary: summaryData,
      full: fullData,
      file: { name: `AgeIIDE_Replay_${workerData.metadata.matchId}.aoe2record`, size: bytes.length },
    };
    summary.free?.();
    const compressed = gzipSync(JSON.stringify(result));
    parentPort.postMessage({ data: compressed });
  } catch (error) {
    parentPort.postMessage({ error: error.message || '录像解析失败' });
  }
}
