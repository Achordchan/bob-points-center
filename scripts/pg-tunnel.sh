#!/usr/bin/env bash
# 打开到生产 PostgreSQL 的 SSH 隧道：本机 127.0.0.1:35432 → bob-hk 上的 127.0.0.1:5432。
# 生产库只监听服务器本机，不对公网开放；本地开发 / db:sync-from-prod 都经由这条隧道访问。
set -euo pipefail

# 旧变量 PG_TUNNEL_REMOTE_HOST / PG_TUNNEL_REMOTE_USER 已废弃：明确报错，避免旧启动配置被静默忽略而连到别的库。
if [ -n "${PG_TUNNEL_REMOTE_HOST:-}" ] || [ -n "${PG_TUNNEL_REMOTE_USER:-}" ]; then
  echo "PG_TUNNEL_REMOTE_HOST / PG_TUNNEL_REMOTE_USER 已废弃，请改用 PG_TUNNEL_SSH_TARGET（SSH 别名或 user@host）。" >&2
  exit 1
fi

LOCAL_PORT="${PG_TUNNEL_LOCAL_PORT:-35432}"
# SSH 目标默认用 ~/.ssh/config 里的别名 bob-hk（43.161.221.5，用户 ubuntu）。
SSH_TARGET="${PG_TUNNEL_SSH_TARGET:-bob-hk}"
REMOTE_PG_HOST="${PG_TUNNEL_REMOTE_PG_HOST:-127.0.0.1}"
REMOTE_PG_PORT="${PG_TUNNEL_REMOTE_PG_PORT:-5432}"

if lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "本机端口 ${LOCAL_PORT} 已在监听，先确认是不是已有数据库隧道。"
  lsof -nP -iTCP:"${LOCAL_PORT}" -sTCP:LISTEN
  exit 1
fi

echo "打开数据库隧道：127.0.0.1:${LOCAL_PORT} -> ${SSH_TARGET} ${REMOTE_PG_HOST}:${REMOTE_PG_PORT}"
echo "保持这个终端不要关闭；结束开发时按 Ctrl+C。"

exec ssh \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -N \
  -L "127.0.0.1:${LOCAL_PORT}:${REMOTE_PG_HOST}:${REMOTE_PG_PORT}" \
  "${SSH_TARGET}"
