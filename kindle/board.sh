#!/bin/sh
# Kindle (KPW1) 定时刷图脚本
# 用法：scp 到 Kindle 的 /mnt/us/board.sh，参照 README 配置 cron 或循环驻留

# 改成你 NAS 的实际地址
URL="http://192.168.1.10:8787/image.png"
OUT="/mnt/us/board.png"
INTERVAL=600

# 禁止自动休眠/屏保（需要 root）
lipc-set-prop com.lab126.powerd preventScreenSaver 1 2>/dev/null

while true; do
  if wget -q "$URL" -O "$OUT.tmp" && [ -s "$OUT.tmp" ]; then
    mv "$OUT.tmp" "$OUT"
    eips -g "$OUT"
  else
    echo "$(date) 下载失败，保留旧图" >> /mnt/us/board.log
  fi
  sleep $INTERVAL
done
