# AOE2DE-CN 项目交接文档

更新时间：2026-10-17（北京时间）

## 1. 项目与线上环境

- 线上地址：https://aoe2cn.cc
- 服务器：`root@103.42.182.205`
- 应用目录：`/opt/aoe2de-cn`
- systemd 服务：`aoe2de.service`
- Git 分支：`main`
- 当前线上代码以服务器仓库为准，不要用本机旧代码覆盖服务器版本。

最新提交以 `git log -1 --oneline` 和 `origin/main` 为准。

## 2. 最近完成的功能

- 赛事列表按开始时间排序。
- 已结束赛事按结束时间倒序排列。
- 赛事国家/地区筛选下拉框按等级优先显示赛事，并将中国、中国台湾、中国香港排在前面。
- 国家/地区筛选内部值保持 `CN`、`TW`、`HK`；显示名称为“中国”“中国台湾”“中国香港”，下拉框不再显示地区缩写图标。
- 赛事卡片中的国家标识已恢复。
- “赛事滚动”和“X秒后刷新”文字已移除，但后台自动刷新仍保留。
- “更新汇总”侧边栏图标已替换为文档列表样式。
- 网页 favicon 和移动端图标使用侧边栏的 `public/assets/brand-feast.png`。
- 模块背景图使用动态随机分配，8 个模块在同一轮中不重复。

## 3. 常用运维命令

```bash
cd /opt/aoe2de-cn
systemctl status aoe2de.service
systemctl restart aoe2de.service
journalctl -u aoe2de.service -f
```

重启后检查服务是否正常：

```bash
systemctl is-active aoe2de.service
curl -I https://aoe2cn.cc
curl -s https://aoe2cn.cc/api/events
curl -s https://aoe2cn.cc/api/tournaments
```

## 4. 代码同步与发布约定

1. 先登录服务器检查：`git status --short --branch`。
2. 以服务器当前代码为基准修改和验证。
3. 修改后运行相关语法检查，例如：

   ```bash
   node --check public/app.js
   node --check server.js
   ```

4. 重启 `aoe2de.service` 并用线上 URL 验证。
5. 只有明确收到“推送”指令时，才执行 `git commit` 和 `git push origin main`。
6. 不要把根目录临时副本、`.before-*` 备份、`.codex-tmp` 文件加入提交。

## 5. 反馈与媒体排查

反馈记录位于：

```text
/opt/aoe2de-cn/.cache/feedback-submissions.jsonl
```

视频抓取日志：

```bash
journalctl -u aoe2de.service --no-pager --all | grep -Ei '风控|暂停视频|返回 HTTP (403|429)'
```

HTTP 403 表示目标视频平台拒绝服务器请求，通常与平台风控、访问频率、Cookie 或 IP 限制有关；它不等同于本站程序崩溃。此前日志确认出现过 B 站风控暂停检测，以及多个视频源返回 HTTP 403，未发现 HTTP 429。

## 6. 重要注意事项

- 线上资源和服务状态以服务器为准。
- 修改 `public/index.html` 或 `public/app.js` 后，如浏览器仍显示旧内容，需要更新查询参数或强制刷新缓存。
- 不要删除 `.cache`，其中包含反馈等运行数据。
- 赛事数据来自 Liquipedia 相关接口，平台返回数据变化可能影响赛事名称、等级和日期解析。

## 7. 录像解析模块（2026-10-17 更新）

- 页面入口：`https://aoe2cn.cc/replay-analysis`，当前静态资源版本 `replay-analysis-v63`。
- 支持浏览器本地解析；玩家资料历史对局的“录像分析”按钮可跳转并触发服务端下载、解析。
- 服务端入口：`/api/replay-analysis?matchId=...&profileId=...`；在独立 worker 中解析，压缩缓存 30 分钟，同一请求共用任务，同时最多解析两场。
- 缓存目录：`/opt/aoe2de-cn/.cache/replay-analysis`，必须归服务账号 `aoe2:aoe2` 所有，不能用 root 创建不可写目录；不要删除整个 `.cache`。
- 对局元数据入口：`/api/replay-match-info?matchId=...`，读取开始时间与服务器位置，查询失败不会阻止录像解析。
- 八张摘要卡片：版本、时长、地图、房间、玩家、北京时间、服务器、地图种子；桌面端 4 列 2 行。
- 地图 ID 59 优先读录像中的地图脚本名。玩家颜色按录像 0–7 编号映射，对话昵称和正文使用相应颜色并适配日夜主题。
- 时间线按 2 分钟合并同类事件，按每组首次实际事件时间定位；同一玩家、建筑、科技 1 秒内的重复研究指令过滤。统计的是排队/研究指令，不能当作实际完成数量。
- “最多队列单位”显示数量前两种；对话区利用卡片剩余高度，昵称列加宽。
- 单位映射：`public/replay-unit-map.json`。科技映射：`public/replay-tech-map.json`，共 1406 个有名称的条目，534 个有图标。
- 科技映射生成：`tools/generate-replay-tech-map.mjs`；游戏数据补充：`config/replay-game-tech-supplement.json`。
- 可用 `tools/export-replay-game-tech-map.py --game-dir <AoE2DE目录>` 从本机游戏只读导出补充映射和图标，依赖 genieutils-py、Pillow，再运行生成脚本。
- 发布时需同时带上 `public/assets/aoe2rec/`、`public/assets/replay-tech-icons/` 和两个映射 JSON。

## 8. 反馈与实时状态界面

- 反馈页右栏通过 `/api/feedback/recent` 显示最新 15 条，按发送时间倒序；仅返回脱敏 IP，内容以纯文本展示，时间为北京时间。
- 提交成功后自动刷新反馈列表；赞助二维码为 `public/assets/feedback-alipay.jpg?v=20261017`。侧边栏“反馈区”位于最下面。
- 实时状态赛事信息和比分能容纳时放一行；换行时第一行左对齐，第二行按第一行宽度居中，窗口调整后重新计算。

本节所列代码与资源已部署。提交时只加入项目源码、必要映射与资源；根目录临时副本、`.codex-tmp/`、`tmp/` 和 `.before-*` 备份不要加入提交。
