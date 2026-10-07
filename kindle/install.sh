#!/bin/sh
# 在 Kindle 上以 root 执行（通过 usbnet/ssh 登录后）：部署 agent-kindle-board 刷屏服务
#
# 用法：
#   scp board.sh install.sh root@<kindle-ip>:/mnt/us/
#   ssh root@<kindle-ip> 'sh /mnt/us/install.sh'
#
# 做了三件事：
#   1. 装好 board.sh 并给执行权限
#   2. 写 upstart job，开机自动跑（Kindle 5.x 用 upstart）
#   3. 立刻启动，并打一次日志确认
#
# 卸载：ssh 上去执行 `stop board; rm -f /etc/upstart/board.conf /mnt/us/install.sh`

set -e

echo "[1/4] 检查依赖命令"
for c in wget eips lipc-set-prop; do
  command -v "$c" >/dev/null 2>&1 || echo "  警告: 缺少 $c（脚本里的相关功能会失效）"
done

echo "[2/4] 安装 board.sh"
chmod +x /mnt/us/board.sh
# Windows 拷过来的文件可能是 CRLF，Kindle 的 sh 会报语法错
if grep -q $'\r' /mnt/us/board.sh 2>/dev/null; then
  tr -d '\r' < /mnt/us/board.sh > /mnt/us/board.sh.tmp && mv /mnt/us/board.sh.tmp /mnt/us/board.sh
  chmod +x /mnt/us/board.sh
  echo "  已去除 CRLF 换行"
fi

echo "[3/4] 写 upstart job"
mkdir -p /etc/upstart
cat > /etc/upstart/board.conf <<'EOF'
# agent-kindle-board 定时刷屏
# 框架（framework）起来后启动；异常退出自动拉起，最多 3 次
start on started framework
stop on stopping framework

respawn
respawn limit 3 300

script
    exec /bin/sh /mnt/us/board.sh
end script
EOF

echo "[4/4] 启动服务"
stop board 2>/dev/null || true
start board 2>/dev/null || /sbin/start board 2>/dev/null || {
  echo "  upstart 启动失败，改为后台常驻"
  nohup sh /mnt/us/board.sh >/dev/null 2>&1 &
}

sleep 8
echo "--- board.log 尾部 ---"
tail -n 10 /mnt/us/board.log 2>/dev/null || echo "  （暂无日志，可能首次下载仍在进行）"
echo "--- 进程 ---"
ps | grep -i board.sh | grep -v grep || echo "  （未发现进程，请检查日志）"
echo
echo "完成。以后每次开机都会自动刷屏；日志在 /mnt/us/board.log"
