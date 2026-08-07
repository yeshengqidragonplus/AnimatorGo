#!/usr/bin/env bash
#
# 启动开发服务器并打开浏览器。
#
#   Windows:  在 Git Bash 里执行  ./start.sh
#   macOS / Linux:                ./start.sh
#
# 可以从任何目录调用 —— 脚本会先切到自己所在的目录。

set -euo pipefail

cd "$(dirname "$0")"

# ── 找包管理器 ────────────────────────────────────────────────────────────────
if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
  # pnpm 直接透传多余参数;npm 需要一个 -- 分隔,否则参数会被 npm 自己吃掉
  SEP=()
elif command -v npm >/dev/null 2>&1; then
  PM=npm
  SEP=(--)
  echo "⚠ 没找到 pnpm,改用 npm。本项目的 lockfile 是 pnpm 的,建议装 pnpm:"
  echo "  npm install -g pnpm"
  echo
else
  echo "✗ 没找到 pnpm 也没找到 npm。请先安装 Node.js:https://nodejs.org" >&2
  exit 1
fi

# ── 首次运行装依赖 ────────────────────────────────────────────────────────────
if [ ! -d node_modules ]; then
  echo "首次运行,安装依赖(可能要几分钟)..."
  "$PM" install
  echo
fi

# ── 端口被占了就提示,而不是让 Vite 悄悄换一个 ─────────────────────────────────
PORT=5173
if command -v netstat >/dev/null 2>&1 &&
   netstat -an 2>/dev/null | grep -qiE "[.:]${PORT}[[:space:]].*listen"; then
  echo "⚠ 端口 ${PORT} 已被占用 —— 可能已经有一个开发服务器在跑了。"
  echo "  先看看 http://localhost:${PORT} 是不是已经能打开。"
  echo "  要换端口:  ./start.sh --port 5174"
  echo
fi

echo "启动中... 浏览器会自动打开 http://localhost:${PORT}"
echo "停止:Ctrl+C"
echo

# "$@" 透传:./start.sh --port 5174 之类的参数直接给 vite
exec "$PM" run dev "${SEP[@]}" --open "$@"
