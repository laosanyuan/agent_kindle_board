#!/bin/sh
# Kindle (KPW1) 定时刷图脚本
# 源文件放 /mnt/us/board.sh（方便从电脑改）；boot.sh 会把它同步到 /var/local/kssh/board.sh 再运行。
#
# ★ 为什么运行体和状态文件都在 /var/local：
#   /mnt/us 在「U 盘模式」（插着电脑）时会被整个导出给电脑，设备侧既看不到文件也写不进日志。
#   脚本放那儿的话，插着 USB 开机 = 自启静默失败（2026-10-11 就是这么瘫的）。
#   持久分区 /var/local 不参与导出，永远可读写。
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

# 状态目录：优先 /var/local/kssh（U 盘模式下也能写），不可用再退回 /mnt/us
STATE_DIR="/var/local/kssh"
mkdir -p "$STATE_DIR" 2>/dev/null
if ! touch "$STATE_DIR/.wtest" 2>/dev/null; then
  STATE_DIR="/mnt/us"
else
  rm -f "$STATE_DIR/.wtest" 2>/dev/null
fi
LOG="$STATE_DIR/board.log"
ETAG_FILE="$STATE_DIR/board.etag"
LAST_REFRESH_FILE="$STATE_DIR/board.ts"
FULLCNT_FILE="$STATE_DIR/board.cnt"   # 局部刷新计数，每 20 轮做一次全刷除残影
MIRROR_LOG="/mnt/us/board.log"  # 顺带往 U 盘镜像一份，插电脑能直接看；写不进就算了
CHECK=30           # 检查间隔（秒）
FORCE_EVERY=60     # 强制重画间隔（秒），必须短于 framework 首页重绘周期

# —— 前光（背光）控制 ————————————————————————————————
# ★ 坑（2026-10-11 实测定论）：KPW1 上前光没有「0 = 熄灭」这回事。
#   `lipc-set-prop com.lab126.powerd flIntensity 0` 落到驱动层是 **1 档**，
#   LED 仍然极微亮（社区早知：滑块拉到 0，灯依旧微亮，只有休眠才真灭）。
#   读值可见：cat $FL_NODE → "FrontLight(Intensity) = 1"。
#   真正熄灭要把 0 直接写进 tps6116x 驱动的 fl_intensity 节点。
#   注意：写 0 会让这台机器的前光彻底不亮，想恢复把 FL_LEVEL 改成 1（或删掉这行）。
FL_NODE="/sys/devices/system/fl_tps6116x/fl_tps6116x0/fl_intensity"
FL_LEVEL=0         # 0 = 真正熄灭；1 = 厂固件的「最暗档」（微亮）

# —— 单实例保护 ——————————————————————————————————————
# boot job 挂在 framework_ready 上，而 framework 每次唤醒/恢复都会重启并再次
# 触发它 —— 不加防护的话每次唤醒都多起一个实例，多实例互相抢着写帧缓冲，
# 画面就会出现「面板/首页/花屏轮流来」的灵异现象。
self=$$
for p in /proc/[0-9]*; do
  pid="${p#/proc/}"
  [ "$pid" = "$self" ] && continue
  # 匹配 /kssh/board.sh —— 不看前缀（/mnt/us 或 /var/local 都算），且不会误伤 install.sh
  grep -qs "/kssh/board.sh" "$p/cmdline" || continue
  # 必须排除自己的子 shell：BusyBox ash 做命令替换 $(...) 时是 fork 而非 exec，
  # 子进程的 cmdline 与父进程一模一样。不排除就会误杀自己的子进程，
  # 表现为偶发的「etag 获取失败，跳过本轮」，也会让存活检测数出 2 个实例。
  ppid=$(sed 's/^.*) //' "$p/stat" 2>/dev/null | awk '{print $2}')
  [ "$ppid" = "$self" ] && continue
  kill -9 "$pid" 2>/dev/null
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

# preventScreenSaver 保证屏幕不被固件休眠（面板要一直显示内容）。
# 前光每轮都压一次：① 先把 powerd 的档位设成 0（保持它内部状态是"最暗"，
# 免得休眠恢复时弹回高亮）；② 再等 1 秒让 powerd 那一刀落到驱动，
# 然后把真正的熄灭值写进 fl_intensity 节点。顺序不能反 ——
# 反了的话 powerd 后写的「1 档」会把熄灭覆盖掉。
keep_awake() {
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
  lipc-set-prop com.lab126.powerd flIntensity 0 >/dev/null 2>&1
  sleep 1
  [ -w "$FL_NODE" ] && echo -n "$FL_LEVEL" > "$FL_NODE" 2>/dev/null
}

log() {
  msg="$(date '+%F %T') $1"
  echo "$msg" >> "$LOG"
  # 镜像到 U 盘（插电脑能直接看）。U 盘模式下 /mnt/us 不可见，写失败就忽略。
  [ "$LOG" = "$MIRROR_LOG" ] || echo "$msg" >> "$MIRROR_LOG" 2>/dev/null
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
