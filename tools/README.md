# 运维和开发工具

2026-11-18 核对了生产 systemd 定时器和服务状态。部署路径保持原样。

| 类别 | 入口 |
|---|---|
| 实时检测池 | `aoe2-realtime-pool.timer` 调用 `scripts/refresh-realtime-pool.mjs` |
| 民族统计 | `aoe2-civilization-stats.timer` 调用 `tools/update-civilization-stats.py` |
| 健康检查和备份 | `aoe2-site-health.timer`、`aoe2-site-backup.timer` 调用安装于 `/usr/local/libexec` 的工具，源码为 `tools/site-health.py` 和 `tools/backup-site.py` |
| 长驻服务 | 主站、后台任务和 AoE2Recs 浏览器是独立服务。两个斗鱼监听服务已安装，当次核对均未运行 |
| 构建与导入 | `build-*`、`generate-*`、`export-*` 用于构建或导出数据，`import-*` 用于内容导入 |
| 测试 | 在仓库根目录运行 `node --test tools/test-*.mjs`，浏览器用例需要允许访问测试用本机 HTTP 服务 |
| 历史迁移 | `tools/migrations/` 按单次发布或构建编号保存。运行前确认目标数据版本 |

`systemd/`、`nginx/`、`fail2ban/` 和 `ssh/` 存放运维配置。`config/` 和 `map/` 存放业务配置。业务缓存和部署回退副本位于 `.cache/`。
