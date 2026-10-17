# AOE2DE-CN（帝国天梯）

面向《帝国时代 II：决定版》中文玩家的数据站。项目聚合天梯、玩家资料、近期对局、实时对局、视频直播和版本更新文章，并通过服务端缓存降低对上游接口的请求压力。

## 主要功能

- 1v1、团队、死亡竞赛和帝国战争天梯榜单
- 玩家搜索、资料、分数、排名、近期对局和模式统计
- 通过 AoE2 Companion WebSocket 展示大厅及正在进行的对局
- B站、斗鱼、抖音、Twitch 和 YouTube 直播信息
- B站视频与“更新汇总”文章缓存
- 指定选手开始新对局时，向斗鱼或 B站直播间发送对局弹幕
- Windows 与 Ubuntu 均可运行

## 运行环境

| 依赖 | 建议版本 | 用途 |
| --- | --- | --- |
| Node.js | 22.x | Web 服务、定时任务、WebSocket；项目使用 `node:sqlite` |
| npm | 10.x 或更高 | 安装 Node.js 依赖 |
| Python | 3.10 或更高（线上为 3.12） | 直播平台登录与弹幕发送 |
| Chromium | 与 Playwright 配套 | B站页面抓取、斗鱼/B站弹幕操作 |
| Git | 当前稳定版 | 获取和更新代码 |
| Nginx | 可选，线上建议使用 | HTTPS 和反向代理 |
| systemd | 可选，Ubuntu 线上建议使用 | 守护 Node.js 服务 |

### Node.js 依赖

依赖由 `package.json` 和 `package-lock.json` 锁定：

- `undici`：HTTP、代理和 WebSocket 客户端
- `playwright`：浏览器自动化
- `hyparquet`：读取 AoE2 Companion 的 `profile.parquet`
- `hyparquet-compressors`：Parquet 压缩格式支持

### Python 依赖

依赖记录在 `tools/requirements-live-danmaku.txt`：

- `playwright>=1.49,<2`

## 安装

```bash
git clone https://github.com/irelia97/aoe2de-cn.git
cd aoe2de-cn
npm ci
```

Ubuntu 24.04：

```bash
python3 -m venv .venv-danmaku
./.venv-danmaku/bin/pip install -r tools/requirements-live-danmaku.txt
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright"
npx playwright install --with-deps chromium
./.venv-danmaku/bin/python -m playwright install chromium
```

Windows PowerShell：

```powershell
py -m venv .venv-danmaku
.\.venv-danmaku\Scripts\python -m pip install -r tools\requirements-live-danmaku.txt
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.cache\ms-playwright"
npx playwright install chromium
.\.venv-danmaku\Scripts\python -m playwright install chromium
```

## 配置

- `config/media.js`：视频主、直播间和视频白名单
- `config/players_pool.txt`：实时对局监听选手池
- `server.js` 中的 `watchers`：对局弹幕通知的选手、平台及目标房间
- `.cache/bilibili-cookie.txt`：可选的 B站 Cookie；也可通过 `BILIBILI_COOKIE` 环境变量提供
- `.cache/danmaku/`：斗鱼/B站登录会话与弹幕去重状态

常用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | HTTP 监听端口，默认 `3000` |
| `BILIBILI_COOKIE` / `BILI_COOKIE` | B站请求 Cookie |
| `HTTPS_PROXY` / `https_proxy` | 可选的上游 HTTPS 代理 |
| `BILIBILI_CHROME_PATH` | 可选的 Chromium 可执行文件路径 |
| `PROFILE_REFRESH_NOW=1` | 启动时立即刷新玩家资料索引 |
| `MEDIA_VIDEO_RESET=1` | 重置视频抓取调度状态 |

`.cache/` 保存运行时缓存、玩家索引和登录状态，已被 Git 忽略。不要提交 Cookie、二维码、浏览器会话或其他账号凭据。

## 启动

```bash
npm start
```

默认访问地址为 [http://localhost:3000](http://localhost:3000)。生产环境建议使用 systemd 保持服务运行，再由 Nginx 将域名和 HTTPS 请求反向代理到 `127.0.0.1:3000`。

首次运行会在 `.cache/` 中创建缓存，并按需下载 `profile.parquet`、建立玩家索引。首次准备时间取决于服务器网络和磁盘性能。

## 直播弹幕登录与测试

先激活 Python 虚拟环境：Ubuntu 使用 `source .venv-danmaku/bin/activate`，Windows PowerShell 使用 `.\.venv-danmaku\Scripts\Activate.ps1`。

```bash
# 登录；无桌面服务器可加 --headless-qr
python tools/live_danmaku.py --platform bilibili login --headless-qr
python tools/live_danmaku.py --platform douyu login --headless-qr

# 检查登录会话
python tools/live_danmaku.py --platform bilibili check --room 22751576

# 发送测试弹幕
python tools/live_danmaku.py --platform bilibili send --room 22751576 --message "TEST BOT"
```

斗鱼单条弹幕限制为 50 字，B站限制为 80 字。实时通知会自动分段，使用 `matchId` 去重，并在首次失败后最多重试 3 次。

## 数据来源

项目使用 World's Edge 天梯服务、AoE2 Companion 数据与 WebSocket，以及所配置直播/内容平台的公开页面或接口。所有缓存与定时任务均由服务端统一维护，浏览器页面主要读取本站缓存接口。
