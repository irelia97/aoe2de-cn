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
      Promise.resolve().then(()=>fetchLatest(job.id)).then(match=>{
        if(job.generation!==generation || hasState(job.id) || !match)return;
        ingest(job.id,match);
      }).catch(error=>console.warn(`[realtime] missing-state check deferred for ${job.id}: ${error.message}`)).finally(()=>{
        pending.delete(job.key);
        running=false;drain();
      });
      return;
    }
  }
  return {
    enqueue(ids) {
      for(const value of ids) {
        const id=String(value),key=`${generation}:${id}`;
        if(pending.has(key)||hasState(id)||(checkedAt.has(id)&&now()-checkedAt.get(id)<10*60*1000))continue;
        pending.add(key);
        queue.push({id,key,generation});
      }
      drain();
    },
    reset() {generation++;queue=[];pending.clear();checkedAt.clear();}
  };
}
