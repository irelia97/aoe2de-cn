# AOE2DE-CN 项目交接文档

更新时间：2026-10-17（北京时间）

## 1. 项目与线上环境

- 线上地址：https://aoe2cn.cc
- 服务器：`root@103.42.182.205`
- 应用目录：`/opt/aoe2de-cn`
- systemd 服务：`aoe2de.service`
- Git 分支：`main`
- 当前线上代码以服务器仓库为准，不要用本机旧代码覆盖服务器版本。

当前已推送的最新提交：`8dcae5c 优化赛事国家筛选与更新图标`

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
