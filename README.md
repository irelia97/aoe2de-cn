# AOE2DE-CN

AOE2DE-CN（帝国天梯）是面向《帝国时代 II：决定版》中文社区的数据站，整合官方天梯、玩家资料、近期对局、实时状态、赛事、直播视频、民族资料与互动猜题。

线上站点：<https://aoe2cn.cc>

## 功能

- 天梯榜单：随机地图、团队、死亡竞赛、帝国战争等模式，支持分页、玩家搜索和头像缓存。
- 玩家资料：分数与排名、最近100场、模式统计、账号与曾用名、战队、社交和直播链接、活跃时段及常见队友/对手。
- 实时对局：通过 AoE2 Companion WebSocket 展示排队、匹配、大厅和游戏中状态，并关联地图、赛事、战队与直播。
- 赛事：赛事列表、24小时比赛预告和支持等级多选的赛事结果。
- 视频直播：聚合 Bilibili、斗鱼、抖音、Twitch、YouTube、Kick 等来源，并显示关联玩家天梯分数。
- 民族资料：民族统计、科技树、开局指南和更新汇总。
- 猜一把：猜选手与猜民族，支持拼音输入、分层提示、计时与成绩展示。
- 录像分析与反馈区。

## 技术结构

项目是一个以 Node.js 为核心的服务端与静态前端应用：

```text
server.js                 HTTP API、缓存和定时任务入口
server/                   实时状态、资料、缓存及平台服务
public/                   页面、样式和浏览器端逻辑
public/guess/             猜一把游戏
config/                   媒体、监听池和科技树补充配置
map/                      玩家、直播、社交与名称映射
tools/                    测试、同步、运维和数据处理脚本
.cache/                   运行时缓存与浏览器状态（不提交）
```

主要上游包括 World's Edge 天梯/对局服务、AoE2 Companion 数据与 WebSocket、Liquipedia MediaWiki API、AoE2Recs资料页，以及各直播和视频平台的公开页面或接口。页面优先读取本站缓存，避免把上游延迟直接传递给用户。

## 环境要求

| 依赖 | 建议版本 | 用途 |
| --- | --- | --- |
| Node.js | 22.x | Web服务、WebSocket、定时任务和 `node:sqlite` |
| npm | 10.x或更高 | 安装锁定依赖 |
| Google Chrome/Chromium | 与 Playwright兼容 | AoE2Recs资料读取及可选浏览器任务 |
| Python | 3.10或更高 | 可选的直播平台工具 |
| Nginx、systemd | 生产环境可选 | HTTPS反代与进程守护 |

Node依赖由 `package-lock.json` 锁定，主要包括 `undici`、`playwright`、`hyparquet` 和 `hyparquet-compressors`。

## 本地运行

```bash
git clone https://github.com/irelia97/aoe2de-cn.git
cd aoe2de-cn
npm ci
npm start
```

默认监听 `127.0.0.1:3000`，访问 <http://localhost:3000>。

首次启动会创建 `.cache/`，并按需准备玩家资料索引及其他缓存。首次可用时间取决于网络、上游状态和磁盘性能。

## 配置

常用文件：

- `config/players_pool.txt`：实时对局监听选手池。
- `config/media.js`：媒体来源与视频配置。
- `map/aoc-selected-streamers.json`：直播检测玩家、账号和房间。
- `map/aoc-player-links.json`：资料页社交与直播链接。
- `public/guess/data.js`：猜一把题库及提示资料。

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP端口，默认 `3000` |
| `PROFILE_REFRESH_NOW=1` | 启动时立即刷新玩家索引 |
| `MEDIA_VIDEO_RESET=1` | 重置视频采集调度状态 |
| `BILIBILI_COOKIE` / `BILI_COOKIE` | Bilibili请求Cookie |
| `HTTPS_PROXY` / `https_proxy` | 可选上游代理 |
| `SITE_STATS_EXCLUDED_IPS` | 不计入站点统计的IP列表 |
| `AOE2_CIV_STATS_DB` | 民族统计数据库路径 |

`.cache/` 可能包含缓存、Cookie、浏览器会话和运行状态，不得提交到仓库或公开分发。

## 缓存与刷新

- AoE2Recs账号、曾用名和统计资料采用15天缓存，过期后按需通过服务器真实Chrome更新；请求全局串行且至少间隔3秒。
- 直播状态每2分钟检测一次；直播区和实时对局直播列共享同一份在线缓存。
- 榜单头像每日预热，页面切换优先读取本站缓存。
- Liquipedia战队名单按日同步，失败时继续使用最近一次成功快照。
- 最近100场在进入资料页时一次取得，前端每次显示20场。

上游403、验证码、限流或超时不等同于本站服务故障。实现应优先保留已有缓存，并在状态文案与日志中区分“未收录”“暂不可用”和“需要验证”。

## 测试

项目测试位于 `tools/test-*.mjs`，使用Node内置测试运行器：

```bash
node --check server.js
node --check public/app.js
node --test tools/test-live-notifications.mjs
node --test tools/test-realtime-queue.mjs tools/test-realtime-socket-groups.mjs
git diff --check
```

修改哪一部分就运行对应测试；实时状态、缓存门禁、资料导航和平台解析均有独立测试。涉及页面布局时还需在桌面与移动宽度实际检查。

## 生产部署

当前生产环境使用：

```text
主机：root@103.42.182.205
目录：/opt/aoe2de-cn
服务：aoe2de.service
域名：https://aoe2cn.cc
```

常用检查：

```bash
cd /opt/aoe2de-cn
systemctl status aoe2de.service
journalctl -u aoe2de.service -f
curl -fsS http://127.0.0.1:3000/api/internal/health
curl -fsS http://127.0.0.1:3000/api/realtime/status
```

生产目录可能包含尚未提交的已部署改动。发布前必须比较本地、服务器和Git状态，只上传本次验证过的文件。部署不代表可以提交或推送；Git操作必须取得维护者的明确授权。

详细运维历史、当前例外规则和接手检查清单见 [HANDOFF.md](HANDOFF.md)。

## 数据与账号安全

- 不提交 `.cache/`、Cookie、二维码、Chrome用户目录、登录会话、SSH密钥或服务端数据快照。
- 不自动绕过验证码；AoE2Recs真实浏览器需要重新验证时，由维护者在服务器会话中人工完成。
- 对公开上游保持缓存、限速和失败退避；不要用高频轮询替代事件或缓存。
- 涉及直播弹幕、账号登录和外部消息发送的服务默认保持当前运维状态，不因普通网站部署自动启用。
