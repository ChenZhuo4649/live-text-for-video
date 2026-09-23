#!/usr/bin/env bash
# Live Text for Video —— 一键安装
#
# 做三件事：
#   1. 准备 OCR 后端（已有可用的就直接用；没有就用本机 swiftc 编译）
#   2. 把后端位置告诉本机浏览器（Native Messaging 注册）
#   3. 打印安装扩展的步骤
#
# 环境要求：macOS 13 或更高。
# 若需要现场编译，还需要 Command Line Tools：xcode-select --install
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$ROOT/host"
EXT_DIR="$ROOT/extension"
HOST_NAME="com.zhuo.livetext"
HOST_BIN="$HOST_DIR/livetext-ocr"

# 这个 ID 由 extension/manifest.json 里的 key（公钥）决定，
# 因此与安装路径无关 —— 换电脑、换目录、换浏览器都是同一个。
FIXED_ID="hmigekegioajglfmifdfofilgigpbcah"

# 兼容历史 ID：早期版本用的是「扩展目录路径哈希」，换目录就会变。
# 一并登记，避免老用户升级后突然失效。
LEGACY_IDS=(
  "mnpppljpkiekkhhejpbjdhgpkbflpajc"
  "lmfnejlbhegkekeiakgeamjipfpnebjn"
  "bchbplkehecaemfegllkekmedfmjoilb"
)

step() { printf "\n\033[1m==> %s\033[0m\n" "$1"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "    \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "\n\033[31m错误：%s\033[0m\n" "$1" >&2; exit 1; }

# ---------- 0. 环境检查 ----------
step "检查环境"

OS_VER="$(sw_vers -productVersion 2>/dev/null || echo "0")"
OS_MAJOR="${OS_VER%%.*}"
if [ "${OS_MAJOR:-0}" -lt 13 ] 2>/dev/null; then
  warn "当前 macOS ${OS_VER}。本工具需要 macOS 13+（更低版本缺少「自动检测语言」能力）"
else
  ok "macOS ${OS_VER}"
fi

ok "CPU 架构 $(uname -m)"

PY="$(command -v python3 || true)"
[ -n "$PY" ] || die "找不到 python3。请先安装 Command Line Tools：xcode-select --install"

# ---------- 1. 准备后端 ----------
step "准备 OCR 后端"

need_build=1
if [ -x "$HOST_BIN" ]; then
  if "$HOST_BIN" --help >/dev/null 2>&1; then
    ok "已存在可用后端，跳过编译"
    need_build=0
  else
    warn "已有后端但无法运行（架构不符或系统版本不够），将重新编译"
  fi
fi

if [ "$need_build" = "1" ]; then
  if ! command -v swiftc >/dev/null 2>&1; then
    die "需要编译后端但找不到 swiftc。请先执行：xcode-select --install"
  fi
  echo "    开始编译（首次约需 1~2 分钟）..."
  if ! bash "$HOST_DIR/build.sh" > /tmp/livetext-build.log 2>&1; then
    echo "----- 编译输出（末尾 20 行）-----"
    tail -20 /tmp/livetext-build.log
    die "编译失败，完整日志见 /tmp/livetext-build.log"
  fi
  ok "后端编译完成"
fi

# 从网上下载的文件会带 quarantine 标记，导致 macOS 拒绝执行
xattr -d com.apple.quarantine "$HOST_BIN" 2>/dev/null || true
chmod +x "$HOST_BIN"

# ---------- 2. 注册 ----------
step "注册到本机浏览器"

IDS=("$FIXED_ID")
for i in "${LEGACY_IDS[@]}"; do IDS+=("$i"); done

MANIFEST_CONTENT="$("$PY" - "$HOST_NAME" "$HOST_BIN" "${IDS[*]}" <<'PYEOF'
import json, sys
ids = sys.argv[3].split()
print(json.dumps({
    "name": sys.argv[1],
    "description": "macOS Vision OCR backend for Live Text for Video",
    "path": sys.argv[2],
    "type": "stdio",
    "allowed_origins": ["chrome-extension://" + i + "/" for i in ids],
}, indent=2, ensure_ascii=False))
PYEOF
)"

registered=0
for d in \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts" \
  "$HOME/Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"
do
  if mkdir -p "$d" 2>/dev/null && printf '%s\n' "$MANIFEST_CONTENT" > "$d/$HOST_NAME.json" 2>/dev/null; then
    registered=$((registered + 1))
  fi
done

[ "$registered" -gt 0 ] || die "注册失败：所有候选目录都写不进去"
ok "已注册到 ${registered} 个浏览器目录"
ok "登记了 $((${#IDS[@]})) 个扩展 ID（含历史版本，避免升级后失效）"

# ---------- 3. 完成 ----------
step "下一步：安装扩展"

cat <<EOF

  1. 浏览器打开   chrome://extensions
  2. 打开右上角「开发者模式」
  3. 点「加载已解压的扩展程序」，选中这个目录：

     ${EXT_DIR}

  4. 装好后卡片上的扩展 ID 应该是：

     ${FIXED_ID}

     （这个 ID 由扩展内置的公钥决定，换电脑、换目录都不会变。
      如果显示的不是它，说明浏览器还没重读 manifest，把扩展移除后重新加载一次。）

  然后就可以用了：暂停视频 → 点画面右下角的小标 → 拖选文字复制。

  两个小提醒：
   · 若浏览器已经开着，注册可能要等一次重启才生效。
   · 开发者模式装的扩展，Chrome 冷启动会提示「请停用开发者模式扩展」，
     这是对非商店扩展的例行提醒，不影响使用。

EOF
