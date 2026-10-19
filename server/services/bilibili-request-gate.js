// Serialize Bilibili requests and stop a host after a risk response.
export function createBilibiliRequestGate({fetchImpl=fetch,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),gapMs=3000,getBlockedUntil=()=>0,onRisk=async()=>{},logger=console}) {
 let queue=Promise.resolve(),nextAt=0;const blocked=new Map();
 function context(url){const u=new URL(url);return {host:u.hostname,path:u.pathname};}
 function softRisk(value,depth=0){
  if(depth>7||!value||typeof value!=='object')return false;
  return Object.entries(value).some(([key,item])=>key==='v_voucher'?typeof item==='string'&&item.trim().length>0:softRisk(item,depth+1));
 }
 async function request(url,options={}){
  const job=queue.then(async()=>{
   const {host,path}=context(url);
   const until=Math.max(blocked.get(host)||0,Number(getBlockedUntil(host))||0);
   if(until>now()){const e=new Error('B站接口处于冷却期，暂停至 '+new Date(until).toISOString());e.cooldown=true;e.retryAfterMs=until-now();throw e;}
   if(nextAt>now())await sleep(nextAt-now());
   // Recheck after queue delay; another caller may have activated the cooldown.
   const recheck=Math.max(blocked.get(host)||0,Number(getBlockedUntil(host))||0);
   if(recheck>now()){const e=new Error('B站接口处于冷却期');e.cooldown=true;e.retryAfterMs=recheck-now();throw e;}
   nextAt=now()+gapMs;
   const {signal,timeoutMs=30000,...rest}=options;
   const response=await fetchImpl(url,{...rest,signal:AbortSignal.timeout(timeoutMs)});
   let payload=null;
   if(response.ok&&String(response.headers.get('content-type')||'').includes('json')){try{payload=await response.clone().json();}catch{}}
   const code=payload?.code==null?null:Number(payload.code);
   const voucher=softRisk(payload);
   const risky=[403,412,429].includes(response.status)||[-412,-352,-403].includes(code)||voucher;
   if(risky){
    const e=new Error('B站风控响应：'+host+path+' HTTP '+response.status+(code!=null?'，业务码 '+code:'')+(voucher?'，含有效验证凭据':''));
    e.status=response.status;e.bilibiliCode=code;e.softRisk=voucher;e.riskResponse=true;e.endpoint=host+path;
    const retry=response.headers.get('retry-after');const numeric=Number(retry);
    const retryMs=retry?(Number.isFinite(numeric)?numeric*1000:Math.max(0,Date.parse(retry)-now())):0;
    e.retryAfterMs=Math.max(12*3600000,Number.isFinite(retryMs)?retryMs:0);
    blocked.set(host,now()+e.retryAfterMs);
    logger.warn('[bilibili-risk] '+e.message);
    await onRisk({host,path,error:e,blockedUntil:now()+e.retryAfterMs});
    throw e;
   }
   if(!response.ok||(code!=null&&code!==0))logger.warn('[bilibili-request] '+host+path+' HTTP '+response.status+(code!=null?' code='+code:''));
   return response;
  });queue=job.catch(()=>{});return job;
 }
 return {request,softRisk};
}
