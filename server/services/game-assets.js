export function createGameAssetService({ join, readFile, writeFile, mkdir, fetch, gameAssetCacheDir, gameAssetRefreshes }) {
  function gameAssetPath(kind, slug) {
    return join(gameAssetCacheDir, kind, `${slug}.png`);
  }

  async function getGameAsset(kind, slug) {
    const target = gameAssetPath(kind, slug);
    try { return await readFile(target); } catch {}
    const key = `${kind}/${slug}`;
    if (!gameAssetRefreshes.has(key)) {
      const refresh = (async () => {
        const compactSlug = slug.replaceAll('_', '');
        const candidates = kind === 'map'
          ? [`maps/rm_${slug}.png`, `maps/${slug}.png`, `maps/rm_${compactSlug}.png`, `maps/${compactSlug}.png`]
          : [`civilizations/${slug}.png`, ...(slug === 'inca' ? ['civilizations/incas.png'] : []), ...(slug === 'maya' ? ['civilizations/mayans.png'] : [])];
        let response = null;
        for (const upstreamPath of candidates) {
          const candidate = await fetch(`https://backend.cdn.aoe2companion.com/public/aoe2/de/${upstreamPath}`, { signal: AbortSignal.timeout(15000) });
          if (candidate.ok) { response = candidate; break; }
        }
        if (!response) throw new Error('游戏资源不存在');
        const data = Buffer.from(await response.arrayBuffer());
        await mkdir(join(gameAssetCacheDir, kind), { recursive: true });
        await writeFile(target, data);
        return data;
      })().finally(() => gameAssetRefreshes.delete(key));
      gameAssetRefreshes.set(key, refresh);
    }
    return gameAssetRefreshes.get(key);
  }

  return { gameAssetPath, getGameAsset };
}
