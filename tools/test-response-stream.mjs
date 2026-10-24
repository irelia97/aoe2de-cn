import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { streamResponse } from '../server/services/response-stream.js';

function output() {
  const res = new PassThrough();
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.on('data', () => {});
  return res;
}

test('streamed downloads keep their filename without buffering the entire file', async () => {
  const res = output();
  await streamResponse(new Response('small download', { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="replay.zip"' } }), res, { limit: 1024 });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-disposition'], 'attachment; filename="replay.zip"');
});

test('oversized downloads are rejected before headers, and chunked bodies remain bounded', async () => {
  const known = output();
  await assert.rejects(streamResponse(new Response('x', { headers: { 'content-length': '2048' } }), known, { limit: 1024 }), { statusCode: 413 });
  assert.equal(known.status, undefined);
  const chunked = output();
  await assert.rejects(streamResponse(new Response(new Uint8Array(2048)), chunked, { limit: 1024 }), /大小限制/);
});
