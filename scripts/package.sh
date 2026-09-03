#!/usr/bin/env bash
# Claude Desk 一键打包脚本
# 用法:
#   ./scripts/package.sh                 # 打 linux + win 两个平台
#   ./scripts/package.sh win             # 只打 Windows(portable + zip)
#   ./scripts/package.sh linux           # 只打 Ubuntu(AppImage + tar.gz)
#   ./scripts/package.sh win --push      # 打完后 git 提交并 push 本次产物
set -euo pipefail
cd "$(dirname "$0")/.."

# ---- 解析参数 ----
PUSH=false
TARGETS=()
for a in "$@"; do
  case "$a" in
    linux|win) TARGETS+=("$a") ;;
    --push)    PUSH=true ;;
    -h|--help) awk 'NR>1 && /^#/{sub(/^# ?/,"");print} NR>1 && !/^#/{exit}' "$0"; exit 0 ;;
    *) echo "未知参数: $a (支持 linux / win / --push)"; exit 1 ;;
  esac
done
# 默认两个平台都打
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(linux win)

# ---- 前置检查 ----
command -v npx >/dev/null 2>&1 || { echo "缺少 npx/node,请先安装 Node.js"; exit 1; }
[ -d node_modules/electron-builder ] || { echo "首次运行,先装依赖"; npm install; }

# ---- 1. 干净重建前端产物 ----
echo "==> 重建前端产物(build/)"
rm -rf build
npm run build

# ---- 2. 逐平台打包 ----
for t in "${TARGETS[@]}"; do
  echo "==> 清理 $t 旧产物"
  case "$t" in
    linux)
      rm -rf dist/linux-unpacked
      rm -f dist/*.AppImage dist/*.tar.gz
      ;;
    win)
      rm -rf dist/win-unpacked
      rm -f dist/*.exe dist/*-win.zip
      ;;
  esac

  echo "==> electron-builder --$t"
  npx electron-builder --"$t"
done

# ---- 3. 打印产物 ----
echo
echo "==> 本次产物:"
for t in "${TARGETS[@]}"; do
  case "$t" in
    linux) ls -lh dist/*.AppImage dist/*.tar.gz 2>/dev/null ;;
    win)   ls -lh dist/*.exe dist/*-win.zip 2>/dev/null ;;
  esac
done

# ---- 4. 可选:提交并上传 ----
if $PUSH; then
  files=()
  for t in "${TARGETS[@]}"; do
    case "$t" in
      linux) files+=(dist/*.AppImage dist/*.tar.gz) ;;
      win)   files+=(dist/*.exe dist/*-win.zip) ;;
    esac
  done
  [ ${#files[@]} -eq 0 ] && { echo "没有产物可提交"; exit 1; }
  # dist/ 在 gitignore,用 -f 强制加入
  git add -f "${files[@]}"
  git commit --allow-empty -m "更新打包产物(${TARGETS[*]})

Co-Authored-By: Claude Code <noreply@anthropic.com>"
  git push origin master
  remote=$(git config --get remote.origin.url || echo "<仓库地址>")
  echo
  echo "已推送。其它机器获取:"
  echo "  git clone $remote"
  echo "  cd $(basename "$PWD")"
  echo "  ls dist/"
fi
