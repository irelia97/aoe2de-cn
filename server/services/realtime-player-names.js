const displayGroups = [
  { id:'2844691', name:'Monoz', accounts:['2844691','1861822','6779041','17331610'] },
  { id:'199170', name:'dogao', accounts:['199170','1486575','6097615','9714901','26267479','26047673'] },
  { id:'811511', name:'Kanon', accounts:['811511','21227185'] },
  { id:'290430', name:'冰冰', accounts:['290430','16815454','6352753'] },
  { id:'2972505', name:'旋律', accounts:['2972505'] },
  { id:'15097184', name:'东海帝', accounts:['15097184'] },
  { id:'23150792', name:'妲妲鸭', accounts:['23150792'] },
  { id:'6251969', name:'嘟嘟猪', accounts:['6251969'] },
  { id:'1026182', name:'神明与她', accounts:['1026182','2411454'] },
  { id:'716717', name:'合川大狗哥', accounts:['716717'] },
  { id:'599657', name:'屠神', accounts:['599657'] },
  { id:'271202', name:'Vinchester', accounts:['271202','4298865'] },
  { id:'211846', name:'恶魔大师', alwaysMonitor:true, accounts:['211846','14152531','25884155','1609124','21439807','19335742','14701856','12281774','18127247','15563076','16812056','3386339','19310037','19793956'] },
  { id:'14619549', name:'展毅', accounts:['14619549'] },
  { id:'1821855', name:'抖音螳螂', accounts:['1821855'] },
  { id:'7576082', name:'徐泽', accounts:['7576082','11493710','10275400','9776210','19343777','19294807'] },
  { id:'243287', name:'勇敢熊熊', accounts:['243287','3103118','220701','3217607','9699534'] },
  { id:'711407', name:'猪咪', accounts:['711407','3231530','25387359','6898128'] }
];
export const realtimePlayerNameOverrides = new Map(displayGroups.flatMap(group=>group.accounts.map(id=>[id,group.name])));
export const realtimePlayerIdentityOverrides = new Map(displayGroups.flatMap(group=>group.accounts.map(id=>[id,group.id])));
export const realtimePinnedProfileIds = displayGroups.filter(group=>group.alwaysMonitor).flatMap(group=>group.accounts);
export const realtimeExcludedProfileIds = new Set(['10044347','2203765','18385002']);

export function cleanRealtimePlayerName(value, clan = '') {
  let name = String(value || '').normalize('NFKC').trim();
  const tags = [clan, 'CNZS','TAG','VIT','Oni','wR','LY','SalzZ','DS','OS+','OS','Ux','RoR','AiM','NOC','ANKR','GKT','TWNBS','Zni','FJ','DY','CN','GT'].filter(Boolean);
  for (let pass=0; pass<3; pass++) {
    const previous=name;
    for (const tag of tags) {
      const escaped=tag.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      name=name.replace(new RegExp(`^(?:\\[${escaped}\\]|${escaped})[\\s_|.:'-]+`,'i'),'').trim();
    }
    name=name.replace(/^[\s_|!！·]+|[\s_|!！·]+$/g,'');
    if(name===previous)break;
  }
  return name || String(value || '').trim();
}
export function createVerifiedRealtimeNames({readFile, cacheDir}) {
  const files=new Map();
  return async function loadNames(ids) {
    const result=new Map();
    await Promise.all([...new Set(ids.map(String))].filter(id=>/^\d+$/.test(id)).map(async id=>{
      let cached=files.get(id);
      if(!cached || Date.now()-cached.checkedAt>5*60*1000){
        try { const data=JSON.parse(await readFile(`${cacheDir}/${id}.json`,'utf8'));cached={checkedAt:Date.now(),data}; }
        catch { cached={checkedAt:Date.now(),data:null}; }
        files.set(id,cached);
      }
      const profile=cached.data?.profile;
      if(profile?.player?.verified!==true || !profile.player.name || Number(profile.player.platform_id)!==3 || !/^\d+$/.test(String(profile.player.id)))return;
      const item={name:profile.player.name,canonicalProfileId:String(profile.player.id),savedAt:Number(cached.data.savedAt)||0};
      for(const account of profile.accounts || []) {
        const key=String(account.id || '');
        if(account.platform!=='steam'||!/^\d+$/.test(key))continue;
        if(!result.has(key)||result.get(key).savedAt<item.savedAt)result.set(key,item);
      }
    }));
    if(files.size>2000)for(const key of [...files.keys()].slice(0,files.size-2000))files.delete(key);
    return result;
  };
}
