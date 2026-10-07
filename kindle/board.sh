#!/bin/sh
# Kindle (KPW1) 定时刷图脚本
# 用法：scp 到 Kindle 的 /mnt/us/board.sh；开机自启由 install.sh 写入 /etc/upstart/board.conf
#
# ⚠️ 关键背景（2026-10-07 真机逐像素验证）：
# 这台 KPW1(5.3.4) 的 eips 画 RGB(colortype 2) 或 >12KB 的 PNG 会输出拼贴花屏，
# 只有 ≤~12KB 的灰度(colortype 0) PNG 能 1:1 精确绘制。
# 因此服务端把 758x1024 切成 16 条 758x64 灰度条带（/band/0.png … /band/15.png），
# 本脚本逐条 `eips -g -x 0 -y <i*64>` 绘制，拼出完整画面。
#
# 按需刷新：先取 /api/etag，数据没变就不下载不刷屏（省电少闪烁）；
# FORCE_EVERY 保证至少定期刷一次（万一系统 UI 复活重绘首页盖掉我们）。

BASE="http://192.168.100.218:8787"
BANDS=16
BAND_H=64
OUTDIR="/tmp/bands"        # 条带放 /tmp，避免频繁写 flash
LOG="/mnt/us/board.log"
ETAG_FILE="/mnt/us/board.etag"
LAST_REFRESH_FILE="/mnt/us/board.ts"
FULLCNT_FILE="/mnt/us/board.cnt"   # 局部刷新计数，每 20 轮做一次全刷除残影
CHECK=30           # 检查间隔（秒）
FORCE_EVERY=60     # 强制重画间隔（秒），必须短于 framework 首页重绘周期

# —— 单实例保护 ——————————————————————————————————————
# boot job 挂在 framework_ready 上，而 framework 每次唤醒/恢复都会重启并再次
# 触发它 —— 不加防护的话每次唤醒都多起一个实例，多实例互相抢着写帧缓冲，
# 画面就会出现「面板/首页/花屏轮流来」的灵异现象。
for p in /proc/[0-9]*; do
  [ "${p#/proc/}" = "$$" ] && continue
  grep -qs "/mnt/us/board.sh" "$p/cmdline" && kill -9 "${p#/proc/}" 2>/dev/null
done
mkdir -p "$OUTDIR"

# —— 接管屏幕：停掉状态栏和桌面 UI ————————————————————
# 状态栏是独立的 upstart job「pillow」（pillowd 进程），会在屏幕左侧画一条
# 黑底的时钟/电量/WiFi 栏，每分钟重绘，盖不住（disableEnablePillow 等
# lipc 属性实测无效，只能停进程）。framework（桌面 home 界面）偶尔也会
# 重绘盖掉画面，一并停掉。副作用：设备 UI 不再响应触摸/按键，
# 重启（长按电源 5 秒）可完全恢复原厂界面。
/sbin/stop pillow 2>/dev/null
/sbin/stop framework 2>/dev/null

keep_awake() {
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
}

log() {
  echo "$(date '+%F %T') $1" >> "$LOG"
}

now_ts() {
  date +%s
}

# full=1 时最后一条带 -f 全刷（除残影）
draw_bands() {
  i=0
  while [ $i -lt $BANDS ]; do
    y=$((i * BAND_H))
    if [ "$1" = "1" ] && [ $i -eq $((BANDS - 1)) ]; then
      eips -g "$OUTDIR/$i.png" -x 0 -y $y -f >/dev/null 2>&1
    else
      eips -g "$OUTDIR/$i.png" -x 0 -y $y >/dev/null 2>&1
    fi
    i=$((i + 1))
  done
}

download_bands() {
  i=0
  while [ $i -lt $BANDS ]; do
    rm -f "$OUTDIR/$i.png"
    wget -q -T 20 "$BASE/band/$i.png" -O "$OUTDIR/$i.png" || return 1
    [ -s "$OUTDIR/$i.png" ] || return 1
    i=$((i + 1))
  done
  return 0
}

refresh_screen() {
  # 数据没变时条带已在本地，直接重画即可
  if [ "$1" = "download" ]; then
    download_bands || { log "条带下载失败，保留旧画面"; return 1; }
  fi
  draw_bands "$2"
  now_ts > "$LAST_REFRESH_FILE"
  if [ "$2" = "1" ]; then
    log "已刷新(全刷)"
  else
    log "已刷新"
  fi
}

keep_awake
log "board.sh 启动 (pid=$$, check=${CHECK}s, force=${FORCE_EVERY}s, base=$BASE)"
refresh_screen download 0

while true; do
  sleep $CHECK
  keep_awake

  etag=$(wget -q -T 15 -O - "$BASE/api/etag" 2>/dev/null)
  if [ -z "$etag" ]; then
    log "etag 获取失败，跳过本轮"
    continue
  fi

  data_changed=0
  if [ "$etag" != "$(cat "$ETAG_FILE" 2>/dev/null)" ]; then
    echo "$etag" > "$ETAG_FILE"
    data_changed=1
  fi

  last=$(cat "$LAST_REFRESH_FILE" 2>/dev/null)
  [ -z "$last" ] && last=0
  force=0
  [ $(( $(now_ts) - last )) -ge $FORCE_EVERY ] && force=1

  if [ $data_changed -eq 0 ] && [ $force -eq 0 ]; then
    continue
  fi

  [ $data_changed -eq 1 ] && log "数据变化 ($etag)"

  if [ $(( $(cat "$FULLCNT_FILE" 2>/dev/null || echo 0) + 1 )) -ge 20 ]; then
    echo 0 > "$FULLCNT_FILE"
    full=1
  else
    echo $(( $(cat "$FULLCNT_FILE" 2>/dev/null || echo 0) + 1 )) > "$FULLCNT_FILE"
    full=0
  fi

  refresh_screen $([ $data_changed -eq 1 ] && echo download || echo cached) $full
done
