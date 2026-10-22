#!/usr/bin/env bash
# Builds the macOS 12.7 fork end to end and audits every Mach-O it ships.
#
# Usage: script/build-macos12.sh [arm64|x64]
# Defaults to arm64. The Intel build needs the x64 Node runtime and the x64 fff rebuild.
set -euo pipefail

ARCH="${1:-arm64}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="${HOME}/.bun/bin:${PATH}"

case "${ARCH}" in
  arm64)
    CLI_TARGET="darwin-arm64"
    ELECTRON_TARGET="aarch64-apple-darwin"
    ELECTRON_ARCH="--arm64"
    RUST_TARGET="aarch64-apple-darwin"
    ZIG_TARGET="aarch64-macos.12.0"
    ;;
  x64)
    CLI_TARGET="darwin-x64"
    ELECTRON_TARGET="x86_64-apple-darwin"
    ELECTRON_ARCH="--x64"
    RUST_TARGET="x86_64-apple-darwin"
    ZIG_TARGET="x86_64-macos.12.0"
    ;;
  *) echo "Usage: script/build-macos12.sh [arm64|x64]" >&2; exit 1 ;;
esac

# Bun, the build runtime of this repository, does not start on macOS 12, so the fork itself cannot be
# compiled there. Ship a prebuilt app instead.
if [ "$(uname -s)" = "Darwin" ] && [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 13 ]; then
  echo "macOS 13 or newer is required to build: Bun does not start on older systems." >&2
  echo "Download a prebuilt app from https://github.com/abbassabeti/open-code-for-older-macos/releases" >&2
  exit 1
fi

cd "${ROOT}"

# The published fff dylib needs macOS 13, so the fork compiles its own.
./script/build-fff-macos12.sh "${ARCH}"

# The published opentui dylib needs macOS 13 as well, and the TUI loads it.
./script/build-opentui-macos12.sh "${ARCH}"

OPENCODE_FFF_DYLIB="${ROOT}/packages/cli/.cache/fff/${RUST_TARGET}/libfff_c.dylib" \
  OPENCODE_OPENTUI_LIB="${ROOT}/packages/cli/.cache/opentui/${ZIG_TARGET}/libopentui.dylib" \
  bun packages/cli/script/build-node.ts \
  --runtime-layout \
  --target="${CLI_TARGET}" \
  --skip-install \
  --outdir=dist/node

cd packages/desktop
OPENCODE_CHANNEL=prod \
  OPENCODE_CLI_TARGET="${ELECTRON_TARGET}" \
  OPENCODE_CLI_DIST="${ROOT}/packages/cli/dist" \
  bun ./scripts/prepare.ts

OPENCODE_CHANNEL=prod \
  OPENCODE_CLI_TARGET="${ELECTRON_TARGET}" \
  OPENCODE_CLI_DIST="${ROOT}/packages/cli/dist" \
  bun run build

npx electron-builder --mac --dir "${ELECTRON_ARCH}" --publish never --config electron-builder.config.ts

cd "${ROOT}"
bun script/verify-macos-minos.ts packages/desktop/dist/mac*/*.app
