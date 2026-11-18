import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('leaving aborts an in-flight poll and returning ignores its late response', async () => {
  const requests = [];
  const rendered = [];
  const source = readFileSync(new URL('../public/realtime-polling.js', import.meta.url), 'utf8');
  const create = vm.runInNewContext(`${source}\ncreateRealtimePolling`, {
    AbortController, setInterval, clearInterval,
    fetch: (url, { signal }) => new Promise(resolve => requests.push({ url, signal, resolve }))
  });
  const polling = create({ render: data => rendered.push(data), showLoading() {}, showError: assert.fail,
    updateClocks() {}, refreshSchedule() {} });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const respond = (index, data) => requests[index].resolve({ ok: true, json: async () => data, headers: new Headers() });
  try {
    polling.start();
    respond(0, { version: 'old' });
    await flush();
    assert.equal(requests[1].url, '/api/realtime');
    polling.stop();
    assert.equal(requests[1].signal.aborted, true);
    polling.start();
    respond(2, { version: 'new' });
    await flush();
    respond(3, { checkedAt: 'new' });
    respond(1, { checkedAt: 'old' });
    await flush();
    assert.deepEqual(rendered, [{ checkedAt: 'new' }]);
  } finally {
    polling.stop();
  }
});
