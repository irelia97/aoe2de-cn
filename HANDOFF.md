# AOE2DE-CN 交接指南

更新于 2026-11-18（北京时间）。以下区分本地工作树、已发布代码和验收结果。更早的变更记录可用 `git show 70abe70:HANDOFF.md` 查阅。

## 生产与发布

| 项目 | 当前记录 |
|---|---|
| 站点 | [aoe2cn.cc](https://aoe2cn.cc/) |
| 本地工作区 | `E:\Codex_Project\AOE2DE-CN` |
| 生产目录 | `/opt/aoe2de-cn` |
| HTTP | Nginx 对外提供 HTTPS，反代主站 `127.0.0.1:3000` |
| 服务 | `aoe2de.service`、`aoe2-background.service`、`aoe2recs-browser.service`，本次核对均为 active |
| 生产 Node.js | `v22.23.3` |
| 定时任务 | 实时检测池、民族统计、站点健康检查、站点备份，入口见[工具目录](tools/README.md) |

主站近期部署包含玩家资料路由、玩家资料与实时对局页面脚本拆分，以及媒体调度和状态存储拆分。部署使用当前生产文件作为基线，按文件合入改动。因此，工作树、Git HEAD 和生产可能各有独立改动。

发布前检查本地 `git status --short`，比对要发布的生产文件，备份到生产 `.cache/deploy-backups/`。先发布新增依赖，再替换引用它们的入口。JS 文件运行语法检查，修改后端才重启主站。等待 HTTP 监听实际就绪后，再测接口和浏览器页面。失败时用本批备份恢复受影响文件。线上已有 `pages-media.Xizubz` 等按批次保存的备份，使用前核对适用范围。

部署、Git 提交和推送分别授权。提交和推送须有明确指令。

## 当前业务规则与排查入口

### 玩家资料

- `public/profile-page.js` 管理资料、别名、活跃时段与近期对局。账号统计和对局请求并行，首屏对局绘制最多等待账号的首次响应约 400 毫秒。
- 近期对局先加载最多 100 局的快照，先显示 20 局，按 20 局展开，再检查最新一局。空缓存、后台刷新和旧结束状态校正有独立路径。
- AoE2Recs 成功资料缓存 15 天。正常查询共用串行请求门禁；上游失败时保留已有账号或统计缓存，并区分未收录、正在补取和暂时不可用。页面保留低频重查，后台重试遵守冷却。
- 从 `/api/profile-accounts?id=11505386` 检查 `status`、`partial`、`insights`。生产浏览器或上游出现验证提示时，检查浏览器服务、资料缓存和请求门禁日志。会话资料和 Cookie 留在服务器。

### 实时对局与赛事

- `server/services/realtime-service.js` 处理 AoE2 Companion 队列、大厅和比赛事件。核对时 `/api/realtime/status` 显示 149 个检测账号、12 条连接。这些值随池和连接状态变化。
- 页面约每 1.5 秒检查数据版本。离页取消实时请求，返回后恢复轮询。不变的数据只更新卡片时间。诊断时对照 `[realtime-trace]` 中的上游事件与站点状态发布时间。
- 未来 24 小时预告和正在进行中的赛事按 `public/realtime-schedule.js` 筛选。S/A 级、至少一名选手来自中国大陆或港澳台、至少一名选手位列赛事积分前 32，满足任一项即可。前 32 使用每日缓存。赛事展示保留实际等级，Showmatch 显示「表演赛」，未知显示「未定级」。
- Liquipedia 共享队列保留至少 **31 秒**的请求间隔。赛事列表、赛程和结果各有数据路径。单场漏报时先看上游条目和缓存更新时间，再检查本地过滤。

### 直播和视频

- 直播区与实时对局直播列共用媒体在线缓存。直播约每两分钟刷新，单源最长 30 秒、整轮最长 90 秒。单源超时可短期保留该源旧状态。
- 视频轮次按北京时间调度。查看 `.cache/media-video-state.json` 的 `nextRequestAt`、`cycleActive`、`cycleSeen`，结合日志里的 `video source checked`、`video source failed` 和 `video cycle complete` 确认进度。HTTP 200 但动态列表为空会记作 `empty_response`，仍可显示旧视频缓存。
- 本批验证了模拟完整轮次、生产页面和直播刷新。部署后的真实视频整轮结束尚无验收记录。
- 两个斗鱼命令监听服务（753676、1029928）本次核对均为 inactive。按既有约定保持停用。AoE2Recs 批量前 2000 抓取仍暂停，单个资料查询保留。

## 验收与遗留事项

- 最近一次全量 Node 回归及 Chrome 复测合计 228 项，226 项通过。科技别名映射（「弩匣」「重弩」）与跨组取消后未取消玩家回队列的断言两项失败，用户已要求暂缓。
- 螳螂的两个抖音直播源和实时检测池条目已从生产配置剔除，实时服务也会过滤旧池缓存中的已知关联账号。发布后已核对直播配置、检测池来源配置与实时接口。发布回退目录为 `.cache/deploy-backups/consolidated-release.IYNcs8`。
- 媒体和页面拆分后的生产验收已覆盖玩家资料、实时对局与视频页面渲染，及媒体、赛事和实时聊天接口。
- 其他本地未提交改动以 `git status --short` 和逐文件线上比对为准。

## 接手时的检查

```sh
systemctl is-active aoe2de.service aoe2-background.service aoe2recs-browser.service
journalctl -u aoe2de.service --since '15 minutes ago' --no-pager
curl -fsS http://127.0.0.1:3000/api/realtime/status
curl -fsS http://127.0.0.1:3000/api/media -o /dev/null
curl -fsS 'http://127.0.0.1:3000/api/profile-accounts?id=11505386' -o /dev/null
```

域名连接失败时分别验证主站本地端口、Nginx 的 HTTPS 虚拟主机及外部网络路径。上次排查曾在本地代理路径复现短暂建连超时，直连同时正常。以本次实测定位故障层。
