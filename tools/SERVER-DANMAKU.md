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
tools/server-danmaku.sh send 753676 'test1'
```

## 自动发送

自动监听由现有 `aoe2de.service` 常驻执行，已启用开机启动和异常重启；不需要保持 SSH 连接或另开定时任务。配置在 `server.js` 的 `createRealtimeDanmakuNotifier`，发送规则在 `server/services/realtime-danmaku-notifier.js`。

- Profile 197964：斗鱼 753676。
- Profile 226575：斗鱼 1029928。
- B站自动发送已停用（2026-10-19）；保留手动管理能力。
- 发现新的、尚未结束/放弃且玩家数量恰好为 2 的对局后（不限模式），发送选手及分数、对手及分数、地图和服务器。
- 同一玩家、直播间、对局持久化去重；斗鱼每条最多 50 字，B站 80 字，拆分间隔 2 秒。
- 每段失败间隔 5 秒重试，最多 3 次；全部失败写日志。登录失效后需要重新扫码，不能自动绕过手机确认。

```sh
journalctl -u aoe2de.service --since '30 minutes ago' --no-pager | grep '\[danmaku\]'
```

B站管理命令在前面增加 `DANMAKU_PLATFORM=bilibili`。登录文件及去重状态位于 `.cache/danmaku/`，不要删除该目录或提交其内容。脚本以 root 调用时自动切换到 `aoe2`，保证登录会话和运行服务使用同一账号。
