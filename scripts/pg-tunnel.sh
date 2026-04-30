#!/usr/bin/env bash
set -euo pipefail

LOCAL_PORT="${PG_TUNNEL_LOCAL_PORT:-35432}"
REMOTE_HOST="${PG_TUNNEL_REMOTE_HOST:-111.228.1.199}"
REMOTE_USER="${PG_TUNNEL_REMOTE_USER:-root}"
REMOTE_PG_HOST="${PG_TUNNEL_REMOTE_PG_HOST:-127.0.0.1}"
REMOTE_PG_PORT="${PG_TUNNEL_REMOTE_PG_PORT:-5432}"

if lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "本机端口 ${LOCAL_PORT} 已在监听，先确认是不是已有数据库隧道。"
  lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN
  exit 1
fi

echo "打开数据库隧道：127.0.0.1:${LOCAL_PORT} -> ${REMOTE_HOST}:${REMOTE_PG_PORT}"
echo "保持这个终端不要关闭；结束开发时按 Ctrl+C。"

exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -N \
  -L "${LOCAL_PORT}:${REMOTE_PG_HOST}:${REMOTE_PG_PORT}" \
  "${REMOTE_USER}@${REMOTE_HOST}"
