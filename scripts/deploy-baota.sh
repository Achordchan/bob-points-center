#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-111.228.1.199}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/www/wwwroot/bob.baymaxgroup.com}"
DEPLOY_PROJECT="${DEPLOY_PROJECT:-bob_points_center}"
DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION:-v20.19.0}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-bob.baymaxgroup.com}"
DEPLOY_PORT="${DEPLOY_PORT:-8000}"
SSH_OPTS="${SSH_OPTS:-}"

NODE_BIN="/www/server/nodejs/${DEPLOY_NODE_VERSION}/bin"
PANEL_PY="/www/server/panel/pyenv/bin/python"

echo "部署到宝塔项目：${DEPLOY_PROJECT}"
echo "目标目录：${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"

# 服务器 npm ci --omit=dev 无 Vite；构建产物必须在部署前准备好。
# CI 工作流若已 build，可设置 SKIP_LOCAL_BUILD=1 避免重复构建。
if [ "${SKIP_LOCAL_BUILD:-0}" = "1" ]; then
  echo "跳过本地构建（SKIP_LOCAL_BUILD=1）"
  if [ ! -f "src/pages/admin-app-dist/index.html" ]; then
    echo "SKIP_LOCAL_BUILD=1 但缺少 src/pages/admin-app-dist/index.html"
    exit 1
  fi
else
  echo "本地构建后台 admin-app ..."
  npm run build
fi

rsync -az --delete \
  --omit-dir-times \
  --no-perms \
  --no-owner \
  --no-group \
  -e "ssh ${SSH_OPTS}" \
  --exclude ".git/" \
  --exclude ".github/" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude ".ssh/" \
  --exclude ".well-known/" \
  --exclude "node_modules/" \
  --exclude "bt-start.sh" \
  --exclude "data.db" \
  --exclude "_deploy/" \
  --exclude "历史版本/" \
  --exclude "uploads/" \
  --exclude "public/uploads/" \
  --exclude "storage/" \
  --exclude "data/" \
  --exclude "data/admin-backups/" \
  --exclude "bob-admin-backups/" \
  --exclude "logs/" \
  --exclude "*.log" \
  --exclude "bob-*.tar.gz" \
  --exclude "bob-pg*" \
  --exclude "bob-sqlite" \
  ./ "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"

ssh ${SSH_OPTS} "${DEPLOY_USER}@${DEPLOY_HOST}" \
  DEPLOY_HOST="${DEPLOY_HOST}" \
  DEPLOY_PATH="${DEPLOY_PATH}" \
  DEPLOY_PROJECT="${DEPLOY_PROJECT}" \
  DEPLOY_NODE_VERSION="${DEPLOY_NODE_VERSION}" \
  DEPLOY_DOMAIN="${DEPLOY_DOMAIN}" \
  DEPLOY_PORT="${DEPLOY_PORT}" \
  NODE_BIN="${NODE_BIN}" \
  PANEL_PY="${PANEL_PY}" \
  'bash -s' <<'REMOTE'
set -euo pipefail

cd "${DEPLOY_PATH}"

if [ ! -f ".env" ]; then
  echo "缺少服务器 .env，停止部署。"
  exit 1
fi

# HTTPS 站点：若未配置 NODE_ENV/COOKIE_SECURE，追加安全默认值（不覆盖已有键）
ensure_env_kv() {
  local key="$1"
  local val="$2"
  if ! grep -Eq "^${key}=" .env; then
    printf '\n%s=%s\n' "${key}" "${val}" >> .env
    echo "已写入 .env 缺省 ${key}=${val}"
  fi
}
ensure_env_kv "NODE_ENV" "production"
ensure_env_kv "COOKIE_SECURE" "true"
ensure_env_kv "TRUST_PROXY" "true"

# 生产会话密钥：WEB 与 ADMIN 必须独立；缺失或相同则生成 WEB_SESSION_SECRET
get_env_kv() {
  local key="$1"
  if [ -f .env ]; then
    grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true
  fi
}
admin_secret="$(get_env_kv ADMIN_SESSION_SECRET | tr -d '\r')"
web_secret="$(get_env_kv WEB_SESSION_SECRET | tr -d '\r')"
if [ -z "${admin_secret}" ]; then
  echo "生产环境缺少 ADMIN_SESSION_SECRET，停止部署。请在服务器 .env 中配置后重试。"
  exit 1
fi
if [ -z "${web_secret}" ] || [ "${web_secret}" = "${admin_secret}" ]; then
  new_web="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if [ -z "${new_web}" ] || [ "${new_web}" = "${admin_secret}" ]; then
    echo "无法生成 WEB_SESSION_SECRET，停止部署。"
    exit 1
  fi
  if grep -Eq "^WEB_SESSION_SECRET=" .env; then
    tmp_env="$(mktemp)"
    awk -v v="${new_web}" 'BEGIN{done=0} /^WEB_SESSION_SECRET=/{print "WEB_SESSION_SECRET=" v; done=1; next} {print} END{if(!done) print "WEB_SESSION_SECRET=" v}' .env > "${tmp_env}"
    mv "${tmp_env}" .env
  else
    printf '\nWEB_SESSION_SECRET=%s\n' "${new_web}" >> .env
  fi
  echo "已写入/更新服务器 .env 的 WEB_SESSION_SECRET（独立随机密钥）"
fi

# 后台静态资源必须存在（由本地 npm run build 后 rsync 带上）
if [ ! -f "src/pages/admin-app-dist/index.html" ]; then
  echo "缺少 src/pages/admin-app-dist/index.html。请在部署前于本机执行 npm run build。"
  exit 1
fi

NPM_CLI="${NODE_BIN}/../lib/node_modules/npm/bin/npm-cli.js"

if [ -f "package-lock.json" ]; then
  "${NODE_BIN}/node" "${NPM_CLI}" ci --omit=dev
else
  "${NODE_BIN}/node" "${NPM_CLI}" install --omit=dev
fi

chown -R www:www "${DEPLOY_PATH}"

"${PANEL_PY}" - <<'PY'
import json
import sys
sys.path.insert(0, "/www/server/panel/class")
import public
from projectModel.nodejsModel import main

project = public.dict_obj()
project.project_name = __import__("os").environ["DEPLOY_PROJECT"]
model = main()
print(json.dumps(model.stop_project(project), ensure_ascii=False))
print(json.dumps(model.start_project(project), ensure_ascii=False))
PY

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${DEPLOY_PORT}/health" >/dev/null; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:${DEPLOY_PORT}/health"
echo
curl -k -fsS --resolve "${DEPLOY_DOMAIN}:443:${DEPLOY_HOST}" "https://${DEPLOY_DOMAIN}/health"
echo
REMOTE

echo "部署完成。"
