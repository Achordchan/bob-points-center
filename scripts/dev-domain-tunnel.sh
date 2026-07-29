#!/usr/bin/env bash
# 把本机开发服务暴露到 https://dev.bob.baymaxgroup.com
#
# 链路：
#   钉钉 → https://dev.bob.baymaxgroup.com (nginx @ 111.228.1.199)
#        → 127.0.0.1:18000 (服务器侧，由本脚本反向转发)
#        → 127.0.0.1:8000  (你的本机开发服务)
#
# 服务器侧的 18000 只绑在 127.0.0.1（sshd 默认 GatewayPorts=no），
# 公网无法直连，只能经 nginx 进来。
#
# 前置：本机开发服务已在 8000 端口运行（npm start）。
set -euo pipefail

LOCAL_PORT="${DEV_TUNNEL_LOCAL_PORT:-8000}"
REMOTE_PORT="${DEV_TUNNEL_REMOTE_PORT:-18000}"
REMOTE_HOST="${DEV_TUNNEL_REMOTE_HOST:-111.228.1.199}"
REMOTE_USER="${DEV_TUNNEL_REMOTE_USER:-root}"
DEV_DOMAIN="${DEV_TUNNEL_DOMAIN:-dev.bob.baymaxgroup.com}"

if ! lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "本机 ${LOCAL_PORT} 端口没有服务在监听。请先在另一个终端运行 npm start。" >&2
  exit 1
fi

echo "开发域名隧道：https://${DEV_DOMAIN} -> 本机 127.0.0.1:${LOCAL_PORT}"
echo "保持这个终端不要关闭；结束开发时按 Ctrl+C。"
echo "隧道断开后 ${DEV_DOMAIN} 会返回 502，属正常现象。"

# -R 在服务器侧监听 REMOTE_PORT 并转发到本机 LOCAL_PORT
exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -N \
  -R "${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
  "${REMOTE_USER}@${REMOTE_HOST}"
