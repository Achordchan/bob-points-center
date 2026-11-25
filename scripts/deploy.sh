#!/usr/bin/env bash
# 部署到生产服务器（腾讯云香港轻量，SSH 别名 bob-hk）。
#
# 流程：
#   本机 npm run build 构建管理端
#   → 服务器在暂存目录 sudo -u bob npm ci --omit=dev（失败时线上目录完全不动）
#   → rsync 同步到 /srv/bob/app（以 bob 用户写入，保留 .env、node_modules、上传文件等运行期文件）
#   → 用暂存目录装好的 node_modules 替换线上 node_modules
#   → sudo systemctl restart bob
#   → 检查 https://b.achord.cn/health 返回 {"ok":true}
#
# 用法：
#   npm run deploy                 # 正式部署
#   DRY_RUN=1 npm run deploy       # 只预览 rsync 会改动哪些文件，不改应用目录、不重启
#
# 部署前建议先在服务器做一次数据库备份：
#   ssh bob-hk 'sudo /usr/local/sbin/bob-backup.sh'
set -euo pipefail

DEPLOY_SSH="${DEPLOY_SSH:-bob-hk}"
DEPLOY_PATH="${DEPLOY_PATH:-/srv/bob/app}"
DEPLOY_APP_USER="${DEPLOY_APP_USER:-bob}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-bob}"
DEPLOY_NODE_DIR="${DEPLOY_NODE_DIR:-/opt/node/bin}"
DEPLOY_PORT="${DEPLOY_PORT:-8000}"
DEPLOY_BASE_URL="${DEPLOY_BASE_URL:-https://b.achord.cn}"
# 依赖暂存目录，须与 DEPLOY_PATH 同一文件系统（切换用 mv）。
DEPLOY_STAGE="${DEPLOY_STAGE:-/srv/bob/.deploy-stage}"
DRY_RUN="${DRY_RUN:-0}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

die() { echo "错误：$*" >&2; exit 1; }

# rsync 同步的是本机工作区，必须是干净的 origin/main，避免把未提交或别的分支的改动发到生产。
if [ "${ALLOW_DIRTY:-0}" != "1" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    git status --short >&2
    die "工作区不干净（含未跟踪文件）。请先提交或清理；确需强制部署可设 ALLOW_DIRTY=1。"
  fi
  git fetch -q origin main || die "git fetch origin main 失败。"
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
    die "当前 HEAD 不是 origin/main（$(git rev-parse --short HEAD) ≠ $(git rev-parse --short origin/main)）。请切到最新 main 再部署；确需强制可设 ALLOW_DIRTY=1。"
  fi
fi

echo "部署目标：${DEPLOY_SSH}:${DEPLOY_PATH}（服务 ${DEPLOY_SERVICE}.service）"
echo "版本：$(git rev-parse --short HEAD) $(git log -1 --format=%s)"

if [ "${SKIP_LOCAL_BUILD:-0}" = "1" ]; then
  echo "跳过本地构建（SKIP_LOCAL_BUILD=1）"
else
  echo "[1/5] 本地构建管理端 admin-app …"
  npm run build
fi
[ -f "src/pages/admin-app-dist/index.html" ] || die "缺少 src/pages/admin-app-dist/index.html，构建失败或未构建。"

# 服务器侧部署锁（mkdir 原子），覆盖从 rsync 到验证结束，同一时间只允许一次部署或预览。
# 锁在 /run/lock（tmpfs），服务器重启后自动消失。
DEPLOY_LOCK="${DEPLOY_LOCK:-/var/lock/bob-deploy.lock}"
if ! ssh "${DEPLOY_SSH}" "sudo mkdir '${DEPLOY_LOCK}' 2>/dev/null"; then
  holder="$(ssh "${DEPLOY_SSH}" "sudo cat '${DEPLOY_LOCK}/owner' 2>/dev/null" || true)"
  die "服务器上已有部署在进行（${holder:-持有者未知}）。若确认是中断后残留的锁，可执行：ssh ${DEPLOY_SSH} 'sudo rm -rf ${DEPLOY_LOCK}'"
fi
release_lock() { ssh "${DEPLOY_SSH}" "sudo rm -rf '${DEPLOY_LOCK}'" || echo "警告：释放部署锁失败，请手动执行 ssh ${DEPLOY_SSH} 'sudo rm -rf ${DEPLOY_LOCK}'" >&2; }
trap release_lock EXIT
lock_owner="$(whoami)@$(hostname -s) pid=$$ $(date '+%F %T') $(git rev-parse --short HEAD)"
ssh "${DEPLOY_SSH}" "printf '%s\\n' '${lock_owner}' | sudo tee '${DEPLOY_LOCK}/owner' >/dev/null" || true

# 运行期文件一律排除：被排除的路径不会被 --delete 删除。
RSYNC_EXCLUDES=(
  --exclude ".git/"
  --exclude ".github/"
  --exclude ".claude/"
  --exclude ".env"
  --exclude ".env.*"
  --exclude ".ssh/"
  --exclude "node_modules/"
  --exclude ".tmp/"
  --exclude "uploads/"
  --exclude "public/uploads/"
  --exclude "storage/"
  --exclude "data/"
  --exclude "data.db"
  --exclude "bob-admin-backups/"
  --exclude "logs/"
  --exclude "*.log"
  --exclude "bob-*.tar.gz"
  --exclude "bob-pg*"
  --exclude "bob-sqlite"
  --exclude ".DS_Store"
)

REMOTE_ENV=(
  DEPLOY_PATH="${DEPLOY_PATH}"
  DEPLOY_STAGE="${DEPLOY_STAGE}"
  DEPLOY_APP_USER="${DEPLOY_APP_USER}"
  DEPLOY_SERVICE="${DEPLOY_SERVICE}"
  DEPLOY_NODE_DIR="${DEPLOY_NODE_DIR}"
  DEPLOY_PORT="${DEPLOY_PORT}"
)

if [ "${DRY_RUN}" != "1" ]; then
  echo "[2/5] 服务器暂存目录安装生产依赖（线上目录不动）…"
  ssh "${DEPLOY_SSH}" "${REMOTE_ENV[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
# 只检查 .env 是否存在以及关键键是否配置，不回显、不修改任何值。
sudo test -f "${DEPLOY_PATH}/.env" || { echo "缺少 ${DEPLOY_PATH}/.env，停止部署。" >&2; exit 1; }
for key in SERVER_BASE_URL ADMIN_SESSION_SECRET WEB_SESSION_SECRET; do
  if ! sudo grep -Eq "^${key}=.+" "${DEPLOY_PATH}/.env"; then
    echo ".env 缺少 ${key}，停止部署。" >&2
    exit 1
  fi
done
sudo -u "${DEPLOY_APP_USER}" rm -rf "${DEPLOY_STAGE}"
sudo -u "${DEPLOY_APP_USER}" mkdir -p "${DEPLOY_STAGE}"
REMOTE
  rsync -rlt --no-perms --no-owner --no-group -e "ssh" \
    --rsync-path="sudo -u ${DEPLOY_APP_USER} rsync" \
    package.json package-lock.json "${DEPLOY_SSH}:${DEPLOY_STAGE}/"
  ssh "${DEPLOY_SSH}" "${REMOTE_ENV[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail
sudo -H -u "${DEPLOY_APP_USER}" env PATH="${DEPLOY_NODE_DIR}:/usr/local/bin:/usr/bin:/bin" \
  sh -c 'cd "$1" && npm ci --omit=dev --no-audit --no-fund' sh "${DEPLOY_STAGE}"
sudo test -d "${DEPLOY_STAGE}/node_modules" || { echo "暂存目录没有生成 node_modules，停止部署。" >&2; exit 1; }
REMOTE
fi

RSYNC_OPTS=(-rltz --delete --no-perms --no-owner --no-group)
if [ "${DRY_RUN}" = "1" ]; then
  RSYNC_OPTS+=(--dry-run -v)
  echo "[2/5] 预览 rsync 改动（DRY_RUN=1，不改应用目录）…"
else
  echo "[3/5] rsync 同步代码 …"
fi

rsync "${RSYNC_OPTS[@]}" \
  -e "ssh" \
  --rsync-path="sudo -u ${DEPLOY_APP_USER} rsync" \
  "${RSYNC_EXCLUDES[@]}" \
  ./ "${DEPLOY_SSH}:${DEPLOY_PATH}/"

if [ "${DRY_RUN}" = "1" ]; then
  echo "DRY_RUN=1：到此为止，没有安装依赖，也没有重启服务。"
  exit 0
fi

echo "[4/5] 切换依赖、重启并检查日志 …"
ssh "${DEPLOY_SSH}" "${REMOTE_ENV[@]}" 'bash -s' <<'REMOTE'
set -euo pipefail

# 用暂存目录装好的依赖替换线上 node_modules（同一文件系统内 mv，旧依赖先挪开再删除）。
prev="${DEPLOY_STAGE}.node_modules.prev"
sudo -u "${DEPLOY_APP_USER}" rm -rf "${prev}"
if sudo test -d "${DEPLOY_PATH}/node_modules"; then
  sudo -u "${DEPLOY_APP_USER}" mv "${DEPLOY_PATH}/node_modules" "${prev}"
fi
sudo -u "${DEPLOY_APP_USER}" mv "${DEPLOY_STAGE}/node_modules" "${DEPLOY_PATH}/node_modules"
sudo -u "${DEPLOY_APP_USER}" rm -rf "${prev}" "${DEPLOY_STAGE}"

LOG=/var/log/bob/app.log
# 行数在 sudo 内读取（ubuntu 不一定有读权限）；日志不存在时从第 1 行看起，读取失败则停止。
if sudo test -e "${LOG}"; then
  log_lines="$(sudo wc -l "${LOG}" | awk '{print $1}')"
  [[ "${log_lines}" =~ ^[0-9]+$ ]] || { echo "无法读取 ${LOG} 行数，停止部署。" >&2; exit 1; }
else
  log_lines=0
fi
log_start=$(( log_lines + 1 ))
sudo systemctl restart "${DEPLOY_SERVICE}"

ok=0
# 每次请求限时 5 秒，总时限 30 秒（含请求耗时），应用挂起时也不会无限等待。
deadline=$(( SECONDS + 30 ))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  if curl -fsS --connect-timeout 3 --max-time 5 "http://127.0.0.1:${DEPLOY_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [ "${ok}" != "1" ]; then
  echo "服务 30 秒内未通过本机健康检查。最近日志：" >&2
  sudo tail -n 40 "${LOG}" >&2 || true
  exit 1
fi
systemctl is-active "${DEPLOY_SERVICE}"

# 只看本次重启之后新写入的日志。
stream_ok=0
for _ in $(seq 1 15); do
  if sudo tail -n "+${log_start}" "${LOG}" | grep -q '\[DingtalkStream\] connected'; then stream_ok=1; break; fi
  sleep 2
done
if [ "${stream_ok}" = "1" ]; then
  echo "日志：[DingtalkStream] connected"
else
  echo "警告：重启后 30 秒内日志里没有 [DingtalkStream] connected，请手动检查 ${LOG}" >&2
fi
errors="$(sudo tail -n "+${log_start}" "${LOG}" | grep -iE 'error|exception|unhandled' || true)"
if [ -n "${errors}" ]; then
  echo "警告：重启后日志出现以下 error 行：" >&2
  printf '%s\n' "${errors}" | tail -n 20 >&2
else
  echo "日志：重启后没有 error 行"
fi
REMOTE

echo "[5/5] 公网健康检查 ${DEPLOY_BASE_URL}/health …"
health=""
# 每次请求限时 10 秒，总时限 30 秒（含请求耗时）。
deadline=$(( SECONDS + 30 ))
while [ "${SECONDS}" -lt "${deadline}" ]; do
  health="$(curl -fsS --connect-timeout 5 --max-time 10 "${DEPLOY_BASE_URL}/health" 2>/dev/null || true)"
  if printf '%s' "${health}" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then break; fi
  sleep 2
done
printf '%s\n' "${health}"
printf '%s' "${health}" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' || die "公网健康检查未返回 {\"ok\":true}。"

echo "部署完成。"
