import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';

export function withinDirectory(root, target) {
  const part = relative(resolve(root), resolve(target));
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export async function staticFilePath(root, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { throw Object.assign(new Error('无效的网址编码'), { statusCode: 400 }); }
  if (decoded.includes('\0')) throw Object.assign(new Error('无效的文件路径'), { statusCode: 400 });
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (!withinDirectory(root, target)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  // Check symlinks as well as lexical traversal. Missing files remain normal 404s.
  try {
    const actual = await realpath(target);
    if (!withinDirectory(await realpath(root), actual)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  return target;
}

export function safeHttpHandler(handler, { log = console.error } = {}) {
  return (req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch(error => {
      const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode
        : error instanceof URIError || error.code === 'ERR_INVALID_URL' ? 400 : 500;
      if (status === 500) log('[http] request failed:', error.message);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: status === 500 ? '服务器暂时无法处理请求' : status === 400 ? '请求格式不正确' : error.message }));
    }).finally(() => { res.releaseApiProtection?.(); });
  };
}
