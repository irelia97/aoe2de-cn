# 服务端弹幕运行

所有登录、会话检查和发送均在 `/opt/aoe2de-cn` 所在 Linux 服务器执行。不要复制本机登录会话到服务器。

## 登录

```sh
cd /opt/aoe2de-cn
tools/server-danmaku.sh login
```

使用斗鱼 App 扫描服务器生成的 `.cache/danmaku/douyu_login_qr.png`，并在手机确认。脚本等待最多 600 秒，成功后以服务账号 `aoe2` 保存会话。二维码通过 SSH 取回查看，不放到公开网站。

## 验证和发送

```sh
tools/server-danmaku.sh check 753676
tools/server-danmaku.sh status
# 以下命令会实际发送一条弹幕，仅在需要时运行：
.venv-danmaku/bin/python tools/douyu_direct_danmaku.py --room 753676 --message 'test1'
```

## 自动发送

自动通知由独立 `aoe2-background.service` 常驻执行，已启用开机启动和异常重启；不需要保持 SSH 连接或另开定时任务。配置在 `server/background-worker.js` 的 `createRealtimeDanmakuNotifier`，发送规则在 `server/services/realtime-danmaku-notifier.js`。

- Profile 197964：斗鱼 753676。
- B站自动发送已停用（2026-10-19）；保留手动管理能力。
- 开局使用当前 `#match` 模板，支持 1v1 和能明确识别为两队的多人对局；两条分别显示对阵/单排分数与地图、模式、服务器。
- 对局结束后解析录像：1v1 发送双方 eAPM 及主播双刃斧、弓锯研究时间；多人局只发送主播两项伐木科技时间。伐木科技内容末尾追加该局主播积分变化，如 `-21分`、`+21分`；大厅局不追加，排位缺少数据时显示“积分未知”。结束状态查询或录像摘要失败后等待 10 秒，仅重试一次；第二次失败后持久化取消该局摘要，不再发送。斗鱼拒绝或发送结果不确定时不重发。
- 自动通知通过 `direct-danmaku-client.js`、`douyu_auto_send.py` 和 `douyu_direct_danmaku.py` 直连发送，不启动浏览器。旧常驻浏览器发送器及其客户端已删除。
- 同一玩家、直播间、对局持久化去重；斗鱼每条最多 60 字，分条共用连接，间隔 10 秒。发送拒绝或结果不确定时停止自动重发，避免重复。
- 命令监听 `douyu-command-listener.service` 与自动通知共用进程间发送锁；监听房间 753676、玩家 197964。`#match` 同局冷却 5 分钟，`#p1`～`#p8` 各自冷却 5 分钟，`#lastmatch` 系列共用 30 秒。
- `live_danmaku.py` 仅保留登录和其他手动管理功能。登录失效后仍需重新扫码。

```sh
journalctl -u aoe2-background.service --since '30 minutes ago' --no-pager | grep '\[danmaku\]'
```

B站管理命令在前面增加 `DANMAKU_PLATFORM=bilibili`。登录文件及去重状态位于 `.cache/danmaku/`，不要删除该目录或提交其内容。脚本以 root 调用时自动切换到 `aoe2`，保证登录会话和运行服务使用同一账号。

- Profile 226575：斗鱼 1029928，仅响应弹幕指令，不配置开局/结束自动通知。独立服务 `douyu-command-listener-1029928.service`，随开机启动；指令和冷却规则与 753676 相同，两房间独立冷却，共用发送锁。
- `#p1`～`#p8` 的示例：`Hoang, 来自越南, 1v1 2466, 组排 1727, 近期最爱蒙古43场`。
- `#score` 仅在正在进行的 1v1 随机地图、团队随机地图或大厅局中回复该类型最近 10 局已结束对局的统计，每次一条。如 `1v1, 7胜3负, 2918->2788`、`组排, 4胜6负, 2031->2003`、`大厅局, 6胜4负`。无进行中对局或当前为其他排位模式时不回复。积分从最早一局赛前到最新一局赛后，大厅局不显示积分；排除直播中和已中止对局，不足 10 局按实际场数，缺少结果/积分显示未知，无历史显示“暂无对局”。独立冷却 5 分钟，成功发送后计时。开发测试禁止向直播间发送测试弹幕。
- 新房间服务文件保存在 `tools/systemd/douyu-command-listener-1029928.service`；复制到 `/etc/systemd/system/` 后运行 `systemctl daemon-reload` 和 `systemctl enable --now douyu-command-listener-1029928.service`。

- 网站和后台任务已分离；Yo 指令监听已改为正式开机服务，运维与备份见 `tools/RELIABILITY.md`。
