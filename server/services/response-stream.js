import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function streamResponse(response, res, { limit = 64 * 1024 * 1024, headers = {} } = {}) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Object.assign(new Error('下载文件超过64MB限制'), { statusCode: 413 });
  }
  let size = 0;
  const limiter = new Transform({ transform(chunk, _encoding, next) {
    size += chunk.length;
    next(size > limit ? Object.assign(new Error('下载文件超过大小限制'), { statusCode: 413 }) : null, chunk);
  } });
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/octet-stream',
    'cache-control': 'no-store',
    ...(response.headers.get('content-disposition') ? { 'content-disposition': response.headers.get('content-disposition') } : {}),
    ...(response.headers.get('retry-after') ? { 'retry-after': response.headers.get('retry-after') } : {}),
    ...headers
  });
  if (!response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body), limiter, res);
}
