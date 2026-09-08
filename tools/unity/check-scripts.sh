#!/usr/bin/env bash
# 编译 tools/unity/ 下的每个 Editor 脚本,只为了让编译器过一遍。
#
# 起因:AnimatorGoVerify.cs 交出去时带着 `Replace('\', '/')` —— 反斜杠没转义,
# 一个字符字面量的语法错。TypeScript 那边有 tsc 兜着,C# 这边什么都没有,
# 结果是用户打开 Unity 才发现。
#
# 用 Unity 自带的 Roslyn + Unity 自己的引用程序集,所以判断和 Unity 里一致。
# 找不到 Unity 或 dotnet 就跳过(exit 0)—— 不能因为换了台机器就让检查失败。
#
#   bash tools/unity/check-scripts.sh
#   UNITY_EDITOR_PATH="/path/to/Unity/Hub/Editor/6000.3.2f1" bash tools/unity/check-scripts.sh

set -uo pipefail
cd "$(dirname "$0")/../.."

skip() { echo "⊘ 跳过 Unity 脚本编译检查:$1"; exit 0; }

# ⚠️ csc 是 Windows 进程,认不出 git-bash 的 /d/... 写法,要先换成 D:/...
towin() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else
    printf '%s' "$1" | sed -E 's|^/([a-zA-Z])/|:/|'
  fi
}

command -v dotnet >/dev/null 2>&1 || skip "没有 dotnet"

# ── 找 Unity ──
wanted=""
version_file="UnityAnimationGo/ProjectSettings/ProjectVersion.txt"
[ -f "$version_file" ] && wanted=$(sed -n 's/^m_EditorVersion: *//p' "$version_file" | tr -d '\r')

editor=""
if [ -n "${UNITY_EDITOR_PATH:-}" ]; then
  editor="$UNITY_EDITOR_PATH"
else
  for hub in \
    "/c/Program Files/Unity/Hub/Editor" \
    "/d/Program Files/Unity/Hub/Editor" \
    "/e/Program Files/Unity/Hub/Editor" \
    "C:/Program Files/Unity/Hub/Editor" \
    "D:/Program Files/Unity/Hub/Editor" \
    "E:/Program Files/Unity/Hub/Editor" \
    "/Applications/Unity/Hub/Editor"
  do
    [ -d "$hub" ] || continue
    # 优先用工程要求的那个版本;目录名可能带 "Unity " 前缀
    for name in "$wanted" "Unity $wanted"; do
      [ -n "$name" ] && [ -d "$hub/$name" ] && editor="$hub/$name" && break
    done
    [ -n "$editor" ] && break
    # 退而求其次:该 Hub 下最新的一个
    latest=$(ls "$hub" 2>/dev/null | sort -V | tail -1)
    [ -n "$latest" ] && editor="$hub/$latest" && break
  done
fi

[ -n "$editor" ] && [ -d "$editor" ] || skip "找不到 Unity 安装(可用 UNITY_EDITOR_PATH 指定)"

data="$editor/Editor/Data"
[ -d "$data" ] || data="$editor/Unity.app/Contents"   # macOS
data=$(towin "$data")
csc="$data/DotNetSdkRoslyn/csc.dll"
mono="$data/MonoBleedingEdge/lib/mono/4.7.1-api"
managed="$data/Managed/UnityEngine"

[ -f "$csc" ] || skip "$editor 里没有 Roslyn"
[ -d "$managed" ] || skip "$editor 里没有引用程序集"

# 包的程序集是 Unity 编译出来的,工程没打开过就没有 —— 有就用上,没有就少几个引用
script_assemblies=$(towin "$PWD/UnityAnimationGo/Library/ScriptAssemblies")

files=(tools/unity/*.cs)
[ -e "${files[0]}" ] || skip "tools/unity/ 下没有 .cs"

echo "Unity:$editor"
echo "检查 ${#files[@]} 个 Editor 脚本"

out_dir=$(mktemp -d)
trap 'rm -rf "$out_dir"' EXIT
out_win=$(towin "$out_dir")
failed=0

for src in "${files[@]}"; do
  rsp="$out_dir/args.rsp"
  {
    echo "-target:library"
    echo "-nostdlib+"
    echo "-langversion:9"
    echo "-utf8output"
    # 包里用宏隔开的分支也要编到
    echo "-define:UNITY_2D_ANIMATION"
    echo "-out:\"$out_win/check.dll\""
    # Unity 6 的引擎程序集是对着 netstandard 2.1 编的。优先用 Unity 自带的 2.1 引用程序集
    # (Unity 自己编 Editor 脚本就是用它),没有再退回 mono 4.7.1 + netstandard 2.0 facade ——
    # 后者碰到 ValueTuple 之类 2.1 才有的东西会报 CS1705 版本不匹配
    ns21="$data/NetStandard/ref/2.1.0/netstandard.dll"
    if [ -f "$ns21" ]; then
      echo "-r:\"$ns21\""
      for f in "$data"/NetStandard/compat/2.1.0/shims/netfx/*.dll "$data"/NetStandard/Extensions/2.0.0/*.dll; do
        [ -f "$f" ] && echo "-r:\"$f\""
      done
    else
      for f in "$mono/mscorlib.dll" "$mono/System.dll" "$mono/System.Core.dll" "$mono/Facades/netstandard.dll"; do
        [ -f "$f" ] && echo "-r:\"$f\""
      done
    fi
    for f in "$managed"/*.dll "$script_assemblies"/*.dll; do
      [ -f "$f" ] && echo "-r:\"$f\""
    done
    echo "\"$(towin "$PWD/$src")\""
  } > "$rsp"

  # 编译器自己的横幅不算输出,过滤掉
  log=$(dotnet "$csc" "@$rsp" 2>&1 | grep -vE "^(Microsoft\(R\)|版权所有|Copyright|Ceci|^$)" || true)
  if [ -n "$log" ]; then
    echo "✗ $src"
    echo "$log" | sed 's/^/    /'
    failed=$((failed + 1))
  else
    echo "✓ $src"
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "$failed 个脚本编译不过"
  exit 1
fi
echo "全部通过"
