# AOE2DE-CN · 帝国天梯

[aoe2cn.cc](https://aoe2cn.cc/) 是面向《帝国时代 II：决定版》中文社区的数据站。站点提供天梯、玩家资料与近期对局、实时观战与聊天、赛事预告和结果、直播与视频、科技树、民族统计、录像分析及「猜一把」。

## 本地运行

安装 Node.js 22 和 npm，在仓库根目录运行：

```sh
npm ci
npm start
```

访问 [本机网站](http://127.0.0.1:3000/)。主站默认监听 `127.0.0.1:3000`，可用 `PORT` 修改。首次运行需要准备索引和缓存。依赖上游、后台进程、浏览器或外部数据库的功能，需要分别配置对应服务。录像分析和弹幕后台的入口为 `server/background-worker.js`，默认监听 `127.0.0.1:3001`。Python 依赖按工具对应的 requirements 文件安装。

## 代码结构

| 位置 | 职责 |
|---|---|
| `server.js` | HTTP 入口、路由注册、服务组装及站点任务启动 |
| `server/routes/profile.js` | 玩家基本资料、账号、对局和天梯榜单 API |
| `server/services/` | 实时对局、数据源访问、缓存、赛事、录像及媒体业务 |
| `server/background-worker.js` | 独立的录像分析和弹幕任务进程 |
| `public/index.html`、`public/app.js` | 页面壳、路由与共享前端代码 |
| `public/profile-page.js`、`public/profile-leaderboards.js` | 玩家资料页面、榜单加载 |
| `public/realtime-page.js`、`public/realtime-polling.js`、`public/realtime-card-format.js` | 实时状态表、卡片、聊天、赛事预告和轮询 |
| `public/tech-tree-data/`、`public/guess/` | 科技树生成数据和猜题页面 |
| `config/`、`map/` | 采集源、监听池、账号关联及游戏数据配置 |
| `scripts/`、`tools/` | 定时作业、数据构建、历史迁移、测试和运维配置 |

页面脚本按 `index.html` 的顺序加载，资料页和实时对局仍与共享入口共用部分页面状态与工具函数。修改前端文件时留意脚本加载顺序和 URL 版本参数。

## 常用配置

- `config/players_pool.txt` 是实时检测池的来源。定时脚本生成 `.cache/realtime-profile-pool.json`，主站使用生成后的池。
- `config/media.js` 管理媒体来源。 `map/aoc-selected-streamers.json` 管理参与直播检测的主播与房间，`map/aoc-player-links.json` 管理玩家资料页上的账号和链接。
- `server/services/media-scheduler.js` 管理视频轮次、重试和直播刷新。 `media-video-state.js` 负责调度状态读写与旧格式迁移。
- `AOE2_CIV_STATS_DB` 可指定民族统计库路径。`PROFILE_REFRESH_NOW=1` 和 `MEDIA_VIDEO_RESET=1` 用于有意执行的刷新或重置，常规启动沿用缓存。

`.cache/` 包含运行数据、数据库、浏览器状态和可能的凭据。将它作为私有运行目录管理。 `.codex-tmp/` 用于临时诊断和部署比对，`output/` 用于导出产物。

## 测试

```sh
node --check server.js
node --check public/app.js
node --test tools/test-profile-loading.mjs tools/test-profile-match-pagination.mjs
node --test tools/test-realtime-polling.mjs tools/test-media-scheduler.mjs tools/test-media-video-state.mjs
git diff --check
```

在 Bash 中可用 `node --test tools/test-*.mjs` 启动全量 Node 回归。在 PowerShell 中用 `$tests = Get-ChildItem tools/test-*.mjs | ForEach-Object FullName; node --test @tests`。浏览器测试需要能访问测试用的本机 HTTP 服务，并安装 Playwright 对应浏览器。支持 `PLAYWRIGHT_CHANNEL` 的用例可指定已安装的 Chrome。

运维工具和定时任务见[工具目录](tools/README.md)，生产操作和待办见[交接指南](HANDOFF.md)。
