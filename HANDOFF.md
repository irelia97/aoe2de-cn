# AOE2DE-CN 项目交接文档

更新时间：2026-10-26（北京时间）

优先阅读第 10 节（2026-10-26 最新交接）。第 1～9 节保留为历史记录；其中的房间号、服务、算法、图标和缓存版本可能已过期，冲突时以第 10 节及实际运行文件为准。

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

## 9. 最新交接：斗鱼直连发送与命令监听（2026-10-23）

### 9.1 当前正在运行的命令监听

- **仅监听斗鱼房间 `9037973`**；之前测试的 `1126960` 已停止监听。
- 观众发送 **`#match`**，回复 **`菜比`**。消息会先去除首尾空白，再精确匹配；`!match`、`#match xxx` 和其他命令均不触发。
- 任意用户均可触发，但忽略机器人自身账号的消息；按弹幕 `cid` 去重，保留最近 5000 个命令消息 ID。
- 当前运行参数为 **3 秒全局回复冷却**；冷却期间的命令直接忽略，不排队。冷却、去重记录仅保存在进程内存，进程重启后重置。
- 独立脚本：`tools/douyu_command_listener.py`，没有通过网页、浏览器或主站 `aoe2de.service` 执行。
- 连接 `wss://danmuproxy.douyu.com:8506/`，订阅目标房间弹幕，30 秒心跳；连接失败等待 5 秒重连。识别命令后调用直连发送脚本中的 `send()`。
- 服务账号 `aoe2`，服务名 **`douyu-command-listener.service`**，由 `systemd-run` 建立的 **transient 临时单元**。进程异常退出会重启，但**服务器重启后不会自动恢复此临时单元**；尚未安装永久服务文件。
- 已核实日志出现 `stage=listening, room=9037973, command=#match, dryRun=false`。这说明订阅登录成功；切换后未主动发送命令做端到端触发测试。

查看状态、日志、停止：

```bash
systemctl status douyu-command-listener.service
journalctl -u douyu-command-listener.service -n 50 --no-pager
systemctl stop douyu-command-listener.service
```

需要恢复同样的临时监听时，先确认没有同名单元正在运行：

```bash
systemd-run --unit=douyu-command-listener --uid=aoe2 \
  --property=Restart=on-failure --property=RestartSec=5 \
  --working-directory=/opt/aoe2de-cn \
  /opt/aoe2de-cn/.venv-danmaku/bin/python \
  /opt/aoe2de-cn/tools/douyu_command_listener.py \
  --room 9037973 --cooldown 3
```

### 9.2 不启动浏览器的斗鱼发送方式

- 新增 `tools/douyu_direct_danmaku.py`；服务器已上传同名脚本，依赖现有虚拟环境中的 `websocket-client`。
- 读取 `.cache/danmaku/douyu_storage_state.json` 的既有登录 Cookie，仅借用登录凭据，**不会启动 Playwright/Chromium，不会加载直播间网页**。
- 请求 `https://www.douyu.com/lapi/live/gateway/web/{room}?isH5=1` 获取 WebSocket 地址，认证后发送 `chatmessage`，等待 `chatres` 回执。仍需连接目标房间的弹幕服务，并非完全不连接房间。
- 使用 STT 编码和斗鱼二进制包头，处理中文、转义、多个消息包和不完整包；发送长度限制 1–50 个字符。
- 认证所需字段包含 `acf_uid`、`acf_ltkid`、`acf_stk`、`dy_did`。登录态失效仍需重新登录；不得把 Cookie、登录包或完整存储状态写入日志、文档和 Git。
- `chatres res=0` 表示平台服务端接受；**不能仅凭这一回执断言所有观众都看到消息**。非零拒绝或回执超时不自动重发，避免重复发送。
- 每次 `send()` 建立并关闭一次连接；命令监听接收连接保持常驻，回复发送连接目前尚未复用。
- 协议结构参考 `kbytearray/ordinaryroad-live-chat-client` 的 `DouyuMsgFactory`、`LoginreqMsg`、`ChatmessageMsg` 源码。

单次发送命令示例（会实际发送，只在用户授权后执行）：

```bash
/opt/aoe2de-cn/.venv-danmaku/bin/python \
  /opt/aoe2de-cn/tools/douyu_direct_danmaku.py \
  --room <房间号> --message '<内容>'
```

### 9.3 已完成的测试与实际发送

- `9037973`：已实际发送 `test1`，回执 `res=0`，连接、认证至发送回执耗时约 0.24 秒（不含之前的网关 HTTP 请求）。
- `1126960`：按 10 秒间隔依次发送 `test1`、`test2`、`test3`，均 `res=0`。
- `1126960`：随后按 3 秒间隔依次发送 `卡比`、`？`、`好死`，均 `res=0`。
- 消息编码验证通过：中文、`@`/`/` 转义、分包、多包及非法长度。
- 命令处理验证通过：精确匹配、冷却、重复 ID 过滤、自身消息过滤；最初验证的是 `!match`，随后按用户要求改成 `#match`。
- 如需只验证监听、不自动回复，可执行监听脚本的 `--duration 12 --dry-run`；不要为了检查而擅自发送测试弹幕。

### 9.4 与原有自动弹幕的关系

- **开局/结束自动弹幕仍使用原有常驻浏览器路径，尚未切换直连方式。** 不要误认为上述独立测试脚本已替换生产发送链路。
- 原有文件：`tools/resident_danmaku.py`、`server/services/resident-danmaku-client.js`、`server/services/realtime-danmaku-notifier.js`、`server/services/replay-ended-notifier.js`。
- 原有自动对局通知仅关注 Yo（profile `197964`，斗鱼 `753676`），条件为对局玩家数量恰好为 2；B 站自动发送关闭，Lyx 检测已剔除。
- 命令监听和原有发送器独立运行，当前没有跨进程共用发送冷却锁。

### 9.5 页面改动与代码状态

- 用户要求加入的“月租服务器还剩 22 天，月租 100 元，已有赞助 0 元”及倒计时，随后明确要求**回退，现已撤回并部署**。不要再次恢复。
- “赞助网站运营”按钮和点击展开二维码功能保留。当前前端 JS 缓存版本 `sponsor-revert-v133`，CSS 版本 `mobile-v130`。
- 实时对局按玩家分数降序排列；已移除北冥有鲲 `9958595`，加入 Capoch 主账号 `409748`，不再固定 JorDan 在 TaToH 后面。
- 本机工作区存在多项此前累计的已修改和未跟踪源码、资源；本轮未提交、未推送 Git。两个新斗鱼脚本已同步到服务器，不要用 Git 重置覆盖这些未提交成果。
- 仅修改静态文件时无需重启主服务；本次命令监听独立启停，也没有重启主站服务。

## 10. 最新交接：2026-10-26（优先阅读）

### 10.1 环境、部署与代码状态

- 网站：https://aoe2cn.cc；本机工作区 `E:\Codex_Project\AOE2DE-CN`；服务器 `root@103.42.182.205`，应用 `/opt/aoe2de-cn`。
- SSH 使用本机既有密钥 `C:\Users\22270\.ssh\aoe2cn_server_ed25519`，不要输出密钥、Cookie、登录存储状态或其他凭据。
- `aoe2de.service`：网站，监听 localhost:3000；`aoe2-background.service`：共享上游网关、录像任务及自动通知，监听 localhost:3001。
- 最近核对：网站、后台、两个斗鱼监听服务和民族统计定时器均正常运行。磁盘总量约49GB，使用约11GB，可用约38GB。
- **本机与服务器 Git HEAD 不一致，且两边均有大量已部署但未提交的文件。** 本机最近提交 `e21546c`，服务器 HEAD `7d1094e`；不能据此判定服务器缺少新功能，实际运行的是已同步的工作树文件。不要执行 reset/checkout/pull 覆盖未提交成果。
- 最新本轮没有新增 Git 提交或推送，没有关机。只有用户再次明确要求时才提交、推送或关机。临时文件、数据集、凭据和 `output/` 原始生成图片不应随意加入提交。
- 最新前端版本：`app.js?v=civilization-rows-v156`、`civilizations.js?v=13`、`civilizations.css?v=13`；主样式版本 `feedback-likes-v148`。
- 第9节所说的旧测试房间、回复“菜比”、常驻浏览器发送、临时监听单元等均不再代表当前实现。

### 10.2 民族统计：当前页面行为

- 页面 https://aoe2cn.cc/civilizations，导航位于“玩家资料”下方，名称“民族统计”，使用与整站一致的盾牌统计线框图标。
- 标题说明：“每周更新真实天梯对局，了解民族表现与对位”。
- 支持1v1/团队随机地图、地图、整场平均积分、游戏时长的组合筛选。团队使用组排积分，不使用1v1积分；分数是整场所有玩家的均值。
- 1v1分档：`1100以下`、`1100~1399`、`1400~1699`、`1700~1949`、`1950~2149`、`2150~2399`、`2400以上`；分界值1100、1400、1700、1950、2150、2400。
- 组排分档：`1100以下`、`1100~1399`、`1400~1649`、`1650~1849`、`1850以上`；分界值1100、1400、1650、1850。
- 游戏时长按 `(finished-started)*1.7` 计算，页面统一显示“游戏时长”。排除不足10分钟的对局，正好10分钟保留；筛选项仅为 `10~20分钟`、`20~35分钟`、`35~50分钟`、`50分钟以上`，分界值20、35、50分钟。
- 排除地图空值/unknown/unknow、任一玩家缺分、胜负缺失及队伍结构异常的比赛。没有“积分缺失”或“10分钟以下”筛选，不标记“小样本”。
- 总览只保留“筛选后对局”“出现民族”“数据范围”三张卡片。场数右侧显示该模式内占比，分母为该模式全部有效对局，未筛选时100.00%。
- 数据范围包含完整年份，日期字体20px，空间不足时在两个日期之间换行。
- 两张列表卡片标题区高度一致，表头和第一行数据对齐，每张可见10行，其余内部滚动。行高52 CSS px，标题区132px，表头42px，卡片总高度696 CSS px；整站缩放后屏幕像素可能不同。
- “民族表现”默认胜率降序，点击胜率/使用率/参赛次数切换排序。民族前显示`#排名`，随当前排序更新；提示文案已添加。
- 左侧“查看民族”下拉选择后高亮、定位该民族；切换地图、分档、时长或模式后保留选择并再次定位，没有样本则提示。
- 右侧“民族对位胜率”**不再提供“查看民族”**，跟随左侧选择。只在标题右侧保留“查看对手”下拉框，包含全部对手及具体民族，切换条件保留对手选择。
- 右侧胜率代表左侧所选民族的胜率。例如选中国、对手蒙古显示55%，即中国对蒙古的胜率。团队中表示含中国的队伍对阵含蒙古的敌队时的队伍胜率，不代表单挑胜率。
- 民族胜率按获胜玩家出场次数计算；使用率按该民族玩家席位/全部席位计算。团队对位同队同民族去重；镜像比赛两侧观察合计50%，样本场数按比赛去重。
- 百分数统一小数点后两位：胜率、使用率、模式场数占比、周变化。
- 胜率和使用率右侧显示周变化，例`53.00% +1.00%`，计算为53%-52%=1个百分点，而非相对增长率。本周先统一`+0.00%`。对位胜率也显示变化。
- 比较的是本次和上次周更新后的**累计统计**，使用相同筛选条件。已有周快照但旧版本没有对应样本时显示`—`，不虚构差值。

### 10.3 民族统计：当前数据与磁盘文件

- 当前覆盖 **2026-09-23～2026-10-24，共32个官方日包日期**。尚未执行首次实际自动周更新，不要把演练数据或未来日期发布到线上。
- 有效1v1：686,679场、1,373,358条玩家出场记录；有效组排：379,603场、2,273,564条记录。合计1,066,282场、3,646,922条记录，56个民族。出场记录不是独立玩家数。
- 所有业务数据在服务器 `/var/lib/aoe2-match-data/`，不要下载到本机，也不要放到项目或Git目录。
- 线上查询库 `stats/civilization-stats.sqlite`，约24.9MiB；网站只读查询聚合库，不直接查询全部原始明细。
- 当前累计清洗明细 `processed/2026-09-23_to_2026-10-24/{rm_1v1,rm_team}/{players,matches}.parquet`，共约75.8MiB。保留了统计排除前的有效完整比赛，可重新调整分档、时长口径。
- `players.parquet` 是逐场逐玩家记录，`matches.parquet` 是逐场记录。用matchId关联，保留source_date；原始时间是UTC。
- `raw/` 现在保留28包，2026-09-27～2026-10-24，共约127.6MiB。已在验证清洗明细后清理09-23～09-26的4包，释放19,073,365字节（约18.2MiB）。删除清单和SHA-256在 `reports/raw-retention.jsonl`。
- 更早还按用户授权删除过旧版统计备份、旧目录快照、构建日志及临时核对结果，合计13文件、48.67MiB。不要再依赖已删除的 `stats/civilization-stats.before-v2.sqlite`、`reports/dump-list-snapshot.json`。
- 保留 `reports/download-manifest.json`、`reports/cleaning-report.json`、初始 `reports/verification-report.json`。后者是历史核验记录，不意味着所有旧原始包现在仍存在。
- 独立Python环境 `/var/lib/aoe2-match-data/.venv`，DuckDB 2.0.0。数据目录通常root:aoe2、750，文件640；不要让app失去统计库读权限。

### 10.4 周更新：已改为增量清洗，不依赖旧原始包

- `aoe2-civilization-stats.timer`：每周一北京时间08:00（Asia/Shanghai），Persistent=true。**2026-10-26跳过；首次实际更新2026-11-02 08:00**，拉取10-26～11-01并补齐缺少的10-25。今天不要手动提前发布新数据。
- 定时器在10-26仍会唤醒服务，但脚本首次运行日期守卫返回 `skip_before_first_run`，不下载或更新统计。这已用只读计划和真实服务启动验证，数据库哈希未改变。
- 更新入口 `/opt/aoe2de-cn/tools/update-civilization-stats.py`；清洗模块 `tools/match-data-pipeline.py`；增量合并/校验/保留策略 `tools/incremental-match-data.py`；统计构建器 `tools/build-civilization-stats.py`。
- 仅下载和清洗上次已发布结束日期之后的新日包。历史数据来自保留的累计清洗明细，**不会重新读取或要求所有历史原始包存在**。
- 历史明细校验SHA-256、记录唯一性、完整比赛场数、胜负和队伍结构。旧库没有datasetPath时兼容当前初始目录；有datasetPath/datasetChecksums时按已发布元数据读取和校验。
- 新批次中重复出现已存在比赛时，使用最新通过清洗的完整比赛替换旧比赛的全部玩家；不混合两个版本，不重复计数。跨模式重归类也按比赛ID整体替换。
- 将新明细和历史明细合并后，从累计明细**重算聚合统计**；当前“增量”指下载、清洗和历史明细合并，不是简单给百分数累加。这样仍可调整分档、时长或其他统计规则。
- 更新成功后只保留最近28个已处理日期的原始包，完整累计清洗历史持续保留。保留最近两份自动生成的累计明细目录，初始历史目录另保留。
- 原始包仅在确认清洗明细完整、统计已发布后清理；先写删除审计再删除。历史原始包缺失、跨批次去重和保留边界都有演练覆盖。
- 缺少上周任何日包时暂不发布。下载、清洗、合并或统计失败也保留旧线上库；每小时重试，最多24次启动/两天窗口，接入现有OnFailure告警日志。
- flock锁防止重叠；CPUQuota=100%、MemoryMax=1200M、超时2h。DuckDB临时溢写位于数据根目录work下，适配服务只读系统保护。
- 先构建、核验新库，再原子替换线上库，无需重启网站。上一版元数据、民族统计和对位统计嵌入新库 `previous_*` 表，保证当前与比较快照来自同一次发布。
- 同时保留 `stats/civilization-stats.previous.sqlite` 作为回退。比较时地图、民族用slug对齐，而非可能变化的数字ID；分档口径不兼容时不作比较。
- 成功任务生成 `reports/weekly-latest.json`、`reports/weekly/<运行编号>/`；当前没有真实周发布，不能把临时测试报告当作生产更新记录。
- 服务/定时器源码在 `tools/systemd/aoe2-civilization-stats.{service,timer}`，已安装至 `/etc/systemd/system/` 且timer已启用。
- 更详见 `tools/CIVILIZATION-STATS.md`。数据根目录旧的 `tools/download_and_clean.py` 和 `verify_processed.py` 为历史脚本，新定时任务不使用；旧验证器假设所有原始包存在，不适用于当前保留策略。

常用命令（只读计划不下载、不写入）：

```bash
systemctl status aoe2-civilization-stats.timer
systemctl list-timers aoe2-civilization-stats.timer
journalctl -u aoe2-civilization-stats.service -n 60 --no-pager
/var/lib/aoe2-match-data/.venv/bin/python /opt/aoe2de-cn/tools/update-civilization-stats.py --plan
/var/lib/aoe2-match-data/.venv/bin/python /opt/aoe2de-cn/tools/update-civilization-stats.py --plan --at 2026-11-02T08:00:00+08:00
```

`--prune-raw` 会先校验当前清洗历史，再实际删除28天前已覆盖的原始包，必须确认在用户授权范围内。不要用它替代只读检查。

### 10.5 反馈点赞与赞助文案

- https://aoe2cn.cc/feedback 的每张反馈卡片已有点赞图标、按钮、数量；点赞后显示“已点赞”。
- 每个IP对每张卡片最多一次，由SQLite `(card,ip摘要)` 唯一约束保证，刷新和重启均不重置；IPv4映射和等价IPv6地址会归一化。
- 点赞库 `.cache/feedback-likes.sqlite`，600、aoe2所有；IP用持久化随机密钥的HMAC摘要保存。密钥在库内，不要输出内容。备份活跃SQLite应使用一致性备份接口，不要仅复制正在写入的主文件。
- 旧反馈无需改写，按原始IP、时间、正文计算稳定ID；公开接口只展示脱敏IP。
- `GET /api/feedback/recent` 返回点赞数和当前IP是否已赞；`POST /api/feedback/like` 校验Origin、反馈ID和最新反馈列表，并沿用API限流保护。
- 源码：`server/services/feedback-feed.js`、`feedback-likes.js`、server.js反馈路由、public/app.js及styles.css。
- 赞助按钮左侧“服务器月租0/100元”，右侧最终文案 **“已有0人赞助”**，不要改成中间讨论过的“已收到0人赞助”。
- 测试均用临时数据库或浏览器拦截模拟响应，没有给真实反馈增加测试点赞。

### 10.6 斗鱼与上游请求问题

- `douyu-command-listener.service`：房间753676，监测玩家197964（Yo），命令+自动开局结束通知。
- `douyu-command-listener-1029928.service`：房间1029928，监测玩家226575，仅命令，不自动发开局/结束弹幕。两个监听都是持久systemd服务。
- 命令接收与处理已分离，单独队列工作线程查询、发送，避免I/O期间停止接收；直连发送，复用发送连接，不需要进入直播间网页。
- `#match` 查进行中的实时比赛，支持1v1和完整两队多人对局；两条弹幕间隔10秒。多人示例 `主播(2217/1578/1310/2601) vs 对手(1466/1096/1859/-)`，按颜色顺序，缺分用`-`。只有没有1v1比赛记录才视作缺分，不因天梯不活跃而丢掉现有分数。
- `#p1`～`#p8` 按游戏颜色/玩家编号，支持任意正在进行的对局；国籍显示“来自xx”。具体昵称、积分、近期民族及场数字段以当前脚本format函数为准。
- `#lastmatch`或`#lastmatch1`～`#lastmatch10` 查第N个已结束比赛；结果包含胜负、地图、类型、分数变化及多久前等规则。
- 当前冷却：`#match` 5分钟，`#p1`～`#p8`各自5分钟，`#lastmatch[1～10]`共用30秒，`#score`独立5分钟。精确匹配，不把参数当代码执行。
- `#score` 查近10局，按当前对局类型回复；不要在直播间擅自发测试命令或弹幕。
- 自动结束摘要eAPM仅1v1显示；多人结束仍保留主播伐木科技时间等通知，第二句末尾有上一局分数变化并带“分”。失败后等待10秒最多再试一次，再失败放弃摘要。
- 2026-10-25的`#match`无回复已确认收到命令，但查询等待60秒超时。发现Companion请求通道长期被一个卡住任务占用，其他请求无法发出。
- 已修复 `server/services/upstream-gateway.js`：独立45秒硬时限，网络/响应正文/取消操作卡住均不阻塞通道释放；迟到响应不进入缓存；保留正常共享请求、取消和优先级逻辑。
- `/health` 的upstream现在显示current.path、phase、ageMs、timedOut、lastFailure。历史卡住请求未记录具体地址，不能宣称已还原它的准确URL。
- 修复后真实Yo最新局查询6.48秒成功。没有攻击、流量过大或明确HTTP429限流证据；上游仍可能偶发500或超时，不能承诺不再出现单次查询失败。
- 后台内网健康检查 `curl -s http://127.0.0.1:3001/health`；不要把这个内网诊断接口暴露公网。

### 10.7 其它已部署的重要变更（不要回退）

- eAPM采用用户指定的严格**1000现实毫秒**滑动重复过滤，正常1.7倍速对应1700游戏毫秒；每玩家按指令含义/参数分别去重，重复仍推进窗口，ABAB和ABCABC均适用。生产、研究、交易、变形和切换也适用。网页表格、曲线和结束摘要共用 `public/replay-eapm.js`；详见 `tools/EAPM.md`。
- 纯界面选中、空白点击和切换画面不在有效指令白名单内，不额外虚构首次操作。对象集合排序，排除包长度和冗余selected数量，但保留目标、精确坐标及未知原始字节。
- 地图种子使用录像中经验证的lobby种子字段，不再误读随机数状态。比赛515704975正确种子1355428952；`public/replay-map-seed.js`已补齐与回填缓存。
- 网站favicon是**红色诸葛弩**，资源 `public/assets/chu-ko-nu-red-icon-v1-{32,180,512}.png`、`public/favicon.ico`；侧边栏品牌图仍是原图，不能混淆。
- 头像服务器和用户浏览器24h缓存；服务器每分钟检查到期头像并刷新，并非每次榜单刷新都更新。
- GET录像分析接口只读缓存，未分析时返回需分析状态；新任务由用户点击POST发起，校验同源。分析额度每IP2次/分钟、10次/小时，普通缓存读取和轮询另有限额。
- SSH密钥登录、Nginx敏感路径/方法保护、fail2ban、API来源/爬虫/限流、独立后台、每日备份及健康检查已部署。不要输出登录态或放开敏感目录；详见 `tools/RELIABILITY.md`、`tools/API-PROTECTION.md`。
- 外部JSON上游统一通过后台网关限速、合并和缓存。Companion默认请求间隔3秒，429尊重Retry-After；不要绕开共享网关批量抓取。

### 10.8 其它数据刷新时间（北京时间）

| 项目 | 更新规则 |
|---|---|
| 1v1随机地图榜单 | 每3分钟整刻 |
| 团队随机地图榜单 | 每3分钟，错开1v1的30秒 |
| 1v1死亡竞赛 | 每天03:00、09:00、15:00、21:00 |
| 团队死亡竞赛 | 每天04:00、10:00、16:00、22:00 |
| 1v1帝国战争 | 每天05:00、11:00、17:00、23:00 |
| 团队帝国战争 | 每天00:00、06:00、12:00、18:00 |
| 赛事积分榜 | 每小时05分 |
| 榜单平均分、玩家数量汇总 | 每周一06:00 |
| 玩家资料本地数据集 | 每天14:30，失败每小时重试 |
| 民族统计 | 每周一08:00，首次2026-11-02，10-26跳过 |
| 实时对局 | WebSocket事件；每分钟后台刷新、30分钟周期校验 |
| 实时监测玩家名单 | 每7天；上次核对下一次2026-10-28约21:31 |
| 主播直播状态 | 每2分钟 |
| 视频检查轮次 | 每天08:30、12:01、15:30、18:01、20:00、22:30 |
| 更新汇总文章 | 每12小时，按上次完成时间计算 |
| 赛事信息 | 约每分钟，部分接口为按需缓存 |
| 访问/反馈日报归档 | 每天23:59 |
| 网站备份 | 每天03:20～03:22 |
| 健康检查 | 每分钟 |

最后核对的玩家资料数据集：2026-10-25下载，14:31下载完成、14:33:43索引完成，4,361,146条。每天后续运行可能更新，不能把交接记录当作永久实时状态；查 `.cache/profile-index-current.json` 和服务日志。

### 10.9 验证、发布与后续注意

- 最近服务器全套Node测试 **83项全部通过**。
- `tools/test-weekly-civilization-update.py` **4项通过**：日期跳过/跨周、完整增量流水线及失败不发布/幂等、四周原始包保留边界、跨批次整局替换及明细损坏检测。所有数据在临时目录，不请求上游、不提前更新线上。
- `tools/test-civilization-builder.py` 覆盖分档与时长边界及排除规则；Node民族统计测试验证筛选、模式占比、镜像/团队样本、按slug跨快照计算周变化。
- 点赞测试覆盖持久化、不同连接去重、IPv4/IPv6归一化和旧反馈稳定ID；上游网关测试覆盖挂起fetch、挂起正文/取消、429和迟到响应。
- Playwright已验证桌面1440px和手机390px：选框、条件切换定位、对手选择、百分数两位、周增减模拟、点赞模拟、无横向溢出及两张卡片各10行/首行对齐。模拟周变化和点赞只在浏览器拦截，不修改真实数据。
- 截图/日志位于项目 `.codex-tmp/`，不提交；非必要不重新跑大量测试，不主动发直播间测试弹幕。
- 仅静态文件改动通常无需重启；修改网站服务或worker需重启aoe2de；上游网关修改需重启aoe2-background。不要无理由重启斗鱼监听并重置其内存状态。
- 当前无未完成的本轮页面需求。后续优先关注首次真实周更新是否获取完整日包，以及Companion偶发上游错误；不要为验证提前执行未来日期的数据发布。

## 11. 会话7未完成事项续办（2026-10-26）

- 已完成并上线最后要求：特色单位不再运行时随机配色，改成构建阶段一次随机定色的透明成品 PNG；中国固定4号黄色，同民族所有特色单位统一配色，刷新/切换不改变。
- 配色分配持久化在 `config/tech-tree-portrait-colors.json`；构建 `python tools/build-fixed-portraits.py`，生成149张含升级形态的图片及 `public/tech-tree-fixed-portraits.js`。成品路径 `public/assets/tech-tree/portraits-fixed/<civ>/`。
- 原始RGBA及透明轮廓继续保留供构建；新页面不再下载原始RGBA/配色纹理，不执行浏览器Canvas着色。中国诸葛弩图标编号36、龙舟482，勿把游戏单位ID误当图标文件名。
- 成品图片HTTP缓存7天；科技树JSON固定版本force-cache。线上重复访问实测资料和成品图像0字节网络传输。清缓存后仍需重新下载。
- 外部字体非阻塞加载；字体挂起时页面和图片可初始化。导航分隔线为居中长实线。
- 最新前端版本 app.js=tech-tree-v177，tech-tree.js=11，固定配色模块=1，styles.css=tech-tree-nav-v177，tech-tree.css=7。
- 本地与线上Playwright交互检查通过（含桌面/手机、冷热缓存、字体挂起、中国固定黄色、无配色素材请求）；服务器13项科技树测试全部通过。首次测试发现旧测试要求已弃用配色纹理，已改为核验成品资源后通过。
- 部署前备份服务器 `.cache/deploy-backups/before-tech-tree-fixed-20261026.tar.gz`。仅静态更新，无服务重启，无Git提交或推送。
- 本节覆盖10节之前关于科技树随机配色的旧行为；会话7最后遗留需求均已完成。

### 11.1 视频监控补充（2026-10-26）

- 已添加UP韋恩_WayneChang（3546852691544318）动态页至 `config/media.js` 视频监控源，沿用现有轮次和标题/标签筛选规则。
- 指定视频BV1XYHK68E75已加入视频区，baselineBvid同上，baselinePublishedAt=2026-10-25T11:00:00Z（视频原始发布时间，北京时间19:00）。动态发布记录为11:00:13Z，属于正常13秒差异；基线精确BV仍保留，不回填更早视频。
- 服务器已备份配置和视频/调度缓存至 `.cache/deploy-backups/before-wayne-monitor-20261026.tar.gz`，同步配置及种子视频后重启主站服务。
- 现有调度器已于北京时间14:34:47成功实际检查新UP，failureCount=0，动态快照status=ok，只包含基线视频。API与真实浏览器视频列表均确认卡片存在，封面正常解码。4项动态响应测试通过。

### 11.2 化学跨建筑前置修复（2026-10-26）

- 原上游树link_id只描述绘图/升级连接，火枪手、手推炮、炮舰未提供化学前置，导致详情遗漏。
- `techTreeRelations` 现补充单位5/36/420与炮塔科技64需要化学47，炮塔建筑236需要科技64，并沿升级父链继承科技条件。详情显示可点击的“解锁所需科技”，不改变绘图连线。火药特色单位不泛加化学。
- 波希米亚按其节点显示城堡时代化学，土耳其显示化学免费获得提示。
- 已部署，app.js=tech-tree-v178，tech-tree.js=12；服务器14项科技树测试通过；备份 `.cache/deploy-backups/before-chemistry-prerequisite-20261026.tar.gz`。静态更新，无重启。

### 11.3 独特单位图片黑点清理（2026-10-26）

- 已在 `tools/build-transparent-portraits.py` 清除不超过20像素的8连通孤立碎点，重建148张透明图及149张固定配色图并上线。不是整图去黑色，主体上的深色衣甲和武器保留。素材版本`185872-fixed2`，app.js=tech-tree-v179、tech-tree.js=13。
- 放大复查还发现编号523（格鲁吉亚骑兵图）左侧106像素的孤立三角残片，已对该图单独设置128像素阈值清除。仅该固定配色图使用`185872-fixed3`刷新缓存，其他素材继续用fixed2；app.js=tech-tree-v180、tech-tree.js=14、固定配色模块=3。
- 本地与线上浏览器检查通过，包括火枪手/手推炮/炮舰化学前置跳转、148张浅底总览、缓存与手机桌面。服务器14项科技树测试通过。前一个浏览器脚本时序问题已通过等待图片解码解决；炮舰节点位于海军类别，脚本已切换类别后检查。
- 部署前备份`.cache/deploy-backups/before-portrait-specks-20261026.tar.gz`及`.cache/deploy-backups/before-portrait-speck-523-20261026.tar.gz`。静态文件更新，无服务重启、无Git提交推送。

### 11.4 印加独特单位图片黑点（2026-10-26）

- 印加标题使用单位879图标97，即印加枪长兵的原始肖像。黑点贴在长矛和衣甲轮廓上，上一轮只处理脱离主体的碎片，因此未清除。
- `tools/build-transparent-portraits.py` 仅对编号97应用3×3开运算，并移除接触透明边界、面积不超过20像素的近黑色簇；保留轮廓内阴影纹理。重建透明PNG与固定配色图。
- 仅印加97图使用`185872-fixed4`刷新缓存，其余523号维持fixed3、其他图维持fixed2。app.js=tech-tree-v181，tech-tree.js=15，固定配色模块=4。
- 本地及线上印加页面截图人工核对通过；线上浏览器全流程和服务器14项科技树测试通过。备份`.cache/deploy-backups/before-incas-portrait-clean-20261026.tar.gz`。静态更新，无重启、无Git提交推送。

### 11.5 全部特色单位图片边缘清理（2026-10-26）

- 用户要求检查印加以外图片。已在浅底按8张联系表逐张复查148张透明肖像，重点对羽毛、绳索、兽毛、船帆和细兵器制作旧/试处理对照，确认没有明显主体缺损。
- 已将3×3轮廓开运算及“仅接触透明边界、面积<=20像素的近黑色簇清理”应用至全部148张；原有5张人工轮廓、523号大残片例外继续保留。重建149张按民族固定配色图，不改变民族颜色分配。
- 所有固定配色图缓存版本统一`185872-fixed5`，app.js=tech-tree-v182、tech-tree.js=16、固定配色模块=5。旧fixed2/3/4素材由新URL参数避开缓存，后续可由用户浏览器缓存自然过期。
- 本地及线上浏览器检查通过，含印加/中国图片、重复访问缓存、手机/桌面、所有148张浅底检查总览。服务器14项科技树测试通过。线上两个新版图片URL返回200且缓存7天。
- 备份`.cache/deploy-backups/before-all-portraits-edge-clean-20261026.tar.gz`。静态更新，无服务重启、无Git提交推送。

### 11.6 科技树独特单位、更新文章与整体胜率（2026-10-26）

- 科技树顶部额外收录原始树未标 `unique` 的瓦兰吉卫队（单位2703，图标902）和雄鹰战士（单位753，图标148）；神庙护卫（2586，图标553）本已标记独特，继续展示。瓦兰吉卫队按可用民族显示，雄鹰战士在阿兹特克、玛雅显示；避免精锐形态重复。补齐两张原始RGBA、透明PNG及七张民族固定配色大图。固定图片缓存版本`185872-fixed6`。
- “游戏数据 185872”跳转本站`/updates?articleId=53155105`，直接打开对应更新汇总文章；切换更新文章时URL同步更新。
- 民族特色与团队加成每项有黑色小圆点。民族图标下增加整体胜率，1v1按1950、TG按1650划分低/高档。`GET /api/civilization-stats/winrates`对同一统计库的各分档累加胜场和出场数，返回56个民族四档胜率。统计库每周替换后，服务以库mtime刷新缓存；科技树每次打开、重新进入、页面重新获焦点及持续停留时每5分钟读取，数据变化才重绘，无需改静态文件或重启。
- 本地及服务器相关19项测试通过；本地桌面/手机Playwright检查通过；线上Playwright核对瓦兰吉人、穆伊斯卡、阿兹特克三处大图和两行胜率，以及185872文章跳转。
- 已备份服务器`.cache/deploy-backups/before-tech-tree-winrates-20261026.tar.gz`，上传源码/脚本/新增素材并重启`aoe2de.service`；自动刷新静态补丁另备份`.cache/deploy-backups/before-tech-tree-winrates-autorefresh-20261026.tar.gz`。当前app.js=`tech-tree-v184`、tech-tree.js=`18`、tech-tree.css=`8`、固定肖像=`fixed6`。未提交或推送Git。

### 11.7 胜率展示精简（2026-10-26）

- 移除民族图标下可见的“整体胜率”标题，显示为`1v1(<>1950) 低档% | 高档%`和`TG(<>1650) 低档% | 高档%`两行；竖线左侧低于阈值，右侧达到或高于阈值。动态统计接口和每5分钟刷新逻辑不变。
- 本地15项科技树测试及桌面/手机浏览器检查通过；线上三个民族的两行实际胜率及更新文章跳转通过。备份`.cache/deploy-backups/before-tech-tree-winrate-compact-20261026.tar.gz`，仅静态发布，无服务重启。版本app.js=`tech-tree-v185`、tech-tree.js=`19`、tech-tree.css=`9`。

### 11.8 民族图标、名称与胜率列对齐（2026-10-26）

- 按用户截图，将文明图标与文明名称放在同一网格行，胜率在图标下方。胜率标签、低档百分比、竖线、高档百分比使用固定网格列，两种模式数值纵向对齐。
- 本地15项科技树测试及桌面/手机浏览器检查通过；线上瓦兰吉人、穆伊斯卡、阿兹特克实际胜率与几何对齐断言通过。服务器备份`.cache/deploy-backups/before-tech-tree-civ-alignment-20261026.tar.gz`，仅静态发布，无服务重启。当前app.js=`tech-tree-v186`、tech-tree.js=`20`、tech-tree.css=`10`。

### 11.9 胜率贴近横幅底边（2026-10-26）

- 文明信息网格在桌面横幅中撑满156px高度，胜率两行固定靠下并留9px底部内边距，图标与文明名称仍同一行。手机信息区保持紧凑并保留独特单位图片位置。
- 本地桌面/手机浏览器检查通过。线上瓦兰吉人及用户截图对应的柏柏尔，胜率块离横幅底边均为9px；连续点验时有一次等待统计数据超时，单独统计接口返回200。服务器备份`.cache/deploy-backups/before-tech-tree-winrate-bottom-20261026.tar.gz`，静态发布无重启。tech-tree.css=`11`，其余版本不变。

### 11.10 PC端科技树鼠标拖动（2026-10-26）

- 科技树画布在PC端支持按住左键左右拖动；仅鼠标指针、6px移动门槛，拖动时阻止原生图片拖动与文字选择，并抑制结束时的点击，避免误开单位详情。正常点击节点、触屏原生滑动、滚动条与键盘操作保留。页面提示加入“按住鼠标左键拖动”。
- 本地科技树15项测试及浏览器往返拖动、误点拦截、正常节点点击检查通过；线上从弓兵节点向左拖动实际`scrollLeft=120`，没有误开详情，随后正常点击可打开详情。
- 服务器备份`.cache/deploy-backups/before-tech-tree-mouse-drag-20261026.tar.gz`并发布静态文件，无服务重启。版本app.js=`tech-tree-v187`、tech-tree.js=`21`、tech-tree.css=`12`。

### 11.11 隐藏科技树底部滑块（2026-10-26）

- 用户说明要取消的是“直接用鼠标拖动底部滚动条滑块”，保留按住画布拖动。科技树容器隐藏原生滚动条（Firefox `scrollbar-width:none`、Chromium/WebKit `::-webkit-scrollbar`），画布本身仍可横向滚动。
- 本地浏览器检查通过；线上浏览器确认滚动条隐藏、画布拖动120px、节点正常点击。备份`.cache/deploy-backups/before-tech-tree-hide-scrollbar-20261026.tar.gz`，静态发布无重启。tech-tree.css=`13`，其他版本不变。

### 11.12 民族加成续行合并（2026-10-26）

- 马里“兵营单位在封建/城堡/帝王时代的远程护甲 +1/+2/+3”在原始数据中途换行，页面此前当作两个民族加成。`civilizationBonusSections` 将民族加成区未以圆点开头的续行接回上一项；拜占庭、凯尔特、库曼、哥特、印度斯坦的同类换行一并修复。数据JSON仍保留原文。
- 桌面民族加成列适度加宽，1101～1500px使用两列布局，确保马里这条在PC端视觉上一行且仅一个圆点。线上1600px及1440px浏览器均确认3项加成、末项一行。
- 本地科技树16项测试及浏览器检查通过，服务器16项测试通过。备份`.cache/deploy-backups/before-tech-tree-mali-bonus-20261026.tar.gz`，发布静态文件，无服务重启。版本app.js=`tech-tree-v188`、tech-tree.js=`22`、tech-tree.css=`14`。

### 11.13 两个民族页面右上角文案（2026-10-26）

- 民族科技树右上角“游戏数据 185872”改为“游戏版本 185872”，仍链接本站对应更新文章。民族统计标题右上角数据日期已移除，页面“数据范围”统计卡片保留。
- 本地相关20项测试及科技树浏览器检查通过，线上两页标题检查通过。备份`.cache/deploy-backups/before-civ-header-labels-20261026.tar.gz`，静态发布无重启。版本app.js=`tech-tree-v189`、tech-tree.js=`23`、civilizations.js=`18`。

### 11.14 Sora Kuma 直播标题与观众数修复（2026-10-26）

- 网站选用Sora Kuma的YouTube源。频道`/live`页只给出当前视频ID，缺少`videoDetails`和实时观看人数；旧代码把频道`og:title`“天空熊 SoraKuma”当直播标题，观众数置0。Twitch若干源采集另有403，但本次页面上的Sora Kuma卡片平台为YouTube。
- 直播确认后读取视频`/watch?v=...`页，在`videoDetails`中验证视频ID、频道ID和直播状态，提取实际标题；实时人数读取`videoViewCountRenderer.originalViewCount`，不误用`videoDetails.viewCount`累计播放量。观看页失败时保留既有源结果。
- `server/services/youtube-live-metadata.js`为纯解析器；2项测试通过，服务器对真实观看页实测标题“【TAG】10/26｜老朋友TG”、实时人数122（动态变化）。
- 备份服务器`server.js`及`.cache/media-live.json`至`.cache/deploy-backups/before-sora-youtube-live-metadata-20261026.tar.gz`，发布后重启`aoe2de.service`。下一轮刷新API返回同标题、126人观看；线上浏览器Sora Kuma卡片显示一致。

### 11.15 实时对局聊天区（2026-10-26）

- 实时对局选手状态表下方新增可折叠聊天区，折叠状态和访客昵称保存在浏览器本地。聊天记录每5秒拉取，最近80条显示，保留7天。
- `server/services/realtime-chat.js`使用`.cache/realtime-chat.sqlite`保存访客发言和系统开播提示；服务端限制长度、发送频率，拦截明显的辱骂、威胁、违法交易、链接及联系方式。访客发言按纯文本渲染，系统直播链接限定HTTPS及已知直播域名。自动过滤无法保证识别所有违规表达，后续若出现绕过需扩展审核手段。
- 直播监控每2分钟刷新；与上一轮相比由未开播变为开播时发送一条系统提示。按玩家ID合并多个直播源，同一直播地址1小时内不重复提示；重启读取持久化直播缓存。
- 本地服务测试通过，包括正常发言、违规拦截、限流、系统提示去重；桌面和手机浏览器布局以及折叠记忆通过。线上聊天接口与折叠操作通过；Lyx开播时自动生成的系统提示已在浏览器显示。未向正式聊天区发送测试发言。
- 发布前备份`.cache/deploy-backups/before-realtime-chat-20261026.tar.gz`，只同步`server.js`、`server/services/realtime-chat.js`与3个前端文件，重启`aoe2de.service`。前端缓存版本`realtime-chat-v1`。

### 11.16 实时聊天 UID 与紧贴布局（2026-10-26）

- 新增`chat_users`表，以请求来源IP的SHA-256摘要为键分配自增UID，不保存明文IP；同一IP在不同浏览器得到同一UID，共用昵称与改名限制。共享公网IP的用户也会共用UID，这是按IP识别的既定限制。
- 首次访问聊天接口分配“游客{UID}”，可设置昵称；成功修改后15天内不可再次修改，由服务端强制检查。新增`POST /api/realtime/chat/nickname`，消息作者显示“昵称(#UID)”。旧用户发言按原IP摘要迁入用户表，历史消息读取当前昵称。
- 状态表和聊天区现在同在`.realtime-left`中，不受右侧卡片高度影响。线上桌面/手机浏览器实测两者间距均为0px；昵称显示和开播系统消息正常。
- 本地测试覆盖同IP复用UID、不同IP分配不同UID、改名锁定、旧消息兼容及开播提示。备份服务器聊天数据库`.cache/deploy-backups/realtime-chat-before-uid-20261026.sqlite`与源码`.cache/deploy-backups/before-realtime-chat-uid-20261026.tar.gz`；紧贴布局另备份`.cache/deploy-backups/before-realtime-chat-tight-layout-20261026.tar.gz`。改名解锁时间显示精确到分钟，备份`.cache/deploy-backups/before-realtime-chat-rename-time-20261026.tar.gz`。前端缓存版本app.js=`realtime-chat-v3`、styles.css=`realtime-chat-v3`。

### 11.17 聊天比较符误拦截（2026-10-26）

- 用户原文“test123, ViVi >>> Yo, 测试测试洞妖洞妖茨歌仙”因旧规则拦截任意`<`或`>`而返回422。改为只拦截明显的HTML标签开头（如`<script>`），普通比较符号允许发送；前端仍用`textContent`渲染消息。
- 添加原文回归测试，并保留脚本标签拦截测试；本地测试通过。备份服务器`server/services/realtime-chat.js`至`.cache/deploy-backups/realtime-chat-before-comparison-20261026.js`并发布，线上文件哈希一致、聊天接口正常。没有向正式聊天区发送测试消息。

### 11.18 聊天区间距（2026-10-26）

- 状态区和聊天区保持同一左侧布局列，聊天区与状态区增加约8～10px间距，各自使用独立布局区域，不会互相遮挡。
- 线上桌面浏览器实测间距10px，前端样式版本`realtime-chat-v4`；备份`.cache/deploy-backups/styles-before-realtime-chat-gap-20261026.css`。
- 当前聊天限制：昵称最多20字，发言最多200字；同一IP固定UID；昵称修改间隔15天；同一IP每分钟最多4条、每天最多40条；全站每分钟最多60条；同一IP发言间隔至少10秒；10分钟内不能重复相同内容；保留最近7天聊天记录、最近80条；拦截明显HTML标签、链接/域名、手机号、联系方式、威胁、违法交易、儿童色情、种族仇恨及常见辱骂词；开播系统提示同一地址1小时内不重复。

### 11.19 聊天限制调整（2026-10-26）

- 用户要求将昵称上限改回20字；发言上限为127字；同一IP每分钟最多5条、滚动24小时最多100条；聊天记录保留30天、最多显示150条；同一直播地址10分钟内不重复发送开播提示。
- 服务端、输入框和聊天提示已同步；本地聊天测试通过，服务器已备份`.cache/deploy-backups/before-realtime-chat-limits-20261026.tar.gz`及`.cache/deploy-backups/realtime-chat-before-name20-20261026.js`，服务重启后状态正常。

### 11.20 民族科技树历史卡片（2026-10-26）

- 民族横幅右侧新增“查看历史”按钮，打开宽幅历史卡片；桌面端左右分栏、手机端上下布局，使用`dialog`遮罩，点击背景或关闭按钮可退出。
- 已接入中国文明的历史简介、分段正文、时期标签和文明图标配图；其他文明沿用同一卡片结构并显示待补充提示，后续可直接在`civilizationHistory`数据表中补充游戏历史资料。
- 本地和线上桌面/手机浏览器均验证按钮、弹窗标题、配图、正文和响应式尺寸。前端版本`tech-tree.js?v=24`、`tech-tree.css?v=15`；备份`.cache/deploy-backups/before-civ-history-card-20261026.tar.gz`。

### 11.21 历史按钮位置与游戏内资料（2026-10-26）

- “查看历史”按钮已移入文明资料网格第二行右侧，与截图位置一致；移动端改为胜率下方独立一行，避免遮挡。
- 历史正文改为读取本地 AoE2DE `resources/zh/strings/history/*-utf8.txt`，并同步游戏内 `resources/_common/wpfg/resources/history/history_*.png` 配图；文件发布到`public/tech-tree-data/history/`，文明切换后按需加载。
- 本地桌面和移动端验证按钮定位、历史卡片正文及配图加载；服务已重启。前端版本`tech-tree.js?v=25`、`tech-tree.css?v=16`；服务器备份`.cache/deploy-backups/before-civ-history-local-data-20261026.tar.gz`。
- 历史卡片配图已放大并通过网格居中（桌面最大宽度300px、移动端160px）；前端样式版本`tech-tree.css?v=17`，备份`.cache/deploy-backups/before-history-image-size-20261026.tar.gz`。
- 配图再次放大并调整为配图区顶部对齐、水平居中；桌面最大宽度360px、移动端210px。前端样式版本`tech-tree.css?v=18`，备份`.cache/deploy-backups/before-history-image-top-20261026.tar.gz`。
- 桌面端配图区改为`position:sticky`，正文下滑时图片保持在原位置；移动端关闭吸附以避免遮挡正文。前端样式版本`tech-tree.css?v=20`，备份`.cache/deploy-backups/before-history-image-sticky-20261026.tar.gz`。

### 11.22 聊天昵称刷新恢复（2026-10-26）

- 聊天身份仍由请求IP决定；当刷新后服务端给出尚未改名的新游客UID，前端自动将本浏览器保存的昵称同步到新UID。已有昵称或用户正在编辑时不覆盖。
- 模拟新游客UID的浏览器测试通过，昵称恢复请求仅发送一次；服务端聊天测试通过。前端版本`app.js?v=realtime-chat-v5`，发布前备份`.cache/deploy-backups/before-chat-nickname-restore-20261026.tar.gz`，线上服务及聊天接口正常。

### 11.23 科技树基础属性图标（2026-10-26）

- 从本地 AoE2DE 的`widgetui/textures/ingame/staticons`复制生命值、攻击、护甲、射程、移速、攻击间隔、驻扎及目标图标，并从`widgetui/textures/ingame/icons`复制视野图标，保存到`public/assets/tech-tree/stats/`。
- 单位详情的基础属性各行显示对应图标；最小射程复用射程图标、攻击前摇复用攻击间隔图标、准确度使用目标图标。桌面和手机浏览器验证图标加载与对齐；线上图片和脚本均返回200、服务正常。
- 前端版本`tech-tree.css?v=21`、`tech-tree.js?v=26`（通过`app.js?v=tech-tree-stat-icons-v1`加载）；服务器备份`.cache/deploy-backups/before-tech-tree-stat-icons-20261026.tar.gz`。
## 2026-10-27：具体科技收益、中文直播源与实时聊天赛事通知

- 民族科技树详情统一去除单位、建筑、科技中文名称中的数据换行/空白；“说明与用途”中的“升级”行独立为“科技收益”。
- 科技收益使用游戏原版具体科技图标和名称（如锻造、铸铁、鼓风炉、骑兵护甲、畜牧、血统、征招、信念、异教），并依据当前文明科技树过滤不可用科技；精锐升级使用对应精锐单位的游戏图标。
- 中文直播区新增哔哩哔哩直播间 `23995827`、`31896390`、`24489157`、`26401744`，分别关联 profile_id `19076073`、`323219`、`10841493`、`10516112`，玩家资料同步补充直播链接。
- 实时聊天消息显示完整年月日和时间；新增下播、S/A/B 级比赛开始、比赛结束比分系统消息，并在北京时间每天 18:00 发布未来 12 小时 S/A/B 级比赛预告。
- 实时状态直播列字号调整为 11px；服务器位置 `australiasoutheast` 显示为“澳大利亚东南部”。
- 验证：`node --check`（app、tech-tree、server、realtime-chat），`node tools/test-tech-tree.mjs`（16/16），`node tools/test-realtime-chat.mjs`，Playwright 页面检查（具体科技图标、完整日期、11px 字号、服务器翻译）。

## 2026-10-27：逐项核对单位与建筑科技收益

- 以 Seicing 的单位索引和建筑索引为入口，抓取并解析 174 个单位详情页、38 个建筑详情页，共 212 个页面、3141 条科技收益记录。
- 新增 `public/tech-tree-data/benefit-techs.json`，科技收益展示优先使用逐项核对数据，不再依赖说明文字中的兵种关键词推断。
- 191 种来源科技名称全部匹配到本地游戏科技；处理了“羽箭/箭羽”“石匠/石工术”“大篷车/篷车”等 31 组版本或译名差异。
- 网站未单独提供详情入口的精锐单位明确继承对应基础单位收益；仍按当前文明科技树过滤不可研究科技。
- 新增 `tools/build-seicing-benefit-map.py` 供以后重新采集，以及 `tools/test-benefit-map.mjs` 验证页面完整性、科技映射和所有可用单位/建筑覆盖率。
- 验证：来源页 212/212、失败 0；来源科技 191/191；可用单位与建筑 287/287；科技树既有测试 16/16。
