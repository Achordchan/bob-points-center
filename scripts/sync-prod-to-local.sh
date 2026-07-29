#!/usr/bin/env bash
# 将生产数据库同步到本地开发库。
#
# 单向：生产 → 本地。脚本对生产库只执行 pg_dump（只读），
# 任何写操作只会落在本地容器上；目标不是 localhost 时直接拒绝执行。
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
LOCAL_CONTAINER="${LOCAL_PG_CONTAINER:-bob-postgres}"
LOCAL_DB="${LOCAL_PG_DATABASE:-bob}"
LOCAL_USER="${LOCAL_PG_USER:-bob}"

DUMP_DIR="${PROJECT_ROOT}/.tmp"
DUMP_FILE="${DUMP_DIR}/prod-$(date +%Y%m%d-%H%M%S).dump"

die() { echo "错误：$*" >&2; exit 1; }

# --- 安全闸门：确认写入目标是本地容器 ---
if [[ "${PROD_HOST}" != "127.0.0.1" && "${PROD_HOST}" != "localhost" ]]; then
  die "PROD_PG_HOST 必须是隧道本地端点（127.0.0.1），当前为 ${PROD_HOST}。本脚本不允许直连远程库。"
fi
if ! docker inspect "${LOCAL_CONTAINER}" >/dev/null 2>&1; then
  die "找不到本地容器 ${LOCAL_CONTAINER}。请先运行：docker compose up -d postgres"
fi
LOCAL_PORT_BINDING="$(docker inspect --format '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostIp}}{{end}}{{end}}' "${LOCAL_CONTAINER}" 2>/dev/null || true)"
if [[ "${LOCAL_PORT_BINDING}" != *"127.0.0.1"* ]]; then
  die "本地容器端口未绑定到 127.0.0.1，拒绝执行以避免误写远端。实际绑定：${LOCAL_PORT_BINDING:-未知}"
fi

: "${PROD_PG_PASSWORD:?请通过环境变量提供生产库密码，例如 PROD_PG_PASSWORD='xxx' bash scripts/sync-prod-to-local.sh}"

# --- 校验隧道连通与凭据 ---
echo "[1/6] 校验生产库连接 ${PROD_HOST}:${PROD_PORT}/${PROD_DB} …"
docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER}" \
  psql -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" \
  -tAc "SELECT 'connected to ' || current_database() || ' @ ' || current_setting('server_version')" \
  || die "无法连接生产库。请确认隧道已开（npm run db:tunnel）且 PROD_PG_PASSWORD 正确。"

# --- 导出（对生产库只读） ---
echo "[2/6] 导出生产数据（只读，custom 格式）…"
mkdir -p "${DUMP_DIR}"
docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER}" \
  pg_dump -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" \
  --format=custom --no-owner --no-privileges \
  > "${DUMP_FILE}"
DUMP_SIZE="$(du -h "${DUMP_FILE}" | cut -f1)"
echo "      已导出：${DUMP_FILE}（${DUMP_SIZE}）"

# --- 记录来源行数，供导入后核对 ---
echo "[3/6] 记录来源行数 …"
SRC_COUNTS="$(docker exec -e PGPASSWORD="${PROD_PG_PASSWORD}" "${LOCAL_CONTAINER}" \
  psql -h host.docker.internal -p "${PROD_PORT}" -U "${PROD_USER}" -d "${PROD_DB}" -tAF$'\t' -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname")"

# --- 重建本地 schema ---
echo "[4/6] 重置本地库 ${LOCAL_DB} 的 public schema …"
docker exec "${LOCAL_CONTAINER}" psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -q -c \
  "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO ${LOCAL_USER}; GRANT ALL ON SCHEMA public TO public;"

# --- 导入本地 ---
echo "[5/6] 导入本地库 …"
docker exec -i "${LOCAL_CONTAINER}" \
  pg_restore -U "${LOCAL_USER}" -d "${LOCAL_DB}" --no-owner --no-privileges --single-transaction \
  < "${DUMP_FILE}"

# --- 核对 ---
echo "[6/6] 核对行数 …"
docker exec "${LOCAL_CONTAINER}" psql -U "${LOCAL_USER}" -d "${LOCAL_DB}" -q -c "ANALYZE;" >/dev/null
DST_COUNTS="$(docker exec "${LOCAL_CONTAINER}" \
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
echo "本地连接：postgresql://${LOCAL_USER}@127.0.0.1:5432/${LOCAL_DB}"
echo "dump 文件保留在 ${DUMP_FILE}（.tmp/ 已被 .gitignore 排除）"
