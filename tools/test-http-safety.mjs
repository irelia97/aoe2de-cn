import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeHttpHandler, staticFilePath, withinDirectory } from '../server/services/http-safety.js';

test('malformed URLs and handler failures cannot terminate the HTTP server', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'http-safety-'));
  await writeFile(join(directory, 'index.html'), 'working');
  const server = http.createServer(safeHttpHandler(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/throw') throw new Error('private diagnostics');
    await staticFilePath(directory, pathname === '/' ? '/index.html' : pathname);
    res.end('working');
  }, { log: () => {} }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/%FF`)).status, 400);
    const failed = await fetch(`${base}/throw`); assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes('private diagnostics'));
    assert.equal((await fetch(`${base}/..%2fpublic-backup/file`)).status, 403);
    assert.equal(await (await fetch(base)).text(), 'working');
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test('sibling directories and symlinks cannot escape the static root', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'static-path-'));
  const root = join(directory, 'public'), other = join(directory, 'public-backup');
  await mkdir(root); await mkdir(other); await writeFile(join(other, 'secret.txt'), 'private');
  try {
    assert.equal(withinDirectory(root, other), false);
    await assert.rejects(staticFilePath(root, '/../public-backup/secret.txt'), { statusCode: 403 });
    await assert.rejects(staticFilePath(root, '/%00'), { statusCode: 400 });
    if (process.platform === 'win32') t.diagnostic('Symlink check runs on deployment Linux host');
    else {
      await symlink(other, join(root, 'link'));
      await assert.rejects(staticFilePath(root, '/link/secret.txt'), { statusCode: 403 });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
