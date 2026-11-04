export async function fetchKickLive(source, fetcher = fetch) {
  const channel = new URL(source.url).pathname.split('/').filter(Boolean)[0];
  if (!channel || !/^[\w-]+$/.test(channel)) throw new Error('无效的 Kick 直播间地址');
  const response = await fetcher(`https://kick.com/api/v1/channels/${encodeURIComponent(channel)}`, {
    headers: { 'user-agent':'Mozilla/5.0', accept:'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok) throw new Error(`Kick 直播接口返回 HTTP ${response.status}`);
  const data = await response.json();
  if (!data?.id || !data.slug || !Object.hasOwn(data,'livestream')) throw new Error('Kick 直播接口格式无效');
  const stream = data.livestream;
  return {
    id:`kick:${channel.toLowerCase()}`, platform:'kick', name:source.name || data.user?.username || channel,
    isCN:source.isCN, url:source.url, live:stream?.is_live === true,
    title:stream?.session_title || '', thumbnail:stream?.thumbnail?.url || '',
    viewers:Number(stream?.viewer_count ?? stream?.viewers) || 0, checkedAt:new Date().toISOString()
  };
}
