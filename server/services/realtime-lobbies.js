export function createLobbyListener({ WebSocket, onChange, onDeparted = () => {} }) {
  const rooms = new Map();
  let socket, retry, profileIds = new Set(), stopped = true;
  const watched = room => [...room.slots.values()].some(player => profileIds.has(String(player.profileId)));
  function connect() {
    if (stopped || !WebSocket) return;
    const current = new WebSocket('wss://socket.aoe2companion.com/listen?handler=lobbies');
    socket = current;
    current.addEventListener('open', () => {
      if (socket !== current) return;
      rooms.clear();
      onChange();
    });
    current.addEventListener('message', event => {
      if (socket !== current) return;
      let messages;
      try { messages = JSON.parse(String(event.data)); } catch { return; }
      let changed = false;
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        const data = message?.data;
        if (data?.matchId == null) continue;
        const id = String(data.matchId);
        let room = rooms.get(id);
        const wasWatched = room && watched(room);
        if (message.type === 'lobbyRemoved') {
          const departed=room ? [...room.slots.values()].filter(player=>profileIds.has(String(player.profileId))).map(player=>String(player.profileId)) : [];
          if (wasWatched) changed = true;
          rooms.delete(id);
          if(departed.length)onDeparted(departed,id);
        } else if (['lobbyAdded','lobbyUpdated'].includes(message.type)) {
          if (!room) { room = { data:{matchId:data.matchId}, slots:new Map() }; rooms.set(id,room); }
          room.data = { ...room.data, ...data };
          if (room.data.started || room.data.finished) {
            rooms.delete(id);
            const departed=[...room.slots.values()].filter(player=>profileIds.has(String(player.profileId))).map(player=>String(player.profileId));
            if(departed.length)onDeparted(departed,id);
          }
          if (wasWatched || watched(room)) changed = true;
        } else if (['slotAdded','slotUpdated','slotRemoved'].includes(message.type) && data.slot != null) {
          if (!room) { room = { data:{matchId:data.matchId}, slots:new Map() }; rooms.set(id,room); }
          const key = String(data.slot);
          const previous=room.slots.get(key);
          if (message.type === 'slotRemoved') room.slots.delete(key);
          else {
            const player = { ...room.slots.get(key), ...data };
            if (/^[1-9]\d*$/.test(String(player.profileId)) && (!player.status || player.status === 'player')) room.slots.set(key,player);
            else room.slots.delete(key);
          }
          if (wasWatched || watched(room)) changed = true;
          if(previous && profileIds.has(String(previous.profileId)) && String(previous.profileId)!==String(room.slots.get(key)?.profileId))onDeparted([String(previous.profileId)],id);
        }
      }
      if (changed) onChange();
    });
    current.addEventListener('error', () => console.warn('[realtime] lobbies connection error'));
    current.addEventListener('close', () => {
      if (socket !== current || stopped) return;
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
    status() { return { connected:socket?.readyState===1, roomCount:rooms.size }; }
  };
}
