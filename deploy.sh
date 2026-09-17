#!/usr/bin/env bash
# 从源项目同步发布产物到本仓库并推送。
#
# 为什么要有这个脚本：这个目录是**产物**，手改会在下次同步时被覆盖；
# 而「重建 → 同步 → 推送」三步一旦靠手做，早晚会漏掉其中一步 ——
# 典型症状是线上还是旧数据，本地却以为已经发出去了。
#
# 源目录默认 $HOME/Desktop/jd-insight，可用 JD_INSIGHT_SRC 覆盖。
set -euo pipefail

SRC="${JD_INSIGHT_SRC:-$HOME/Desktop/jd-insight}"
DST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "① 重建产物（$SRC/tools/web_build.py）"
"$SRC/.venv/bin/python" "$SRC/tools/web_build.py"

echo "② 同步到仓库（rsync --delete）"
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'README.md' --exclude '.gitignore' --exclude 'deploy.sh' \
  "$SRC/publish/" "$DST/"

echo "③ 提交并推送"
cd "$DST"
git add -A
if git diff --cached --quiet; then
  echo "   产物没有变化，跳过提交"
else
  git commit -m "同步发布产物（$(date +%Y-%m-%d)）"
  git push
fi

echo "完成：https://cain0624.github.io/jd-insight/"
