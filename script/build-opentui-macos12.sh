#!/usr/bin/env bash
# Rebuilds the opentui native library with a macOS 12.0 deployment target. The published prebuilt
# dylib requires macOS 13, so a macOS 12.7 build has to compile its own.
#
# Usage: script/build-opentui-macos12.sh [arm64|x64]
# The output lands in packages/cli/.cache/opentui/<zig target>/libopentui.dylib and is picked up by
# the CLI build through OPENCODE_OPENTUI_LIB.
set -euo pipefail

VERSION="v0.6.6"
ZIG_VERSION="0.16.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${ROOT}/packages/cli/.cache/opentui"
REPO="${CACHE}/src"

case "${1:-$(uname -m)}" in
  arm64|aarch64) TARGET="aarch64-macos.12.0" ;;
  x64|x86_64) TARGET="x86_64-macos.12.0" ;;
  *) echo "Usage: script/build-opentui-macos12.sh [arm64|x64]" >&2; exit 1 ;;
esac

OUT="${CACHE}/${TARGET}/libopentui.dylib"

# Zig cross compiles between macOS architectures, so the toolchain only has to match the host.
case "$(uname -m)" in
  arm64) ARCHIVE="zig-aarch64-macos" ;;
  x86_64) ARCHIVE="zig-x86_64-macos" ;;
  *) echo "Unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac

# opentui refuses to build with a Zig version other than the one it pins.
ZIG_DIR="${CACHE}/${ARCHIVE}-${ZIG_VERSION}"
ZIG="${ZIG_DIR}/zig"
if [ ! -x "${ZIG}" ]; then
  mkdir -p "${CACHE}"
  curl -fsSL -o "${CACHE}/zig.tar.xz" "https://ziglang.org/download/${ZIG_VERSION}/${ARCHIVE}-${ZIG_VERSION}.tar.xz"
  tar -xf "${CACHE}/zig.tar.xz" -C "${CACHE}"
fi

if [ ! -d "${REPO}/.git" ]; then
  git clone --depth 1 --branch "${VERSION}" https://github.com/anomalyco/opentui.git "${REPO}"
fi

cd "${REPO}/packages/native"
sh scripts/prepare-zig-deps.sh
MACOSX_DEPLOYMENT_TARGET=12.0 "${ZIG}" build -Doptimize=ReleaseFast -Dlibrary-target="${TARGET}"

mkdir -p "$(dirname "${OUT}")"
cp "lib/${TARGET}/libopentui.dylib" "${OUT}"

otool -l "${OUT}" | grep -A3 LC_BUILD_VERSION | grep -E "minos|sdk"
echo "Built ${OUT} for ${TARGET}"
