#!/bin/sh
# Kindle (KPW1) 定时刷图脚本
# 用法：scp 到 Kindle 的 /mnt/us/board.sh，参照 README 配置开机启动或后台驻留
#
# 注意：服务端默认输出 758x1024（已按横放方向旋转），与 Kindle 帧缓冲一致，
# 直接 eips -g 即可；不要拉 1024x758 的原图，会被裁切。
#
# 按需刷新：先取 /api/etag（额度数据指纹），和上次相同就跳过刷屏。
# 额度没变化时屏幕不会闪，也更省电；FORCE_EVERY 保证至少定期刷一次，
# 让面板上的「最后更新」时间跟着走，便于确认设备还活着。

# 改成你 NAS 的实际地址
BASE="http://192.168.1.10:8787"
OUT="/mnt/us/board.png"
LOG="/mnt/us/board.log"
ETAG_FILE="/mnt/us/board.etag"
LAST_REFRESH_FILE="/mnt/us/board.ts"
CHECK=60           # 检查间隔（秒）
FORCE_EVERY=3600   # 多久强制刷新一次（秒），即使数据没变

# 禁止自动休眠/屏保（需要 root + 越狱）；循环里定期重设，防止被固件重置
keep_awake() {
  lipc-set-prop com.lab126.powerd preventScreenSaver 1 >/dev/null 2>&1
}

log() {
  echo "$(date '+%F %T') $1" >> "$LOG"
}

now_ts() {
  date +%s
}

refresh_screen() {
  rm -f "$OUT.tmp"
  if wget -q -T 20 "$BASE/image.png" -O "$OUT.tmp" && [ -s "$OUT.tmp" ]; then
    mv "$OUT.tmp" "$OUT"
    if eips -g "$OUT"; then
      now_ts > "$LAST_REFRESH_FILE"
      log "已刷新"
    else
      log "eips 写屏失败"
    fi
  else
    rm -f "$OUT.tmp"
    log "下载失败，保留旧图"
  fi
}

keep_awake
log "board.sh 启动 (check=${CHECK}s, force=${FORCE_EVERY}s, base=$BASE)"
refresh_screen

while true; do
  sleep $CHECK
  keep_awake

  etag=$(wget -q -T 15 -O - "$BASE/api/etag" 2>/dev/null)
  if [ -z "$etag" ]; then
    log "etag 获取失败，跳过本轮"
    continue
  fi

  if [ "$etag" != "$(cat "$ETAG_FILE" 2>/dev/null)" ]; then
    echo "$etag" > "$ETAG_FILE"
    log "数据变化 ($etag)"
    refresh_screen
    continue
  fi

  # 数据没变，但超过强制间隔仍刷一次，让面板时间戳保持更新
  last=$(cat "$LAST_REFRESH_FILE" 2>/dev/null)
  [ -z "$last" ] && last=0
  if [ $(($(now_ts) - last)) -ge $FORCE_EVERY ]; then
    log "超过 ${FORCE_EVERY}s 强制刷新"
    refresh_screen
  fi
done
