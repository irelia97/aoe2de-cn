const cacheTtl = 48 * 60 * 60 * 1000;
export function createProfileAccountsReader({ readCached, refresh, localProfileDetails, loadReferences, now = Date.now }) {
  const refreshAfter = new Map();
  function refreshInBackground(id) {
    if((refreshAfter.get(id)||0)>now())return;
    refreshAfter.set(id,now()+60000);
    Promise.resolve().then(()=>refresh(id)).catch(error=>console.warn(`[accounts] upstream unavailable for ${id}; retaining local data: ${error.message}`));
  }
  return async function readAccounts(profileId) {
    const id=String(profileId),references=await loadReferences();
    const canonicalId=references.get(id)?.canonicalProfileId || id;
    const related=[id,...[...references].filter(([key,value])=>key!==id && /^\d+$/.test(key) && value.canonicalProfileId===canonicalId).map(([key])=>key)];
    for(const candidate of related) {
      const cached=await readCached(candidate);
      if(!Array.isArray(cached?.profile?.accounts) || (candidate!==id && !cached.profile.accounts.some(account=>account.platform==='steam' && String(account.id)===id)))continue;
      const stale=now()-Number(cached.savedAt||0)>=cacheTtl;
      if(stale)refreshInBackground(candidate);
      return {accounts:cached.profile.accounts.map(account=>({...account,rlReference:references.get(String(account.id))||null})),avatar:cached.profile.avatar || '',cached:true,stale,partial:false,source:'aoe2recs'};
    }
    const accounts=related.map(accountId=>{
      const player=localProfileDetails(accountId)?.player;
      if(!player)return null;
      const raw=player.lastMatchTime;
      let last=Number(raw)||Math.floor(Date.parse(raw||'')/1000)||0;
      if(last>1e12)last=Math.floor(last/1000);
      return {id:accountId,platform:'steam',name:player.name || `玩家 ${accountId}`,akas:[],country:player.country_code || '',last,
        url:`https://www.ageofempires.com/stats/?profileId=${accountId}&game=age2`,rlReference:references.get(accountId)||null};
    }).filter(Boolean);
    refreshInBackground(canonicalId);
    return {accounts,avatar:'',cached:true,stale:true,partial:true,source:'local-known-accounts'};
  };
}
