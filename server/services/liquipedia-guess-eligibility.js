const canonical = title => String(title).normalize('NFKC').replace(/[_\s]+/g, ' ').trim().toLowerCase();
const text = html => html.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).trim();

export function readEligibilityRows(html) {
  const evidence = [];
  let rows = 0, uncertain = false;
  for (const [row] of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => match[1]);
    if (cells.length < 6 || !/^\d{4}-\d{2}-\d{2}$/.test(text(cells[0]))) continue;
    rows++;
    const tier = text(cells[2]);
    if (tier !== 'S-Tier' && tier !== 'A-Tier') continue;
    const place = text(cells[1]);
    const rank = /^(\d+)(?:st|nd|rd|th)?(?:\s*[-–]\s*(\d+)(?:st|nd|rd|th)?)?$/i.exec(place);
    if (!rank || Number(rank[2] || rank[1]) > 16) continue;
    if (!/\btitle="Age of Empires II(?:[: ][^"]*)?"/i.test(cells[3])) {
      if (!/title="Age of Empires|title="Age of Mythology/i.test(cells[3])) uncertain = true;
      continue;
    }
    const tournament = text(cells[5]);
    const href = /href="(\/ageofempires\/[^"]+)"/.exec(cells[5])?.[1];
    if (!tournament || !href) { uncertain = true; continue; }
    evidence.push({ tier, place, tournament, date: text(cells[0]), url: 'https://liquipedia.net' + href.replace(/&amp;/g, '&') });
  }
  return { rows, uncertain, evidence };
}

export async function scanGuessEligibility({ catalog, existing, readProgress, saveProgress, fetchPages }) {
  const known = new Set(existing.map(canonical));
  const progress = await readProgress();
  const results = progress.results || {};
  const pending = catalog.filter(page => !Object.hasOwn(results, page.title));
  const store = async () => saveProgress({
    total: catalog.length,
    checked: Object.keys(results).length,
    qualified: Object.values(results).filter(result => result.status === 'qualified').length,
    review: Object.values(results).filter(result => result.status === 'review').length,
    updatedAt: new Date().toISOString(),
    results
  });
  for (let offset = 0; offset < pending.length; offset += 3) {
    const batch = [];
    for (const page of pending.slice(offset, offset + 3)) {
      if (!page.title.endsWith('/Results') || /[{}|\r\n<>\[\]]/.test(page.title)) {
        results[page.title] = { status: 'review', reason: 'unexpected results-page title' };
      } else if (known.has(canonical(page.title.slice(0, -8)))) {
        results[page.title] = { status: 'in-roster' };
      } else batch.push(page.title);
    }
    if (batch.length) {
      const chunks = await fetchPages(batch);
      for (const title of batch) {
        let parsed = readEligibilityRows(chunks.get(title) || '');
        if (!parsed.rows && batch.length > 1) {
          const single = await fetchPages([title]);
          parsed = readEligibilityRows(single.get(title) || '');
        }
        results[title] = parsed.evidence.length
          ? { status: 'qualified', evidence: parsed.evidence }
          : parsed.rows && !parsed.uncertain
            ? { status: 'no-qualifying-result' }
            : { status: 'review', reason: parsed.rows ? 'game or tournament is ambiguous' : 'no readable placement rows' };
      }
    }
    await store();
  }
  await store();
}
