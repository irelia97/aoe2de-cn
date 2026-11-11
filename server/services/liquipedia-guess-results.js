import { readFile, rename, writeFile } from 'node:fs/promises';

const plain = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();

export function readGuessResults(html) {
  const rows = [];
  let observedRows = 0;
  for (const [row] of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    if (cells.length < 6) continue;
    const date = plain(cells[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    observedRows++;
    if (!/\btitle="Age of Empires II(?:[: ][^"]*)?"/i.test(cells[3])) continue;
    const tier = plain(cells[2]);
    const place = plain(cells[1]);
    const event = plain(cells[5]);
    const link = /href="(\/ageofempires\/[^"]+)"/.exec(cells[5])?.[1];
    if (tier && place && event && link) rows.push({ date, tier, place, event, url: 'https://liquipedia.net' + link.replace(/&amp;/g, '&') });
  }
  return { observedRows, rows };
}

export async function backfillGuessResults({ titles, progressPath, fetchHtml }) {
  let results = {};
  try { results = JSON.parse(await readFile(progressPath, 'utf8')).results; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = titles.filter(title => !Object.hasOwn(results, title));
  const total = titles.length;
  const save = async done => {
    await writeFile(progressPath + '.tmp', JSON.stringify({ total, done, results }), 'utf8');
    await rename(progressPath + '.tmp', progressPath);
  };
  async function fetchBatch(batch) {
    const query = batch.map((title, i) => '<div id="guess-backfill-' + i + '">\n{{Player results table|player=' +
      title.slice(0, -8) + '}}\n</div>').join('\n');
    const html = await fetchHtml(query);
    const markers = [...html.matchAll(/<div id="guess-backfill-(\d+)">/g)];
    const parsed = new Map(markers.map((marker, i) => [
      batch[Number(marker[1])],
      readGuessResults(html.slice(marker.index + marker[0].length, markers[i + 1]?.index))
    ]));
    const fingerprints = new Set();
    for (const item of parsed.values()) {
      if (!item.rows.length) continue;
      const fingerprint = JSON.stringify(item.rows);
      if (fingerprints.has(fingerprint)) throw Error('different players returned identical results');
      fingerprints.add(fingerprint);
    }
    return parsed;
  }
  for (let i = 0; i < pending.length; i += 3) {
    const batch = pending.slice(i, i + 3);
    if (batch.some(title => !title.endsWith('/Results') || /[{}|\r\n<>\[\]]/.test(title))) throw Error('invalid results page title');
    const parsed = await fetchBatch(batch);
    for (const title of batch) {
      const item = parsed.get(title);
      if (item?.observedRows) results[title] = item;
    }
    await save(false);
    for (const title of batch.filter(title => !Object.hasOwn(results, title))) {
      const item = (await fetchBatch([title])).get(title);
      results[title] = item?.observedRows ? item : null;
      await save(false);
    }
    console.log('[guess-results]', Object.keys(results).length, '/', total);
  }
  await save(true);
}
