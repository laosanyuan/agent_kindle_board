#!/bin/bash
# 群晖 NAS 一键部署脚本（在 NAS 的 SSH 终端里执行）
#
# 前置：把项目目录（含 config.yaml、deploy/xray/config.json、两个 *.tar.gz）放到 NAS 上，
#       然后： bash nas-setup.sh
#
# 只做「创建/启动」，不会删除任何已有容器；已存在同名容器会提示并跳过。
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8787
NET=kindle-net
BOARD_IMG=agent-kindle-board:0.1.4
XRAY_IMG=ghcr.io/xtls/xray-core:latest

# 群晖的 docker 可能不在普通用户 PATH 里，逐个探测
if command -v docker >/dev/null 2>&1; then DOCKER=docker
elif [ -x /usr/local/bin/docker ]; then DOCKER=/usr/local/bin/docker
else echo "未找到 docker，请先在套件中心安装 Container Manager"; exit 1; fi

# 群晖普通用户无 docker 权限，需要 sudo
run() { if $DOCKER "$@" 2>/dev/null; then :; else sudo $DOCKER "$@"; fi; }

echo "== docker 版本 =="
run version --format '{{.Server.Version}}'

# 1) 导入镜像（没有 tar 包就跳过，假定已导入或能直接 pull）
for f in "$APP_DIR"/agent-kindle-board-0.1.4-amd64.tar.gz "$APP_DIR"/xray-core-latest.tar.gz; do
  [ -f "$f" ] || continue
  echo "== 导入 $(basename "$f") =="
  run load -i "$f"
done

# 2) 检查配置文件
[ -f "$APP_DIR/config.yaml" ] || { echo "缺少 config.yaml"; exit 1; }
[ -f "$APP_DIR/deploy/xray/config.json" ] || { echo "缺少 deploy/xray/config.json"; exit 1; }

# 3) 网络
if ! run network inspect "$NET" >/dev/null 2>&1; then run network create "$NET"; fi

# 4) xray（出网代理）
if run ps -a --format '{{.Names}}' | grep -qx xray; then
  echo "xray 容器已存在，重启它"
  run restart xray
else
  run run -d --name xray --network "$NET" --restart unless-stopped \
    -v "$APP_DIR/deploy/xray/config.json:/etc/xray/config.json:ro" \
    "$XRAY_IMG" run -c /etc/xray/config.json
fi

# 5) board 面板
if run ps -a --format '{{.Names}}' | grep -qx agent-kindle-board; then
  echo "board 容器已存在，重启它"
  run restart agent-kindle-board
else
  run run -d --name agent-kindle-board --network "$NET" --restart unless-stopped \
    -p "$PORT:8787" -e TZ=Asia/Shanghai \
    -v "$APP_DIR/config.yaml:/app/config.yaml:ro" \
    "$BOARD_IMG"
fi

# 6) 冒烟：等首次采集完成，打印各平台状态
echo "== 等待首次采集 =="
sleep 30
if command -v curl >/dev/null 2>&1; then
  curl -s "http://127.0.0.1:$PORT/api/data" | grep -o '"id": "[a-z]*"\|"ok": [a-z]*\|"error": "[^"]*"' | head -20
else
  echo "无 curl，请浏览器打开 http://<NAS_IP>:$PORT/image.png?raw=1 查看"
fi

echo
echo "== 完成 =="
echo "面板地址: http://<NAS_IP>:$PORT/image.png"
echo "Kindle 脚本里把 NAS 地址改成 http://<NAS_IP>:$PORT"
echo "排查: docker logs agent-kindle-board"
