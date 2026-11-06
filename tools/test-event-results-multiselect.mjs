import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Local fixtures only: no production data or upstream requests.
const categories = ['s', 'a', 'b', 'c', 'show', 'qualifier'];
let failC = false, waitB = false;
const requests = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/event-results.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(await readFile(new URL('../public/event-results.js', import.meta.url)));
  }
  if (url.pathname === '/api/tournament-results') {
    const category = url.searchParams.get('category');
    requests.set(category, (requests.get(category) || 0) + 1);
    res.setHeader('content-type', 'application/json');
    if (category === 'c' && failC) {
      res.statusCode = 503; return res.end(JSON.stringify({ error: 'fixture unavailable' }));
    }
    if (category === 'b' && waitB) {
      waitB = false; res.statusCode = 202;
      return res.end(JSON.stringify({ retryAfterSeconds: 10 }));
    }
    if (category === 'a') await new Promise(resolve => setTimeout(resolve, 120));
    return res.end(JSON.stringify({ fetchedAt: '2026-11-05T00:00:00Z', sourceUrl: `https://liquipedia.net/ageofempires/${category}`, rows: [{
      name: `Fixture-${category}`, year: '2026', dates: 'Nov 5, 2026', location: 'China',
      winner: 'Winner', qualified: 'Qualified', winnerEntries: [{ name: 'Winner' }],
      qualifiedEntries: [{ name: 'Qualified' }], runnerUpEntries: [{ name: 'Runner' }], score: '3–1'
    }] }));
  }
  res.setHeader('content-type', 'text/html');
  res.end('<section id="root"></section><script type="module">import {mountEventResults} from "/event-results.js";mountEventResults(document.querySelector("#root"));</script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const rows = page.locator('.event-results-table tbody tr');
  const click = id => page.locator(`[data-results-category="${id}"]`).click();
  const count = n => page.waitForFunction(n => document.querySelectorAll('.event-results-table tbody tr').length === n, n);
  await page.goto(`${origin}/events/results`);
  await count(1);
  await click('a'); await click('b'); await count(3);
  assert.equal(new URL(page.url()).searchParams.get('category'), 's,a,b');
  for (const id of ['s', 'a', 'b']) assert.equal(await page.locator(`[data-results-category="${id}"]`).getAttribute('aria-pressed'), 'true');
  await page.locator('#eventResultsSearch').fill('Fixture-a'); await count(1);
  await page.locator('#eventResultsSearch').fill(''); await count(3);
  await click('s'); await count(2);
  assert.equal(await rows.filter({ hasText: 'Fixture-s' }).count(), 0);
  await click('all'); await count(6);
  assert.equal(await rows.filter({ hasText: 'Fixture-qualifier' }).locator('td').count(), 8);
  assert.match(await rows.filter({ hasText: 'Fixture-qualifier' }).innerText(), /Qualified/);
  for (const id of categories) assert.equal(requests.get(id), 1, `${id} should reuse its loaded snapshot`);
  await page.reload(); await count(6);
  assert.equal(await page.locator('[data-results-category="all"]').getAttribute('aria-pressed'), 'true');

  await page.goto(`${origin}/events/results?category=qualifier`); await count(1);
  assert.equal(await rows.first().locator('td').count(), 6);
  await click('qualifier'); await count(0);
  assert.match(await page.locator('#eventResultsYears').innerText(), /请选择/);
  await page.reload(); await page.waitForSelector('[data-results-category="all"]'); await count(0);
  assert.equal(await page.locator('[data-results-category="s"]').getAttribute('aria-pressed'), 'false');

  failC = true;
  await page.goto(`${origin}/events/results?category=s,c`); await count(1);
  await page.waitForFunction(() => document.querySelector('#eventResultsStatus').textContent.includes('fixture unavailable'));
  assert.match(await rows.first().innerText(), /Fixture-s/);

  waitB = true;
  await page.clock.install();
  await page.goto(`${origin}/events/results?category=s,b`); await count(1);
  await page.waitForFunction(() => document.querySelector('#eventResultsStatus').textContent.includes('正在同步新数据'));
  await page.clock.fastForward(10_100); await count(2);
  console.log('event results multiselect: combined filters, search, URL reload, empty selection, mixed qualifiers, partial failure and retry passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
