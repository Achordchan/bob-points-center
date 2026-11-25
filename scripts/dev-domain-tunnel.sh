#!/usr/bin/env bash
# 把本机开发服务暴露到 https://dev.b.achord.cn
#
# 链路：
#   钉钉 → https://dev.b.achord.cn (nginx @ bob-hk 43.161.221.5)
#        → 127.0.0.1:18000 (服务器侧，由本脚本反向转发)
#        → 127.0.0.1:8000  (你的本机开发服务)
#
# 服务器侧的 18000 只绑在 127.0.0.1（sshd GatewayPorts=no），
# 公网无法直连，只能经 nginx 进来。
#
# 前置：本机开发服务已在 8000 端口运行（npm start）；
#       服务器上已配置 dev.b.achord.cn 的 nginx 站点（反代到 127.0.0.1:18000）与证书。
set -euo pipefail

LOCAL_PORT="${DEV_TUNNEL_LOCAL_PORT:-8000}"
REMOTE_PORT="${DEV_TUNNEL_REMOTE_PORT:-18000}"
# SSH 目标默认用 ~/.ssh/config 里的别名 bob-hk（43.161.221.5，用户 ubuntu）。
SSH_TARGET="${DEV_TUNNEL_SSH_TARGET:-bob-hk}"
DEV_DOMAIN="${DEV_TUNNEL_DOMAIN:-dev.b.achord.cn}"

if ! lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "本机 ${LOCAL_PORT} 端口没有服务在监听。请先在另一个终端运行 npm start。" >&2
  exit 1
fi

echo "开发域名隧道：https://${DEV_DOMAIN} -> 本机 127.0.0.1:${LOCAL_PORT}"
echo "保持这个终端不要关闭；结束开发时按 Ctrl+C。"
echo "隧道断开后 ${DEV_DOMAIN} 会返回 502，属正常现象。"

# -R 在服务器侧 127.0.0.1:REMOTE_PORT 监听并转发到本机 LOCAL_PORT
exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -N \
  -R "127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
  "${SSH_TARGET}"
