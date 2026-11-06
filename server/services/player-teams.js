const lifetime = 15 * 24 * 60 * 60 * 1000;
export function createPlayerTeams({ readFile, writeFile, rename, cachePath, loadProfile, onChange = () => {}, now = Date.now }) {
  const records = new Map(), pending = new Set(), retryAfter = new Map(), queue = [];
  let loading, saving = Promise.resolve(), running = 0, timer;
  function store(record) {
    for(const [id,previous] of records)if(previous.canonicalId===record.canonicalId)records.delete(id);
    for (const id of record.accountIds) records.set(String(id),record);
    records.set(record.canonicalId,record);
  }
  function load() {
    if (!loading) loading = readFile(cachePath,'utf8').then(text=>{
      const saved=JSON.parse(text);
      for (const record of saved.teams || []) {
        if (/^\d+$/.test(record.canonicalId) && Array.isArray(record.accountIds) && typeof record.team==='string' && Number(record.updatedAt)>0) store(record);
      }
      for(const [id,time] of Object.entries(saved.retryAfter || {}))if(Number(time)>now())retryAfter.set(id,Number(time));
    }).catch(error=>{if(error.code!=='ENOENT')console.warn('[teams] cache load failed:',error.message);});
    return loading;
  }
  function save() {
    const data=JSON.stringify({teams:[...new Set(records.values())],retryAfter:Object.fromEntries(retryAfter)},null,2);
    saving=saving.catch(()=>{}).then(async()=>{
      await writeFile(cachePath+'.tmp',data,'utf8');
      await rename(cachePath+'.tmp',cachePath);
    }).catch(error=>console.warn('[teams] cache save failed:',error.message));
    return saving;
  }
  function refresh(id) {
    if (pending.has(id) || (retryAfter.get(id)||0)>now()) return;
    pending.add(id);queue.push(id);drain();
  }
  function drain() {
    while(running<2 && queue.length) {
      const id=queue.shift();running++;
      Promise.resolve().then(()=>loadProfile(id)).then(profile=>{
        const player=profile?.player;
        if(!player || Number(player.platform_id)!==3)throw Error('Invalid AoE2Recs player');
        const verified=player.verified===true;
        const canonicalId=verified?String(player.id):id;
        if(!/^\d+$/.test(canonicalId))throw Error('Invalid AoE2Recs profile ID');
        const accountIds=verified?[...new Set([canonicalId,id,...(profile.accounts||[]).filter(a=>a.platform==='steam').map(a=>String(a.id))])].filter(value=>/^\d+$/.test(value)):[id];
        store({canonicalId,accountIds,team:verified && typeof player.team==='string'?player.team.trim():'',updatedAt:Math.min(now(),Number(profile.cacheSavedAt)||now())});
        retryAfter.delete(id);
        save();onChange();
      }).catch(error=>{
        retryAfter.set(id,now()+24*60*60*1000);
        save();
        console.warn(`[teams] refresh deferred for ${id}: ${error.message}`);
      }).finally(()=>{running--;pending.delete(id);drain();});
    }
  }
  async function refreshExpired() {
    await load();
    for(const record of new Set(records.values()))if(now()-record.updatedAt>=lifetime)refresh(record.canonicalId);
  }
  return {
    async getTeams(ids, verifiedProfiles = new Map(), references = new Map()) {
      await load();
      const teams=new Map();let changed=false;
      for(const rawId of ids) {
        const id=String(rawId), verified=verifiedProfiles.get(id);
        const canonicalId=verified?.canonicalProfileId || references.get(id)?.canonicalProfileId || id;
        let record=records.get(id) || records.get(canonicalId);
        if(!record && verified) {
          const accountIds=[...new Set([canonicalId,id,...[...verifiedProfiles].filter(([,item])=>item.canonicalProfileId===canonicalId).map(([key])=>key)])];
          record={canonicalId,accountIds,team:verified.team || '',updatedAt:Math.min(now(),Number(verified.savedAt)||now())};
          store(record);changed=true;
        }
        teams.set(id,record?.team || '');
        if(!record || now()-record.updatedAt>=lifetime)refresh(record?.canonicalId || canonicalId);
      }
      if(changed)save();
      return teams;
    },
    start() {
      if(timer)return;
      refreshExpired();timer=setInterval(refreshExpired,60*60*1000);timer.unref?.();
    }
  };
}
