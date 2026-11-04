export function readQueueSnapshot(WebSocket, profileIds) {
  return new Promise((resolve,reject)=>{
    const socket = new WebSocket(`wss://socket.aoe2companion.com/listen?handler=queueing&profile_ids=${profileIds.join(',')}`);
    const entries = new Map();
    let settled=false, quietTimer;
    const finish=(error)=>{
      if(settled)return;settled=true;clearTimeout(timeout);clearTimeout(quietTimer);
      try{socket.close();}catch{}
      error?reject(error):resolve([...entries.values()]);
    };
    const timeout=setTimeout(()=>finish(new Error('queue snapshot timeout')),10000);
    socket.addEventListener('message',event=>{
      let messages;try{messages=JSON.parse(String(event.data));}catch{return;}
      for(const message of [].concat(messages)){
        const data=message?.data;if(!data?.id)continue;
        if(message.type==='queueingRemoved')entries.delete(data.id);
        else entries.set(data.id,{...entries.get(data.id),...data});
      }
      clearTimeout(quietTimer);quietTimer=setTimeout(()=>finish(),1500);
    });
    socket.addEventListener('error',()=>finish(new Error('queue snapshot connection error')));
    socket.addEventListener('close',()=>finish(new Error('queue snapshot closed before completion')));
  });
}
