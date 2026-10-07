# agent-kindle-board

局域网 AI 额度监控板。NAS 每 10 分钟采集各平台剩余额度，渲染成灰度 PNG；一台闲置的 Kindle Paperwhite 1 横放，定时拉图直刷帧缓冲当墨水屏。

<img src="preview.png" alt="面板预览" width="640">

> 示例图为 MOCK 数据渲染。

三张卡片互相独立，任一平台采集失败只影响自己的卡片（显示「--」+ 具体原因）：

- **DeepSeek**：API 账户余额（¥），按量计费无上限
- **ChatGPT**：Plus 订阅的 **5 小时窗口** 与 **周额度** 两条进度条，各自独立倒计时
- **WorkBuddy**：**套餐基础积分**（付费套餐 + 加购）与 **平台奖励积分**（免费/活动/赠送）分开显示，大数字为合计剩余

## 快速开始

```bash
cp config.example.yaml config.yaml   # 填凭证，见下文
docker compose up -d                 # 需先导入镜像（见下）或在有源码的机器上 docker compose up -d --build
curl http://<NAS_IP>:8787/image.png?raw=1 -o test.png   # 浏览器先看一眼
```

**离线导入镜像**（NAS 访问 Docker Hub 不便时）：在任意能构建的机器上把 `agent-kindle-board-0.1.4-amd64.tar.gz` 拷到 NAS，然后：

```bash
docker load -i agent-kindle-board-0.1.4-amd64.tar.gz   # 导入 agent-kindle-board:0.1.4
docker compose up -d                                    # compose 已指向该镜像
```

不用 Docker：Node ≥ 20，`npm install && npm start`。没凭证也能验排版：`MOCK=1 npm run preview`（加 `--kindle` 看旋转后的 Kindle 实际效果）。

接口：

- `GET /image.png` — 面板图（RGB，758×1024，已按横放方向旋转；给浏览器/board.html 用）
- `GET /image.png?raw=1` — 未旋转的 1024×758，浏览器查看用
- `GET /band/0.png … /band/15.png` — **Kindle eips 直刷用的灰度条带**（758×64 × 16 条，colortype 0）
- `GET /board.html` — 网页版面板（自动刷新），给没越狱的 Kindle 用自带浏览器打开的兜底方案
- `GET /api/etag` — 数据指纹（额度数值的哈希），Kindle 按需刷新用
- `GET /api/data` — 原始 JSON，排查用
- `GET /health` — 健康检查

> **为什么 Kindle 不直接拉 `/image.png`？** KPW1（5.3.4 固件）的 `eips` 内置 PNG 解码器
> 有硬伤：RGB(colortype 2) 或单文件 >~12KB 的 PNG 会画出「不同区域不同缩放」的拼贴花屏
> （真机逐像素验证过）。只有 ≤12KB 的灰度(colortype 0) PNG 能 1:1 精确绘制。
> 所以服务端把整图切成 16 条 758×64 灰度条带，Kindle 端逐条 `eips -g -x 0 -y <i*64>` 拼
> 出完整画面。注意 sharp 的 `.greyscale()` 输出的仍是 colortype 2，必须自编码
> colortype 0（见 `src/render/render.js` 里的 `encodeGrayPng`）。

**失败降级**：瞬时故障（超时、网络抖动、5xx）自动重试 1 次；仍失败则沿用该平台上一次成功的数值，卡片状态显示「陈旧 X 分钟」，超过 `staleMaxMinutes`（默认 180 分钟）才判定为真正失败显示「--」。凭证缺失/过期不重试、不降级。

## 凭证获取

三个平台的凭证都会过期，过期时对应卡片会直接写明原因，重新取一次填入即可。

| 平台 | 怎么拿 | 填到哪 |
|---|---|---|
| **DeepSeek** | platform.deepseek.com → API keys → 创建 | `platforms.deepseek.apiKey` |
| **ChatGPT** | 运行 `node tools/chatgpt-credential.js --real`（先关闭所有 Chrome 窗口），自动提取写入 | `platforms.chatgpt.cookie` |
| **WorkBuddy** | 运行 `node tools/wb-credential.js`，浏览器里登录一次自动提取写入 | `platforms.workbuddy.cookie` + `userId` |

> ChatGPT 走 `chatgpt.com/api/auth/session` 换 accessToken，再打内部接口 `GET /backend-api/wham/usage`（只带 cookie 会 401，必须有 Bearer；`rate_limits`、`conversation_limit` 两个旧接口已 404 下线）。`--real` 模式会复制日常 Chrome 的登录态来过 Cloudflare 人机验证（独立新 profile 会被 Turnstile 无限卡住），提取完自动清理临时副本；登录态过期时在弹出的窗口里重新登录一次即可。跑工具前要清掉代理变量（见脚本头部注释）。

## 出网代理（ChatGPT 必备）

`chatgpt.com` 在国内网络直连不通，NAS 上必须配代理出口：

```yaml
proxy:
  url: "http://192.168.1.20:10809"   # v2ray / clash 的 **HTTP** 入站（不支持 socks5://）
  applyTo: [chatgpt]                 # 只对这些平台生效；删掉或留空数组则全部走代理
```

填法取决于代理跑在哪：`http://xray:10809`（compose 里的 xray 服务，同一网络用服务名，推荐）／`http://host.docker.internal:10809`（代理跑在 Docker 宿主机上）／`http://192.168.1.20:10809`（跑在局域网另一台机器，且该代理要开「允许局域网连接」）。也可用环境变量 `PROXY_URL` 注入（优先级高于配置文件）。

### vmess:// 这类订阅链接能直接填吗？

不能。`proxy.url` 只认标准 HTTP 代理，vmess / vless / trojan 都是私有协议，Node 和 curl 都不认识。需要一个 v2ray / xray 客户端把它转成 HTTP 入站。推荐做法是在 NAS 上和面板一起跑一个 xray 容器（compose 里已带 `xray` 服务）：

1. 把订阅链接 base64 部分解出来（去掉 `vmess://` 后 `base64 -d`），得到 `add`/`port`/`id`/`net`/`path`/`tls`
2. 按 `deploy/xray/config.example.json` 的模板填进 `deploy/xray/config.json`（模板对应 vmess + ws + 无 TLS）
3. `docker compose up -d`，`config.yaml` 的 `proxy.url` 填 `http://xray:10809`

```bash
# 验证代理是否通（应返回 200）
docker exec agent-kindle-board curl -s -o /dev/null -w '%{http_code}\n' \
  -x http://xray:10809 -A "Mozilla/5.0" https://chatgpt.com/api/auth/session
```

NAS 拉不到 `ghcr.io/xtls/xray-core` 时，在有网的机器上 `docker save ghcr.io/xtls/xray-core:latest | gzip > xray-core.tar.gz`，拷到 NAS `docker load -i` 即可。

> 安全提示：`deploy/xray/config.json` 含节点 UUID，已在 `.gitignore` 中，别提交到公开仓库。节点是 `ws` 且**未开 TLS**，流量特征明显、较易被干扰，有条件建议换成带 TLS 的节点。

> 为什么配了代理还要 curl：Cloudflare 按 TLS 指纹（JA3）拦机器请求，Node 自带 fetch（undici）即使走代理也会被 403 challenge，而 curl 的指纹可以通过。因此**配了代理的请求一律用 curl 发**（镜像里已装 curl）；没配代理时仍走 Node 原生请求。被拦截时卡片会明确提示「被 Cloudflare 拦截」，不要误判成 cookie 过期。

> WorkBuddy 走 Web 版同源接口 `POST www.workbuddy.cn/billing/meter/get-user-resource-summary`（cookie + X-User-Id 认证，与网页版「订阅用量」同源）。cookie 过期后重跑提取工具即可；userId 不填会自动获取。两类积分按 `PackageCode` 区分，枚举表在 `src/providers/workbuddy.js` 顶部（`PAID_CODES` / `FREE_CODES`）。

## 配置

```yaml
port: 8787                  # 服务端口
intervalMinutes: 10         # 采集间隔
staleMaxMinutes: 180        # 失败降级沿用上次成功值的最长时间（分钟）
timezone: Asia/Shanghai     # 面板时间所用时区（容器默认 UTC，勿删）
orientation: left           # Kindle 横放方向：设备顶部朝左 left / 朝右 right / 不旋转 none

platforms:
  deepseek:  { enabled: true, apiKey: "" }
  chatgpt:   { enabled: true, cookie: "" }
  workbuddy: { enabled: true, cookie: "", userId: "" }
```

环境变量可覆盖（设置后自动启用对应平台）：`PORT`、`DEEPSEEK_API_KEY`、`CHATGPT_COOKIE`、`WORKBUDDY_COOKIE`、`WORKBUDDY_USER_ID`，以及 `MOCK=1`（假数据）和 `MOCK_STALE=1`（额外把 ChatGPT 标记为陈旧，验证降级排版）。`config.yaml` 已在 `.gitignore` 中，勿提交。

## Kindle KPW1 配置（一次性）

两条路，按设备状态选：

### A. 免越狱（先看效果）

Kindle 原生系统 → 菜单 → **体验版浏览器** → 打开 `http://<NAS_IP>:8787/board.html`。
页面定时取 `/api/etag` 比对，额度变了才换图，并兜底整页刷新（`/board.html?refresh=300` 改秒数，默认 600）。
局限：浏览器顶部有地址栏占空间，设备仍可能自动休眠。适合先验证「Kindle 能不能访问 NAS」。

### B. 越狱后直刷帧缓冲（长期方案）

固件版本先在「设置 → 设备信息」确认。KPW1 全系列可越狱；5.0.x ~ 5.4.4.2 用 NiLuJe 的 `kindle-5.4-jailbreak`（把包内 7 个文件放根目录 → 【首页 → 菜单 → 设置 → 菜单 → 更新您的 Kindle】，屏幕下方出现 `**** JAILBREAK ****` 即成功），细节以 MobileRead 原帖为准。

1. **越狱** → **装 KUAL + USBNetwork**（提供 SSH；改 `usbnet/etc/config` 里 `USE_WIFI=true` 可走 WiFi 直连）
2. **传脚本**（U 盘拷也行，注意保持 LF 换行）：
   ```bash
   scp kindle/board.sh kindle/install.sh root@<Kindle_IP>:/mnt/us/
   ssh root@<Kindle_IP> 'sh /mnt/us/install.sh'
   ```
   `install.sh` 会去掉 CRLF、写 `/etc/upstart/board.conf`（framework 起来后启动 + 异常退出自动拉起）、立刻启动并打印日志
3. **横放**即可，图片已是 758×1024 旋转版，直接写帧缓冲

两个常见问题：

- **屏幕上的图是倒的** → config 里 `orientation` 改成 `right`（横放方向和预设的相反）
- **Kindle 一直亮着但图不更新** → 看卡片第二行的失败原因；排查 Kindle 能否 `wget` 到 NAS、`board.sh` 是否还在运行（`/mnt/us/board.log`）
- **刷完图被覆盖** → 设备停在**多看**界面时 UI 会覆盖帧缓冲；越狱相关操作（搜索栏 `;` 命令）也只能在原生系统里做，多看界面没有命令入口
- **画面左边缘有一条时钟/电量黑条** → Kindle 桌面状态栏（pillowd）。已在 `board.sh` 启动时执行 `/sbin/stop pillow` 和 `/sbin/stop framework` 停掉（画面 100% 干净）；副作用是触摸屏/按键不响应、停到开机画面一闪后被接管，**重启 Kindle 即恢复原厂行为**。恢复原厂就把 `board.sh` 里那两行 stop 注释掉再重启。

KPW1 真机踩过的坑（改代码前必读）：

- `eips` 只能精确画 **≤~12KB 的灰度(colortype 0) PNG**；RGB 或大图会输出拼贴花屏 → 服务端已按 64 行/条切 16 条灰度条带（`/band/N.png`），别改回整图直刷
- 该机器的 BusyBox `ps` **列不全进程**，判断 board.sh 是否活着要扫 `/proc/*/cmdline`；杀进程时注意别把含同名关键字的自己 kill 了（ssh 远程命令行也算）
- 开机自启挂在 `framework_ready` 上时，**framework 每次唤醒/恢复都会再触发一次**，多实例会互相覆盖画面 —— `board.sh` 启动时的单实例防护（杀掉其它实例）不要删
- **墨水屏渲染准则（0.1.8 起生效）**：e-ink 上细字重/浅灰/1px 线都会发虚 —— 字重一律 ≥600（标题/大数字 700）、灰阶文字不浅于 `#555`、线条 ≥2px、进度条用「白底 + 深描边 + 黑色填充」而不是浅灰槽。改模板时别退回浅灰细线风格

脚本按需刷新：每 `CHECK`（30）秒取一次 `/api/etag` 与本地比对，**数据变了才重新下载条带**，没变最多每 `FORCE_EVERY`（60 秒）重画一次——重画必须比 framework 的首页重绘频繁，否则画面会被盖掉。每 20 轮做一次全刷除残影。

脚本会循环重设 `powerd preventScreenSaver` 防止固件恢复休眠；`eips -g` 直写帧缓冲，刷新瞬间闪一次全刷是防残影，正常。

## 扩展新平台

1. `src/providers/` 新建 `xxx.js`，实现 `fetchQuota(cfg)`，返回结构见 `base.js` 顶部注释
2. 在 `src/providers/index.js` 的 `REGISTRY` 注册，`config.yaml` 里 `enabled: true`
3. 图标放 `assets/xxx.svg` 或 `assets/xxx.png`，文件名须与 provider 的 `id` 一致

> 卡片列数随平台数自动 1~4 列；超过 4 个平台需调整 `src/render/template.js`。
