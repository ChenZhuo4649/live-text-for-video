#!/usr/bin/env bash
# 编译 OCR 后端 → Universal Binary（Apple Silicon + Intel），最低系统 macOS 13.0
#
# 为什么必须显式指定 -target：
#   swiftc 不加该参数时，会把「当前 SDK 的最低版本」当作最低系统要求。
#   在 macOS 26 上编译出来的二进制会要求 macOS 26+，传给别人的机器就是「无法打开」。
#
# 为什么编两个架构：
#   Intel Mac 与 Apple Silicon 都要能用。
#
# 可用环境变量 LIVETEXT_MIN_MACOS 覆盖最低版本（默认 13.0，
# 因为「自动检测语言」这个能力从 macOS 13 起才有）。
set -euo pipefail

cd "$(dirname "$0")"

TARGET_VER="${LIVETEXT_MIN_MACOS:-13.0}"
OUT="livetext-ocr"
BUILD_DIR="build"

mkdir -p "$BUILD_DIR"

echo "==> 最低系统版本: macOS ${TARGET_VER}"
echo "==> swiftc: $(swiftc --version 2>/dev/null | head -1 | sed 's/.*Apple Swift version \([0-9.]*\).*/\1/')"
echo

build_arch() {
  local arch="$1"
  echo "==> 编译 ${arch} ..."
  if swiftc -O -swift-version 5 \
      -target "${arch}-apple-macos${TARGET_VER}" \
      -o "${BUILD_DIR}/${OUT}-${arch}" \
      "${OUT}.swift"; then
    echo "    ok"
    return 0
  fi
  echo "    ✗ ${arch} 编译失败"
  return 1
}

ok_archs=()
if build_arch arm64; then ok_archs+=("arm64"); fi
if build_arch x86_64; then ok_archs+=("x86_64"); fi

if [ "${#ok_archs[@]}" -eq 0 ]; then
  echo
  echo "错误：两个架构都编译失败，无法产出可用二进制" >&2
  exit 1
fi

echo
if [ "${#ok_archs[@]}" -eq 1 ]; then
  echo "==> 只有 ${ok_archs[0]} 编译成功，直接使用该架构"
  cp "${BUILD_DIR}/${OUT}-${ok_archs[0]}" "$OUT"
else
  echo "==> 合并为 Universal Binary"
  lipo -create -output "$OUT" \
    "${BUILD_DIR}/${OUT}-arm64" \
    "${BUILD_DIR}/${OUT}-x86_64"
fi

chmod +x "$OUT"

echo
echo "==> 产物: $(pwd)/$OUT"
lipo -info "$OUT" | sed 's/^/    /'
otool -l "$OUT" 2>/dev/null | grep -A3 LC_BUILD_VERSION | grep minos | sed 's/^/    要求 /'
echo
echo "==> 自检"
./"$OUT" --help | head -4
