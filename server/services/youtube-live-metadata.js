function embeddedObject(html, key) {
  const marker=`"${key}":{`;
  const start=html.indexOf(marker);
  if(start<0)return null;
  let depth=0,quoted=false,escaped=false;
  for(let index=start+marker.length-1;index<html.length;index++){
    const char=html[index];
    if(quoted){
      if(escaped)escaped=false;
      else if(char==='\\')escaped=true;
      else if(char==='"')quoted=false;
    }else if(char==='"')quoted=true;
    else if(char==='{')depth++;
    else if(char==='}' && --depth===0){
      try{return JSON.parse(html.slice(start+marker.length-1,index+1));}
      catch{return null;}
    }
  }
  return null;
}

export function parseYoutubeWatchMetadata(html) {
  const details=embeddedObject(html,'videoDetails');
  if(!details?.videoId)return null;
  const count=embeddedObject(html,'videoViewCountRenderer');
  const raw=count?.isLive ? count.originalViewCount ?? count.viewCount?.runs?.[0]?.text : null;
  const viewers=raw == null ? null : Number(String(raw).replaceAll(',',''));
  return {
    videoId:details.videoId,
    channelId:details.channelId || '',
    title:details.title || '',
    live:details.isLive===true,
    viewers:Number.isFinite(viewers) && viewers>=0 ? viewers : null,
  };
}
