#!/usr/bin/env bash
# Rebuilds the fff dylib with a macOS 12.0 deployment target. The published prebuilt dylib requires
# macOS 13, so a macOS 12.7 build has to compile its own.
#
# Usage: script/build-fff-macos12.sh [x86_64-apple-darwin]
# The output lands in packages/cli/.cache/fff/libfff_c.dylib and is picked up by the CLI build
# through OPENCODE_FFF_DYLIB.
set -euo pipefail

COMMIT="7353971198321b5330824c29eb4e49635c072245"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${ROOT}/packages/cli/.cache/fff"
REPO="${CACHE}/src"
OUT="${CACHE}/libfff_c.dylib"
TARGET="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

if [ ! -d "${REPO}/.git" ]; then
  mkdir -p "${CACHE}"
  git clone --filter=blob:none https://github.com/dmtrKovalenko/fff.git "${REPO}"
fi

git -C "${REPO}" fetch --depth 1 origin "${COMMIT}"
git -C "${REPO}" checkout --detach "${COMMIT}"

export MACOSX_DEPLOYMENT_TARGET=12.0
cargo build --release --manifest-path "${REPO}/Cargo.toml" -p fff-c --target "${TARGET}"

cp "${REPO}/target/${TARGET}/release/libfff_c.dylib" "${OUT}"

otool -l "${OUT}" | grep -A3 LC_BUILD_VERSION | grep -E "minos|sdk"
echo "Built ${OUT} for ${TARGET}"
