#!/bin/sh
# 在 Kindle 上以 root 执行：部署 agent-kindle-board 刷屏服务
#
# 用法（本机 scp/sftp 不可用，用管道写文件）：
#   ssh root@<kindle-ip> "cat > /mnt/us/board.sh"    < kindle/board.sh
#   ssh root@<kindle-ip> "cat > /mnt/us/install.sh"  < kindle/install.sh
#   ssh root@<kindle-ip> 'sh /mnt/us/install.sh'
#
# 自启链路（这台机器的实际链路）：
#   /etc/init/kindle-boot.conf  --framework_ready-->  /mnt/us/kindle-ssh/boot.sh  -->  board.sh
# kindle-boot.conf 是 emergency.sh 拿 root 时写进只读根分区的，所以平时改 board.sh 只要
# 重新触发一次 framework_ready 事件即可，不用再动 /etc。
# 根分区平时 ro 挂载，要写 /etc 必须先 `mntroot rw`，写完 `mntroot ro`。
#
# 卸载：删掉 boot.sh 里启动 board.sh 那行，或 `rm /etc/init/kindle-boot.conf`（需 mntroot rw）

set -e
export PATH=/usr/sbin:/sbin:/usr/bin:/bin:$PATH

echo "[1/3] 检查依赖命令"
for c in wget eips lipc-set-prop; do
  command -v "$c" >/dev/null 2>&1 || echo "  警告: 缺少 $c（脚本里的相关功能会失效）"
done

echo "[2/3] 安装 board.sh"
chmod +x /mnt/us/board.sh
# Windows 拷过来的文件可能是 CRLF，Kindle 的 sh 会报语法错
if grep -q $'\r' /mnt/us/board.sh 2>/dev/null; then
  tr -d '\r' < /mnt/us/board.sh > /mnt/us/board.sh.tmp && mv /mnt/us/board.sh.tmp /mnt/us/board.sh
  chmod +x /mnt/us/board.sh
  echo "  已去除 CRLF 换行"
fi

echo "[3/3] 启动服务"

# 先停掉已在跑的实例，否则 emit 不会生效。
# 原因：boot.sh 末尾是 `/bin/sh /mnt/us/board.sh &` 紧跟 `wait`，而 board.sh 是死循环
# 永不退出 —— kindle-boot job 因此长期处于 running 状态，upstart 不会对已 running 的
# job 重复 exec，emit framework_ready 就是一次空操作（日志里不会出现新的「启动」行）。
# 只有先让旧实例退出、job 结束，再 emit 才会真正重新拉起。
# PAT 用拼接写法：直接写 "board.sh" 会让本脚本的命令行自身也被匹配到而自杀。
PAT='boa''rd.sh'
stopped=0
for p in /proc/[0-9]*; do
  # 扫描期间进程可能刚好退出，cmdline 读不到。set -e 下命令替换失败会中断整个脚本，必须兜住。
  c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || c=""
  case "$c" in
    *"$PAT"*) kill -9 "${p#/proc/}" 2>/dev/null && stopped=$((stopped + 1)) || true ;;
  esac
done
[ "$stopped" -gt 0 ] && echo "  已停止 $stopped 个旧实例" || echo "  没有运行中的旧实例"
sleep 1

if [ -f /etc/init/kindle-boot.conf ]; then
  # 已有自启链路：emit 事件触发 boot.sh（末尾拉起 board.sh，且脱离本 ssh 会话）。
  # 注意 boot.sh 会顺带重启 dropbear，执行后 ssh 连接会断一下，属正常。
  echo "  触发 framework_ready（走 kindle-boot → boot.sh）"
  /sbin/initctl emit framework_ready 2>/dev/null || echo "  emit 失败，请手动执行 /sbin/initctl emit framework_ready"
else
  echo "  无 kindle-boot job，改用 upstart job（需临时把根分区挂为可写）"
  /usr/sbin/mntroot rw 2>/dev/null || echo "  警告: mntroot rw 失败，写 /etc 可能失败"
  mkdir -p /etc/upstart
  cat > /etc/upstart/board.conf <<'EOF'
# agent-kindle-board 定时刷屏
start on started framework
stop on stopping framework

respawn
respawn limit 3 300

script
    exec /bin/sh /mnt/us/board.sh
end script
EOF
  /usr/sbin/mntroot ro 2>/dev/null
  /sbin/initctl reload-configuration 2>/dev/null
  /sbin/stop board 2>/dev/null || true
  /sbin/start board 2>/dev/null || echo "  start board 失败"
fi

sleep 25
echo "--- board.log 尾部 ---"
tail -n 8 /mnt/us/board.log 2>/dev/null || echo "  （暂无日志，可能首次下载仍在进行）"
echo
echo "完成。日志在 /mnt/us/board.log；改完脚本重跑本文件即可。"
# 用 quoted heredoc：里面的 $p / ${p#/proc/} 必须由 Kindle 上的 shell 展开，
# 双引号里写会被本脚本的 shell 提前展开成乱码。
cat <<'TIP'
手动重启服务（两步都要，顺序不能反）：
  ssh root@<ip> "PAT='boa''rd.sh'; for p in /proc/[0-9]*; do tr '\0' ' ' < $p/cmdline | grep -q \"$PAT\" && kill -9 ${p#/proc/}; done"
  ssh root@<ip> '/sbin/initctl emit framework_ready'
TIP
