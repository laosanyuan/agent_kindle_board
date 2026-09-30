# agent-kindle-board

局域网 AI 额度监控板。NAS 每 10 分钟采集各平台剩余额度，渲染成 1024×758 横屏灰度 PNG；一台闲置的 Kindle Paperwhite 1 横放，定时拉图直刷帧缓冲当墨水屏。

![面板预览](preview.png)

三张卡片互相独立，任一平台采集失败只影响自己的卡片（显示「--」+ 具体原因）：

- **DeepSeek**：API 账户余额（¥），按量计费无上限
- **ChatGPT**：Plus 订阅的 **5 小时窗口** 与 **周额度** 两条进度条，各自独立倒计时
- **WorkBuddy**：**套餐基础积分**（付费套餐 + 加购）与 **平台奖励积分**（免费/活动/赠送）分开显示，大数字为合计剩余

## 快速开始

```bash
cp config.example.yaml config.yaml   # 填凭证，见下文
docker compose up -d --build
curl http://<NAS_IP>:8787/image.png -o test.png   # 先看一眼图对不对
```

不用 Docker：Node ≥ 20，`npm install && npm start`。没凭证也能验排版：`MOCK=1 npm run preview`。

接口：`GET /image.png`（Kindle 拉这个）、`GET /api/data`（原始 JSON，排查用）、`GET /health`。

## 凭证获取

三个平台的凭证都会过期，过期时对应卡片会直接写明原因，重新取一次填入即可。

| 平台 | 怎么拿 | 填到哪 |
|---|---|---|
| **DeepSeek** | platform.deepseek.com → API keys → 创建 | `platforms.deepseek.apiKey` |
| **ChatGPT** | 登录 chatgpt.com → F12 → Application → Cookies → 复制整串 Cookie | `platforms.chatgpt.cookie` |
| **WorkBuddy** | 登录 workbuddy.cn → F12 → Network → 复制任意请求的 `Authorization: Bearer xxx` 中的 token | `platforms.workbuddy.token` |

> WorkBuddy 走 `POST www.workbuddy.cn/v2/billing/meter/get-user-resource-summary`，与客户端设置页「订阅用量」同源。两类积分按 `PackageCode` 区分，枚举表在 `src/providers/workbuddy.js` 顶部（`PAID_CODES` / `FREE_CODES`），官方新增套餐类型时补进去即可。

## 配置

```yaml
port: 8787            # 服务端口
intervalMinutes: 10   # 采集间隔
historyDays: 7        # 历史保留天数

platforms:
  deepseek:  { enabled: true, apiKey: "" }
  chatgpt:   { enabled: true, cookie: "" }
  workbuddy: { enabled: true, token: "" }
```

环境变量可覆盖：`PORT`、`DEEPSEEK_API_KEY`、`CHATGPT_COOKIE`、`WORKBUDDY_TOKEN`、`MOCK=1`。`config.yaml` 已在 `.gitignore` 中，勿提交。

## Kindle KPW1 配置（一次性）

固件版本先在「设置 → 设备信息」确认，KPW1 全系列（5.1.x ~ 5.6.x）均可越狱，细节以 MobileRead 对应固件的帖子为准。

1. **越狱** → **装 KUAL + USBNetwork**（提供 SSH）
2. **传脚本并改 NAS 地址**：
   ```bash
   scp kindle/board.sh root@<Kindle_IP>:/mnt/us/board.sh
   ssh root@<Kindle_IP> 'chmod +x /mnt/us/board.sh && sed -i "s|http://192.168.1.10:8787|http://<NAS_IP>:8787|" /mnt/us/board.sh'
   ```
3. **验证并常驻**：先 `nohup /mnt/us/board.sh &` 看是否刷出图，再做成开机启动（KUAL 扩展或 `/etc/rc5.d` 钩子）
4. **横放**即可，图片本身是横屏，无需旋转

脚本内含 `powerd preventScreenSaver` 禁止休眠，`eips -g` 直写帧缓冲（刷新瞬间闪一次全刷是防残影，正常）。

## 扩展新平台

1. `src/providers/` 新建 `xxx.js`，实现 `fetchQuota(cfg)`，返回结构见 `base.js` 顶部注释
2. 在 `src/providers/index.js` 的 `REGISTRY` 注册，`config.yaml` 里 `enabled: true`
3. 图标放 `assets/xxx.svg` 或 `assets/xxx.png`，文件名须与 provider 的 `id` 一致

> 布局目前固定三张卡片横排，接入更多平台需调整 `src/render/template.js` 的 `cardW` / 换行逻辑。
