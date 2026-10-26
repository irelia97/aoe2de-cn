# 清理前检查记录

以下为清理前的审计快照；所列行号与容量对应清理前版本。后续清理结果见 cleanup-20261026.md。

# 文件与代码清理检查（2026-10-26，北京时间）

检查范围：本机工作区 `E:\Codex_Project\AOE2DE-CN`、服务器应用 `/opt/aoe2de-cn`，以及已安装服务的路径引用。本次没有删除文件、修改业务代码或重启服务。

## 已确认的历史文件与生成物

| 位置 | 规模 | 结论 |
|---|---:|---|
| 服务器根目录 `app.js`、`index.html`、`styles.css` | 约412 KiB | 2026-10-17的旧副本；当前网站从public目录读取，未发现服务配置引用这些根目录文件 |
| 服务器根目录3份 `server.js.bak-20261014-*` | 约406 KiB | 旧手工备份，未发现运行入口引用；与上述副本合计837,755字节 |
| 服务器 `.codex-tmp/` | `du`约94 MiB | 临时脚本、截图、日志、旧部署副本；未发现当前systemd/Nginx/cron配置或临时进程引用。可按批次清理，最近回退副本可单独保留 |
| 本机 `.codex-tmp/` | 687文件，约67.54 MiB | 调试与交付检查生成物，不属于项目源码 |
| 本机 `output/imagegen/` | 2张原图，约3.80 MiB | 红色诸葛弩、圣骑士的生成原图；运行页面使用public内处理后的图标，不依赖原图。output尚未加入.gitignore |
| 两边 `public/assets/paladin-icon-v1-{32,180,512}.png` | 合计463,717字节 | 当前代码未引用的候选图标；现用favicon为红色诸葛弩。可作为废弃设计资源候选，不涉及现用品牌图 |

上述临时目录总量按不同机器分别统计，没有将开发机缓存或服务器业务数据计入可清理空间。

## 生产源码中没有发现调用方的代码

以下结论基于生产JS/HTML全量名称引用扫描、入口路径核对及相关实现阅读，不等同于长期运行覆盖率证明。后续删除应按功能块回归，不做批量正则删除。

- `server.js:512`：`parseBilibiliArticlePage`；当前文章链路使用API解析。
- `server.js:535`：`fetchBilibiliArticlePageViaBrowser`，没有调用方。
- `server.js:957`：`mediaVideoSuccessDelay`，旧成功轮询间隔算法；当前使用固定轮次。
- `server.js:1645`：`importProfileCsv`，旧CSV导入路径；当前刷新使用Parquet。它的专属`parseCsvLine`、`createReadStream`、`createInterface`需随整块核对。
- `server.js:1873`：`worldsEdgeMatchTypes`；`server.js:1879`：`worldsEdgeCivilizations`，旧接口映射数组。
- `public/app.js:516`：`profileTableLoadingMarkup`。
- `public/app.js:643`：`formatProfileDate`。
- `public/app.js:1656`：`replayFindPoints`。
- `public/app.js:1922`：`replayDrawMap`，旧坐标点绘制函数；当前地图用`public/replay-map.js`。
- `server/services/profile-service.js:3`：局部变量`const fetch = globalThis.fetch`没有使用，当前调用注入的共享网关。
- `public/replay-building-glyphs.js`：全文件未发现导入方，导出的`drawBuildingGlyph`也无调用方。
- `public/replay-terrain-colors.js:138`：`replayObjectColors`导出未发现使用方；这个模块的`replayTerrainColors`和`replayFishObjectIds`仍被地图使用，不能整文件删除。

## 旧运维脚本：建议归档前确认用途

- `tools/refresh_profile_csv.py`：未发现生产入口引用，硬编码本机Windows路径与CSV总长度756,466,662字节，属于旧一次性导入工具；不应作为当前通用刷新入口。
- `tools/douyu_direct.py`：未发现生产入口引用，保留了浏览器刷新loginreq的旧发送方式；当前自动发送使用`douyu_auto_send.py`与`douyu_direct_danmaku.py`。是否保留为手动排障备用，应与纯死代码分开决定。

## 必须保留的内容

- 不能把Git未跟踪文件认定为垃圾：民族统计、反馈点赞、录像映射和多份运维配置都包含已部署但尚未提交的成果。
- 服务器`.cache/`约1.6 GiB包含当前资料索引、头像/历史对局缓存、反馈SQLite、登录凭据和浏览器运行依赖，不能整体删除。
- `/var/lib/aoe2-match-data/`是业务数据，不在本次清理范围；`stats/civilization-stats.before-trend-20261026.sqlite`仍是最近结构迁移回退库。
- `live_danmaku.py`、`server-danmaku.sh`仍用于扫码登录与手动管理。
- `check-bilibili-updates-browser.py`由`server.js`调用，并导入`bilibili_browser_tags.py`，两者都有实际用途。
- 自动弹幕48小时暂停仍有效，恢复时间为2026-10-28 03:30:49北京时间；检查过程没有改变暂停状态。

## 引用完整性与建议顺序

本次检查的94处字面量本地模块/worker引用均存在目标文件。该检查不覆盖所有动态拼接的资源地址或外部网络资源，因此不代表所有资源都已逐个验证。

建议顺序：先清理旧根目录副本及较早临时生成物；再按功能块移除未调用代码并运行相关回归；最后决定旧运维脚本的归档。最近的部署回退副本单独保留，避免和普通截图日志一同处理。
