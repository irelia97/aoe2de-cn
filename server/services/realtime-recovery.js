export function createRealtimeRecovery({ fetchLatest, hasState, ingest, now = Date.now }) {
  let generation=0,queue=[],running=false;
  const pending=new Set(),checkedAt=new Map();
  function drain() {
    if(running)return;
    while(queue.length) {
      const job=queue.shift();
      if(job.generation!==generation || hasState(job.id)) {pending.delete(job.key);continue;}
      running=true;
      checkedAt.set(job.id,now());
      let recovered=false;
      Promise.resolve().then(()=>fetchLatest(job.id)).then(match=>{
        if(job.generation!==generation || hasState(job.id) || !match)return;
        const matchId=String(match.matchId ?? match.id ?? '');
        if(job.matchId && matchId!==job.matchId)return;
        recovered=ingest(job.id,match)===true;
      }).catch(error=>console.warn(`[realtime] missing-state check deferred for ${job.id}: ${error.message}`)).finally(()=>{
        if(!recovered && job.matchId && job.generation===generation && (job.attempt||0)<2 && !hasState(job.id)) {
          const retry=setTimeout(()=>{queue.unshift({...job,attempt:(job.attempt||0)+1});drain();},5000);
          retry.unref?.();
        } else pending.delete(job.key);
        running=false;drain();
      });
      return;
    }
  }
  return {
    enqueue(ids, {matchId='',priority=false}={}) {
      for(const value of ids) {
        const id=String(value),key=`${generation}:${id}:${matchId}`;
        if(pending.has(key)||hasState(id)||(!matchId && checkedAt.has(id)&&now()-checkedAt.get(id)<10*60*1000))continue;
        pending.add(key);
        const job={id,key,matchId:String(matchId),generation};
        priority?queue.unshift(job):queue.push(job);
      }
      drain();
    },
    reset() {generation++;queue=[];pending.clear();checkedAt.clear();}
  };
}
