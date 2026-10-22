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
  arm64) CLI_TARGET="darwin-arm64"; ELECTRON_TARGET="aarch64-apple-darwin" ;;
  x64) CLI_TARGET="darwin-x64"; ELECTRON_TARGET="x86_64-apple-darwin" ;;
  *) echo "Usage: script/build-macos12.sh [arm64|x64]" >&2; exit 1 ;;
esac

cd "${ROOT}"

# The published fff dylib needs macOS 13, so the fork compiles its own.
./script/build-fff-macos12.sh

# The published opentui dylib needs macOS 13 as well, and the TUI loads it.
./script/build-opentui-macos12.sh "${ARCH}"

OPENCODE_FFF_DYLIB="${ROOT}/packages/cli/.cache/fff/libfff_c.dylib" \
  OPENCODE_OPENTUI_LIB="${ROOT}/packages/cli/.cache/opentui/libopentui.dylib" \
  bun packages/cli/script/build-node.ts \
  --runtime-layout \
  --target="${CLI_TARGET}" \
  --skip-install \
  --outdir=dist/node

cd packages/desktop
OPENCODE_CHANNEL=dev \
  OPENCODE_CLI_TARGET="${ELECTRON_TARGET}" \
  OPENCODE_CLI_DIST="${ROOT}/packages/cli/dist" \
  bun ./scripts/prepare.ts

OPENCODE_CHANNEL=dev \
  OPENCODE_CLI_TARGET="${ELECTRON_TARGET}" \
  OPENCODE_CLI_DIST="${ROOT}/packages/cli/dist" \
  bun run build

npx electron-builder --mac --dir --publish never --config electron-builder.config.ts

cd "${ROOT}"
bun script/verify-macos-minos.ts packages/desktop/dist/mac*/*.app
