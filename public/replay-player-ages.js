const ages = [
  {name:'黑暗时代',icon:'/assets/build-orders/icons/dark-age.webp'},
  {name:'封建时代',icon:'/assets/build-orders/icons/feudal-age.webp'},
  {name:'城堡时代',icon:'/assets/build-orders/icons/castle-age.webp'},
  {name:'帝王时代',icon:'/assets/build-orders/icons/imperial-age.webp'},
];

export function collectPlayerAgeEvents(full) {
  const events=[];
  let time=0;
  for(const chapter of full?.chapters || [])for(const op of chapter.operations || []) {
    if(op.Sync)time+=Number(op.Sync.time_increment)||0;
    if(!op.Chat)continue;
    let chat;
    try { chat=JSON.parse(op.Chat.text ?? op.Chat.message); } catch { continue; }
    // Normal player chat has an empty AGP field. Only use system notifications.
    const system=String(chat.messageAGP || '');
    if(!/^@#\d+<player_id,\d+,\d+>/.test(system))continue;
    const player=Number(system.match(/<player_id,(\d+),/)[1]);
    const text=system.replace(/<player_id,[^>]+>/g,'');
    const age=/帝王|Imperial Age/i.test(text) ? 3 : /城堡|Castle Age/i.test(text) ? 2 : /封建|Feudal Age/i.test(text) ? 1 : /黑暗|Dark Age/i.test(text) ? 0 : null;
    if(age!=null)events.push({time,player,age});
  }
  return events.sort((a,b)=>a.time-b.time);
}

export function playerAgeAt(events, player, time, startingAge=0) {
  let age=startingAge;
  for(const event of events) {
    if(event.time>time)break;
    if(event.player===Number(player))age=Math.max(age,event.age);
  }
  return age;
}

export function createMapPlayerLegend(target, full, players, colors, settings={}) {
  const events=collectPlayerAgeEvents(full);
  const selected=Number(settings.starting_age_id)||0;
  const startingAge=({0:0,2:0,3:1,4:2,5:3})[selected] ?? 0;
  target.replaceChildren();
  const rows=players.map(player=>{
    const row=document.createElement('div');row.className='replay-map-player-row';
    row.style.color=colors(player.color_id);
    const image=document.createElement('img'),label=document.createElement('span');
    image.width=18;image.height=18;image.dataset.player=String(player.player_number);
    label.textContent=player.displayName || player.name;label.title=label.textContent;
    row.append(image,label);target.append(row);
    return {player,image,age:-1};
  });
  return time=>{
    for(const row of rows) {
      const index=playerAgeAt(events,row.player.player_number,time,startingAge);
      if(index===row.age)continue;
      row.age=index;row.image.src=ages[index].icon;row.image.alt=ages[index].name;row.image.title=`当前时代：${ages[index].name}`;
    }
  };
}
