#!/usr/bin/env bash
# 将生产数据库同步到本地开发库。
#
# 单向：生产 → 本地。脚本对生产库只执行 pg_dump（只读），
# 任何写操作只会落在经过多重身份校验的本地 Compose PostgreSQL 容器。
#
# 前置条件：
#   1. 数据库隧道已开：npm run db:tunnel
#   2. 本地容器已起：docker compose up -d postgres
#   3. 生产库密码通过环境变量 PROD_PG_PASSWORD 提供
#
# 用法：
#   PROD_PG_PASSWORD='xxx' bash scripts/sync-prod-to-local.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

# --- 生产（只读来源） ---
PROD_HOST="${PROD_PG_HOST:-127.0.0.1}"
PROD_PORT="${PROD_PG_PORT:-35432}"
PROD_DB="${PROD_PG_DATABASE:-bob}"
PROD_USER="${PROD_PG_USER:-bob}"

# --- 本地（写入目标） ---
LOCAL_DB="${LOCAL_PG_DATABASE:-bob}"
LOCAL_USER="${LOCAL_PG_USER:-bob}"

DUMP_DIR="${PROJECT_ROOT}/.tmp"
DUMP_FILE="${DUMP_DIR}/prod-$(date +%Y%m%d-%H%M%S).dump"

die() { echo "错误：$*" >&2; exit 1; }

is_local_docker_endpoint() {
  [[ "$1" == unix:///* ]]
}

if [[ "${PROD_HOST}" != "127.0.0.1" && "${PROD_HOST}" != "localhost" ]]; then
  die "PROD_PG_HOST 必须是隧道本地端点（127.0.0.1），当前为 ${PROD_HOST}。本脚本不允许直连远程库。"
fi
if [[ ! "${LOCAL_DB}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  die "LOCAL_PG_DATABASE 不是合法的 PostgreSQL 标识符。"
fi
if [[ ! "${LOCAL_USER}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  die "LOCAL_PG_USER 不是合法的 PostgreSQL 标识符。"
fi
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令。"
docker compose version >/dev/null 2>&1 || die "当前 Docker 未提供 compose 插件。"

# DOCKER_CONTEXT 优先于 DOCKER_HOST；但任一显式值指向远程 endpoint 都直接拒绝，避免环境污染。
if [[ -n "${DOCKER_HOST:-}" ]] && ! is_local_docker_endpoint "${DOCKER_HOST}"; then
  die "DOCKER_HOST 指向非本地 Unix socket：${DOCKER_HOST}。拒绝操作远程 Docker daemon。"
fi

ACTIVE_CONTEXT="${DOCKER_CONTEXT:-$(docker context show 2>/dev/null || true)}"
[[ -n "${ACTIVE_CONTEXT}" ]] || die "无法确定当前 Docker Context。"
CONTEXT_ENDPOINT="$(docker context inspect --format '{{ .Endpoints.docker.Host }}' "${ACTIVE_CONTEXT}" 2>/dev/null || true)"
[[ -n "${CONTEXT_ENDPOINT}" ]] || die "无法解析 Docker Context ${ACTIVE_CONTEXT} 的 endpoint。"
is_local_docker_endpoint "${CONTEXT_ENDPOINT}" \
  || die "Docker Context ${ACTIVE_CONTEXT} 指向非本地 endpoint：${CONTEXT_ENDPOINT}。"

COMPOSE_CONTAINER_IDS="$(docker compose ps -q postgres 2>/dev/null || true)"
[[ -n "${COMPOSE_CONTAINER_IDS//[[:space:]]/}" ]] \
  || die "找不到 Compose postgres 服务容器。请先运行：docker compose up -d postgres"
CONTAINER_COUNT="$(printf '%s\n' "${COMPOSE_CONTAINER_IDS}" | grep -cve '^[[:space:]]*$')"
[[ "${CONTAINER_COUNT}" == "1" ]] || die "Compose postgres 服务必须且只能对应一个容器，当前为 ${CONTAINER_COUNT} 个。"
LOCAL_CONTAINER_ID="$(printf '%s\n' "${COMPOSE_CONTAINER_IDS}" | grep -ve '^[[:space:]]*$')"

CONTAINER_IDENTITY="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}|{{ index .Config.Labels "bob.environment" }}|{{ .State.Running }}' "${LOCAL_CONTAINER_ID}" 2>/dev/null || true)"
[[ "${CONTAINER_IDENTITY}" == "postgres|development|true" ]] \
  || die "Compose 容器身份校验失败，期望 postgres|development|true，实际为 ${CONTAINER_IDENTITY:-未知}。"
LOCAL_PORT_BINDING="$(docker inspect --format '{{range (index .NetworkSettings.Ports "5432/tcp")}}{{.HostIp}}:{{.HostPort}}{{end}}' "${LOCAL_CONTAINER_ID}" 2>/dev/null || true)"
[[ "${LOCAL_PORT_BINDING}" == 127.0.0.1:* ]] \
  || die "本地 PostgreSQL 端口未唯一绑定到 127.0.0.1，实际绑定：${LOCAL_PORT_BINDING:-未知}。"

DB_IDENTITY="$(docker exec "${LOCAL_CONTAINER_ID}" psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -tA -F '|' -c \
  "SELECT current_database(), current_setting('bob.environment', true)" 2>/dev/null || true)"
[[ "${DB_IDENTITY}" == "${LOCAL_DB}|development" ]] \
  || die "本地数据库身份校验失败，期望 ${LOCAL_DB}|development，实际为 ${DB_IDENTITY:-未知}。"

: "${PROD_PG_PASSWORD:?请通过环境变量提供生产库密码，例如 PROD_PG_PASSWORD='xxx' bash scripts/sync-prod-to-local.sh}"

echo "[1/6] 校验生产库连接 ${PROD_HOST}:${PROD_PORT}/${PROD_DB} …"
docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER_ID}" \
  psql -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" \
  -tAc "SELECT 'connected to ' || current_database() || ' @ ' || current_setting('server_version')" \
  || die "无法连接生产库。请确认隧道已开（npm run db:tunnel）且 PROD_PG_PASSWORD 正确。"

echo "[2/6] 导出生产数据（只读，custom 格式）…"
mkdir -p "${DUMP_DIR}"
docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER_ID}" \
  pg_dump -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" \
  --format=custom --no-owner --no-privileges \
  > "${DUMP_FILE}"
DUMP_SIZE="$(du -h "${DUMP_FILE}" | cut -f1)"
echo "      已导出：${DUMP_FILE}（${DUMP_SIZE}）"

echo "[3/6] 记录来源行数 …"
SRC_COUNTS="$(docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER_ID}" \
  psql -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" -tAF$'\t' -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname")"

echo "[4/6] 在单个事务中重置并恢复本地库 ${LOCAL_DB} …"
{
  printf '%s\n' 'BEGIN;'
  printf '%s\n' 'DROP SCHEMA public CASCADE;'
  printf '%s\n' 'CREATE SCHEMA public AUTHORIZATION CURRENT_USER;'
  if ! docker exec -i "${LOCAL_CONTAINER_ID}" \
    pg_restore --no-owner --no-privileges --file=- < "${DUMP_FILE}"; then
    echo "错误：无法解析生产备份，恢复事务将回滚。" >&2
    exit 1
  fi
  printf '%s\n' 'COMMIT;'
} | docker exec -i "${LOCAL_CONTAINER_ID}" \
  psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -v ON_ERROR_STOP=1 -q

echo "[5/6] 本地事务已提交 …"

echo "[6/6] 核对行数 …"
docker exec "${LOCAL_CONTAINER_ID}" psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -q -c "ANALYZE;" >/dev/null
DST_COUNTS="$(docker exec "${LOCAL_CONTAINER_ID}" \
  psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -tAF$'\t' -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname")"

printf '\n%-34s %12s %12s %s\n' "表" "生产" "本地" "状态"
printf '%s\n' "----------------------------------------------------------------------"
MISMATCH=0
while IFS=$'\t' read -r tbl src; do
  [[ -z "${tbl}" ]] && continue
  dst="$(printf '%s\n' "${DST_COUNTS}" | awk -F'\t' -v t="${tbl}" '$1==t {print $2}')"
  dst="${dst:-缺失}"
  if [[ "${src}" == "${dst}" ]]; then
    status="一致"
  else
    status="不一致"
    MISMATCH=1
  fi
  printf '%-34s %12s %12s %s\n' "${tbl}" "${src}" "${dst}" "${status}"
done <<< "${SRC_COUNTS}"

echo
if (( MISMATCH )); then
  echo "注意：存在行数差异。pg_stat 为估算值，若差异集中在高频写入表可重跑核对；持续不一致请检查导入日志。"
else
  echo "同步完成，所有表行数一致。"
fi
echo "本地连接：postgresql://${LOCAL_USER}@${LOCAL_PORT_BINDING}/${LOCAL_DB}"
echo "dump 文件保留在 ${DUMP_FILE}（.tmp/ 已被 .gitignore 排除）"
