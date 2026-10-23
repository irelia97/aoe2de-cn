const canonical = id => [71,109,141,142,621].includes(Number(id)) ? 109 : Number(id);
const siteKey = e => `${e.player}:${canonical(e.unit)}:${e.x}:${e.y}`;

export function collectSelfDeletes(full) {
  const result=[];
  for(const chapter of full?.chapters || []) for(const op of chapter.operations || []) {
    const action=op.Action,command=action?.action_data?.Delete;
    if(!command)continue;
    let objectId=command.object_id;
    if(objectId == null && command.data?.length>=4) {
      const bytes=Uint8Array.from(command.data.slice(0,4));objectId=new DataView(bytes.buffer).getUint32(0,true);
    }
    const time=Number(action.world_time);
    if(Number.isInteger(Number(objectId)) && Number(objectId)>=0 && Number.isFinite(time) && time>=0)
      result.push({time,player:Number(command.player_id),objectId:Number(objectId)});
  }
  return result.sort((a,b)=>a.time-b.time);
}

export function resolveBuildingLifecycle(full, map) {
  const objects=new Map((map?.initialObjects || []).filter(o=>o.classId===80).map(o=>[Number(o.instance),{player:Number(o.player),unit:o.id,initial:true,instance:o.instance,x:o.x,y:o.y}]));
  const sites=(map?.events || []).map((e,index)=>({...e,index})).filter(e=>e.kind==='Build');
  const refs=new Map(),positions=new Map();
  for(const chapter of full?.chapters || []) for(const op of chapter.operations || []) {
    const action=op.Action;if(!action?.action_data)continue;
    const time=Number(action.world_time)||0,q=action.action_data.DeQueue,interact=action.action_data.Interact;
    if(q && Number.isFinite(Number(q.building_type)))for(const id of q.building_ids || []) {
      if(!refs.has(Number(id)))refs.set(Number(id),{time,player:Number(q.player_id),unit:Number(q.building_type)});
    }
    if(interact && Number.isFinite(Number(interact.x)) && Number.isFinite(Number(interact.y))) {
      const id=Number(interact.target_id);
      if(!positions.has(id))positions.set(id,[]);
      positions.get(id).push({time,x:Number(interact.x),y:Number(interact.y)});
    }
  }
  const deletes=collectSelfDeletes(full),initialDeletedAt=new Map(),eventDeletedAt=new Map(),claimed=new Set();
  // Resolve new buildings only when a typed production reference identifies a
  // unique earlier construction site. Never guess by object-ID sequence.
  for(const [id,ref]of [...refs].sort((a,b)=>a[1].time-b[1].time)) {
    if(objects.has(id))continue;
    const groups=new Map();
    for(const e of sites) {
      if(e.time>ref.time || Number(e.player)!==ref.player || canonical(e.unit)!==canonical(ref.unit))continue;
      const key=siteKey(e);if(claimed.has(key))continue;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);
    }
    let candidates=[...groups.values()];
    const points=(positions.get(id)||[]).filter(p=>p.time<=ref.time);
    if(points.length) candidates=candidates.filter(group=>points.some(p=>Math.hypot(p.x-group[0].x,p.y-group[0].y)<=.75));
    if(candidates.length!==1)continue;
    const group=candidates[0],site=group[0];claimed.add(siteKey(site));
    objects.set(id,{player:ref.player,unit:site.unit,x:site.x,y:site.y,events:group.map(e=>e.index),initial:false,observedAt:ref.time});
  }
  const events=[];
  for(const deletion of deletes) {
    const object=objects.get(deletion.objectId);
    const matched=object && object.player===deletion.player && (object.initial || object.observedAt<=deletion.time);
    events.push({...deletion,matched:Boolean(matched),...(matched ? {unit:object.unit,x:object.x,y:object.y}: {})});
    if(!matched)continue;
    if(object.initial)initialDeletedAt.set(object.instance,Math.min(initialDeletedAt.get(object.instance)??Infinity,deletion.time));
    else for(const index of object.events)eventDeletedAt.set(index,Math.min(eventDeletedAt.get(index)??Infinity,deletion.time));
  }
  return {initialDeletedAt,eventDeletedAt,events};
}
