export function createProfileLeaderboardLoader({ fetchProfileSection, profileSectionLoadingMarkup, renderProfileLeaderboards, document, location }) {
  let profileLeaderboardsRequestId = 0;
  function loadProfileLeaderboards(profileId) {
    const requestId = ++profileLeaderboardsRequestId;
    const isCurrent = () => requestId === profileLeaderboardsRequestId && location.pathname === `/players/${encodeURIComponent(profileId)}`;
    const initialBody = document.querySelector('#profileLeaderboardBody');
    if (initialBody) initialBody.innerHTML = profileSectionLoadingMarkup();
    return fetchProfileSection(`/api/profile-leaderboards?id=${encodeURIComponent(profileId)}&progressive=1`, isCurrent)
      .then(async data => {
        if (!isCurrent()) return;
        if (!Array.isArray(data?.leaderboards)) throw Error('天梯资料格式无效');
        renderProfileLeaderboards(data.leaderboards);
        if (!data.leaderboards.some(row => row.pending || row.stale)) return;
        try {
          const complete = await fetchProfileSection(`/api/profile-leaderboards?id=${encodeURIComponent(profileId)}`, isCurrent);
          if (isCurrent() && complete?.leaderboards) renderProfileLeaderboards(complete.leaderboards);
        } catch { /* Ranked cards stay visible if the optional lobby lookup fails. */ }
      })
      .catch(() => {
        if (!isCurrent() || !initialBody) return;
        const retry = Object.assign(document.createElement('button'), { type: 'button', textContent: '重试' });
        retry.onclick = () => loadProfileLeaderboards(profileId);
        initialBody.replaceChildren(document.createTextNode('天梯资料暂时无法加载 '), retry);
      });
  }
  return loadProfileLeaderboards;
}
