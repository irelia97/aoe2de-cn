import { Worker } from 'node:worker_threads';

export function createProfileSearchPool({now=Date.now}={}) {
  const workers=[],pending=new Map(),cache=new Map();let nextId=0;
  function createWorker(){
    const worker=new Worker(new URL('./profile-search-worker.js',import.meta.url));
    const slot={worker,count:0};workers.push(slot);
    worker.on('message',message=>{
      const item=pending.get(message.id);if(!item)return;
      pending.delete(message.id);slot.count--;
      clearTimeout(item.timer);
      if(!slot.count)worker.unref();
      if(message.error)item.reject(new Error(message.error));else item.resolve(message.rows);
    });
    const fail=error=>{
      const index=workers.indexOf(slot);if(index>=0)workers.splice(index,1);
      for(const [id,item]of pending)if(item.slot===slot){pending.delete(id);clearTimeout(item.timer);item.reject(error);}
    };
    worker.on('error',fail);worker.on('exit',()=>fail(new Error('搜索工作线程退出，请重试')));
    worker.unref();return slot;
  }
  function query(path,text){
    const normalized=text.trim(),key=JSON.stringify([path,normalized.toLocaleLowerCase()]);
    const old=cache.get(key);if(old && (old.pending || old.expires>now()))return old.promise;
    if(pending.size>=8)return Promise.reject(new Error('搜索繁忙，请稍后重试'));
    let slot=workers.reduce((best,item)=>!best || item.count<best.count?item:best,null);
    if(!slot || (slot.count && workers.length<2))slot=createWorker();
    const id=++nextId;
    const promise=new Promise((resolve,reject)=>{
      slot.worker.ref();
      const timer=setTimeout(()=>{failQuery();},10000);
      const failQuery=()=>{slot.worker.terminate();};
      pending.set(id,{resolve,reject,slot,timer});slot.count++;
      slot.worker.postMessage({id,path,query:normalized});
    });
    const entry={promise,pending:true,expires:0};cache.set(key,entry);
    promise.then(()=>{entry.pending=false;entry.expires=now()+60000;},()=>{if(cache.get(key)===entry)cache.delete(key);});
    for(const [key,value]of cache)if(!value.pending && (cache.size>128 || value.expires<=now()))cache.delete(key);
    return promise;
  }
  async function close(){await Promise.all([...workers].map(slot=>slot.worker.terminate()));cache.clear();}
  return {query,close};
}
