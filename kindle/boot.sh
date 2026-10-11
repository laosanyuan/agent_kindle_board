#!/bin/sh
# Kindle KPW1 开机引导：起 sshd + 刷屏
# 由 /etc/init/kindle-boot.conf 在 framework_ready 时以 root 执行（upstart）。
#
# ★ 设计要点（都是踩过的坑）：
#  1) 本体、脚本副本、状态文件全放持久分区 /var/local/kssh。
#     插着电脑开机时 /mnt/us 会被整个导出成 U 盘，设备侧既看不到脚本也写不了日志，
#     自启会静默失败（2026-10-11 的故障）。/var/local 不受影响。
#     /mnt/us 只作为「人类改脚本的地方」，开机时单向同步过来。
#  2) dropbear 必须 -4（只监听 IPv4）：这台内核不支持 IPv6，不加会报
#     "Address family not supported by protocol" 直接退出，22 端口永远起不来。
#  3) 末尾 `board.sh &` + `wait` 是故意的：board.sh 是死循环，job 会长期处于
#     running，upstart 不会对已运行的 job 重复 exec。
#     → 所以「重载脚本」必须两步：先杀掉 board.sh 实例，再 emit framework_ready。
#  4) 怎么判断 sshd 真的起来了：不能用 kill -0 $!（dropbear 默认 daemonize，
#     父进程立刻退出，看着像失败）。改为查 /proc/net/tcp 的 LISTEN。

DST=/var/local/kssh
SRC=/mnt/us/kindle-ssh
mkdir -p "$DST"
LOG="$DST/boot.log"

# /mnt/us 可能还没挂上（插着 USB 开机时尤其慢），等一会儿再同步
i=0
while [ ! -f "$SRC/boot.sh" ] && [ $i -lt 20 ]; do
  sleep 1
  i=$((i + 1))
done

# 从 U 盘同步最新文件；同步不到就用上次留在 /var/local 的副本，保证照样能起来
[ -f "$SRC/boot.sh" ] && cp -f "$SRC/boot.sh" "$DST/boot.sh"
[ -f "$SRC/dropbearmulti" ] && cp -f "$SRC/dropbearmulti" "$DST/dropbearmulti"
[ -f "$SRC/dropbear_rsa_host_key" ] && cp -f "$SRC/dropbear_rsa_host_key" "$DST/host_key"
[ -f /mnt/us/board.sh ] && cp -f /mnt/us/board.sh "$DST/board.sh"
chmod 755 "$DST/dropbearmulti" 2>/dev/null
chmod 600 "$DST/host_key" 2>/dev/null
chmod 755 "$DST/boot.sh" "$DST/board.sh" 2>/dev/null

logmsg() {
  line="--- $(date) $1"
  echo "$line" >> "$LOG"
  echo "$line" >> "$SRC/boot.log" 2>/dev/null   # 镜像到 U 盘方便看
}

logmsg "boot.sh start (src=$SRC)"
ifconfig wlan0 >> "$LOG" 2>&1
ifconfig wlan0 > "$SRC/ip.txt" 2>&1

port22_up() {
  # /proc/net/tcp 中 0016=22 端口，0A=LISTEN；绑定 0.0.0.0
  grep -qs ':0016 00000000:0000 0A' /proc/net/tcp
}

killall dropbear 2>/dev/null
sleep 1
"$DST/dropbearmulti" dropbear -r "$DST/host_key" -p 22 -4 -s -K 60 -E >> "$LOG" 2>&1
sleep 2
if ! port22_up; then
  logmsg "IPv4-only 未监听 :22，回退默认参数重试"
  "$DST/dropbearmulti" dropbear -r "$DST/host_key" -p 22 -s -K 60 -E >> "$LOG" 2>&1
  sleep 2
fi
if port22_up; then
  logmsg "sshd listening on :22"
else
  logmsg "sshd 未监听 :22（检查 $LOG）"
fi

# 兜底：若同步失败导致没有 board.sh，直接跑 U 盘上的
[ -f "$DST/board.sh" ] || cp -f /mnt/us/board.sh "$DST/board.sh" 2>/dev/null
[ -f "$DST/board.sh" ] && /bin/sh "$DST/board.sh" &
wait
