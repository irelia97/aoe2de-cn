import { splitRealtimeProfiles } from './realtime-profile-groups.js';
function createLobbyShard({ WebSocket, onChange }) {
  const rooms = new Map();
  let socket, retry, profileIds = new Set(), stopped = true;
  let connectedAt=null,lastMessageAt=null,messagesReceived=0,reconnectCount=0;
  const watched = room => [...room.slots.values()].some(player => profileIds.has(String(player.profileId)));
  function connect() {
    if (stopped || !WebSocket) return;
    // Profile-filtered lobby streams omit room metadata and other slots.
    // Subscribe to full rooms and shard monitored-player ownership locally.
    const current = new WebSocket('wss://socket.aoe2companion.com/listen?handler=lobbies');
    socket = current;
    current.addEventListener('open', () => {
      if (socket !== current) return;
      rooms.clear();
      connectedAt=new Date().toISOString();
      onChange();
    });
    current.addEventListener('message', event => {
      if (socket !== current) return;
      let messages;
      try { messages = JSON.parse(String(event.data)); } catch { return; }
      lastMessageAt=new Date().toISOString();
      messagesReceived+=Array.isArray(messages)?messages.length:1;
      let changed = false;
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        const data = message?.data;
        if (data?.matchId == null) continue;
        const id = String(data.matchId);
        let room = rooms.get(id);
        const wasWatched = room && watched(room);
        if (message.type === 'lobbyRemoved') {
          if (wasWatched) changed = true;
          rooms.delete(id);
        } else if (['lobbyAdded','lobbyUpdated'].includes(message.type)) {
          if (!room) { room = { data:{matchId:data.matchId}, slots:new Map() }; rooms.set(id,room); }
          room.data = { ...room.data, ...data };
          if (room.data.started || room.data.finished) rooms.delete(id);
          if (wasWatched || watched(room)) changed = true;
        } else if (['slotAdded','slotUpdated','slotRemoved'].includes(message.type) && data.slot != null) {
          if (!room) { room = { data:{matchId:data.matchId}, slots:new Map() }; rooms.set(id,room); }
          const key = String(data.slot);
          if (message.type === 'slotRemoved') room.slots.delete(key);
          else {
            const player = { ...room.slots.get(key), ...data };
            if (/^[1-9]\d*$/.test(String(player.profileId)) && (!player.status || player.status === 'player')) room.slots.set(key,player);
            else room.slots.delete(key);
          }
          if (wasWatched || watched(room)) changed = true;
        }
      }
      if (changed) onChange();
    });
    current.addEventListener('error', () => console.warn('[realtime] lobbies connection error'));
    current.addEventListener('close', () => {
      if (socket !== current || stopped) return;
      reconnectCount++;
      rooms.clear(); onChange();
      retry = setTimeout(connect,5000); retry.unref?.();
    });
  }
  return {
    start(ids) {
      this.stop();
      profileIds = new Set(ids.map(String)); stopped = false;
      if (profileIds.size) connect();
    },
    stop() {
      stopped = true; clearTimeout(retry);
      const previous = socket; socket = null;
      try { previous?.close(); } catch {}
      rooms.clear();
    },
    state(profileId) {
      if (socket?.readyState !== 1) return null;
      for (const room of rooms.values()) if ([...room.slots.values()].some(player=>String(player.profileId)===String(profileId))) {
        return { profileId:String(profileId), status:'lobby', match:null, lobby:{
          id:room.data.matchId,name:room.data.name || '未命名房间',map:room.data.mapName || room.data.map || '',server:room.data.server || '',
          players:[...room.slots.values()].sort((a,b)=>Number(a.slot)-Number(b.slot)).map(player=>({profileId:String(player.profileId),name:player.name || '',country:player.country || '',civilization:player.civName || '',civilizationId:player.civ,color:player.color,team:player.team}))
        } };
      }
      return null;
    },
    roomIds() { return [...rooms.keys()]; },
    status() { return { connected:socket?.readyState===1, profileCount:profileIds.size, roomCount:rooms.size, connectedAt,lastMessageAt,messagesReceived,reconnectCount }; }
  };
}


export function createLobbyListener({ WebSocket, onChange }) {
  let groups=[];
  return {
    start(ids) {
      this.stop();
      groups=splitRealtimeProfiles(ids).map((ids,index)=>({index,ids,listener:createLobbyShard({WebSocket,onChange})}));
      for(const group of groups)group.listener.start(group.ids);
    },
    stop() { for(const group of groups)group.listener.stop();groups=[]; },
    state(profileId) {return groups.find(group=>group.ids.includes(String(profileId)))?.listener.state(profileId)||null;},
    status() {
      const statuses=groups.map(group=>({group:group.index+1,...group.listener.status()}));
      return {connected:statuses.length>0&&statuses.every(group=>group.connected),socketCount:groups.length,
        roomCount:new Set(groups.flatMap(group=>group.listener.roomIds())).size,groups:statuses};
    }
  };
}
