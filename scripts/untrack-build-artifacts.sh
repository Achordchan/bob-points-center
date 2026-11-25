#!/usr/bin/env bash
# 仅取消 Git 跟踪构建产物/残留，不删除工作区文件。
# 重要：取消跟踪后，部署必须先在本机 npm run build，再 rsync（scripts/deploy.sh 已内置）。
# 服务器 npm ci --omit=dev 不会构建 admin-app。
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f "src/pages/admin-app-dist/index.html" ]; then
  echo "警告: 工作区暂无 admin-app-dist；执行 untrack 前建议先 npm run build，避免误以为产物可丢。"
fi
git rm -r --cached --ignore-unmatch src/pages/admin-app-dist >/dev/null || true
git rm --cached --ignore-unmatch src/middleware/requireApiToken.js data.db >/dev/null || true
echo "ok: build artifacts untracked from git index (files kept on disk if present)"
echo "next: commit .gitignore + this index change; deploy via scripts/deploy.sh (builds first)"
git status -sb | head -40
