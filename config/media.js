// Developer-maintained media sources. This file is the only place where
// supported video channels and live rooms are configured.
//
// Video examples:
// { platform: 'bilibili', id: '主播 UID', name: '显示名称', url: 'https://space.bilibili.com/主播 UID' }
// { platform: 'bilibili', bvid: 'BV号', name: '显示名称', url: '视频链接', pinned: false }
// { platform: 'youtube', channelId: '频道 ID', name: '显示名称', url: 'https://www.youtube.com/channel/频道 ID' }
// { platform: 'rss', feedUrl: 'RSS 地址', name: '显示名称', url: '频道主页' }
//
// Live examples:
// { platform: 'bilibili', roomId: '房间号', name: '显示名称', url: 'https://live.bilibili.com/房间号' }
// { platform: 'youtube', liveUrl: '直播频道或直播页', name: '显示名称', url: '直播频道或直播页' }
export const mediaSources = {
  videos: [
    { platform: 'bilibili', id: '34201013', name: 'nishuone123', url: 'https://space.bilibili.com/34201013' },
    { platform: 'bilibili', id: '1423184578', name: '悬崖6290', url: 'https://space.bilibili.com/1423184578' },
    { platform: 'bilibili', id: '287978933', name: '戏曲艺术一枝花', url: 'https://space.bilibili.com/287978933' },
    { platform: 'bilibili', id: '3546889469299605', name: 'Hera黑鸭_帝国时代2', url: 'https://space.bilibili.com/3546889469299605' },
    { platform: 'bilibili', id: '19804019', name: '夢逝影', url: 'https://space.bilibili.com/19804019' },
    { platform: 'bilibili', id: '25176428', name: '吟游诗人爱莉琰', url: 'https://space.bilibili.com/25176428' },
    { platform: 'bilibili', id: '1833373356', name: '雷欧聊帝国', url: 'https://space.bilibili.com/1833373356' },
    { platform: 'bilibili', id: '7574156', name: '可爱カナ', url: 'https://space.bilibili.com/7574156' },
    { platform: 'bilibili', id: '3546644844906660', name: '中国中晟战队官方账号', url: 'https://space.bilibili.com/3546644844906660' },
    { platform: 'bilibili', id: '1335508353', name: 'Togawa__Sakikoi', url: 'https://space.bilibili.com/1335508353' },
    { platform: 'bilibili', id: '3537110130756111', name: 'DeeDarFanIV', url: 'https://space.bilibili.com/3537110130756111' },
    { platform: 'bilibili', id: '382680807', name: '进村通行', url: 'https://space.bilibili.com/382680807' },
    { platform: 'bilibili', id: '481623535', name: 'CNZS骑士老爷_帝国时代2', url: 'https://space.bilibili.com/481623535' },
    { platform: 'bilibili', id: '411950974', name: '框a战神', url: 'https://space.bilibili.com/411950974' },
    { platform: 'bilibili', id: '326545342', name: '半人马座伽马星', url: 'https://space.bilibili.com/326545342' },
    { platform: 'bilibili', id: '22836441', name: '一之瀬姬月', url: 'https://space.bilibili.com/22836441' },
    { platform: 'bilibili', id: '281894927', name: '喷泉之下', url: 'https://space.bilibili.com/281894927' },
    { platform: 'bilibili', id: '1185628', name: 'spadetwo', url: 'https://space.bilibili.com/281894927' },
  ],
  live: [
    { platform: 'bilibili', roomId: '1957024441', name: '好耶是周末', url: 'https://live.bilibili.com/1957024441' },
    { platform: 'bilibili', roomId: '22276118', name: '秋已夕', url: 'https://live.bilibili.com/22276118' },
    { platform: 'bilibili', roomId: '3859473', name: 'B站直播间 3859473', url: 'https://live.bilibili.com/3859473' },
    { platform: 'bilibili', roomId: '23195173', name: 'spadetwo', url: 'https://live.bilibili.com/23195173' },
    { platform: 'bilibili', roomId: '311754', name: '勇者三叶', url: 'https://live.bilibili.com/blanc/311754' }
  ]
};

export const mediaVideoWhitelist = [
  'nishuone123',
  '戏曲艺术一枝花',
  'Hera黑鸭_帝国时代2',
  '悬崖6290',
  '夢逝影',
  '中国中晟战队官方账号',
  'CNZS骑士老爷_帝国时代2',
  '框a战神',
  '半人马座伽马星',
  'spadetwo',
];



