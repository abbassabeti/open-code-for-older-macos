#!/usr/bin/env bash
# Rebuilds the fff dylib with a macOS 12.0 deployment target. The published prebuilt dylib requires
# macOS 13, so a macOS 12.7 build has to compile its own.
#
# Usage: script/build-fff-macos12.sh [arm64|x64]
# The output lands in packages/cli/.cache/fff/<rust target>/libfff_c.dylib and is picked up by the CLI
# build through OPENCODE_FFF_DYLIB.
set -euo pipefail

COMMIT="7353971198321b5330824c29eb4e49635c072245"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${ROOT}/packages/cli/.cache/fff"
REPO="${CACHE}/src"

case "${1:-$(uname -m)}" in
  arm64|aarch64) TARGET="aarch64-apple-darwin" ;;
  x64|x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "Usage: script/build-fff-macos12.sh [arm64|x64]" >&2; exit 1 ;;
esac

OUT="${CACHE}/${TARGET}/libfff_c.dylib"

# Rust is not part of a stock macOS install, and only rustup can add the std of a cross target, so
# keep the toolchain inside the repository cache instead of the system one.
HOST_TARGET="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)"
if [ "${HOST_TARGET}" = "${TARGET}" ] && command -v cargo >/dev/null 2>&1; then
  CARGO="$(command -v cargo)"
else
  export CARGO_HOME="${CACHE}/cargo"
  export RUSTUP_HOME="${CACHE}/rustup"
  CARGO="${CARGO_HOME}/bin/cargo"
  if [ ! -x "${CARGO}" ]; then
    echo "installing a Rust toolchain into ${CARGO_HOME}"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable
  fi
  "${CARGO_HOME}/bin/rustup" target add "${TARGET}"
fi

if [ ! -d "${REPO}/.git" ]; then
  mkdir -p "${CACHE}"
  git clone --filter=blob:none https://github.com/dmtrKovalenko/fff.git "${REPO}"
fi

git -C "${REPO}" fetch --depth 1 origin "${COMMIT}"
git -C "${REPO}" checkout --detach "${COMMIT}"

export MACOSX_DEPLOYMENT_TARGET=12.0
"${CARGO}" build --release --manifest-path "${REPO}/Cargo.toml" -p fff-c --target "${TARGET}"

mkdir -p "$(dirname "${OUT}")"
cp "${REPO}/target/${TARGET}/release/libfff_c.dylib" "${OUT}"

otool -l "${OUT}" | grep -A3 LC_BUILD_VERSION | grep -E "minos|sdk"
echo "Built ${OUT} for ${TARGET}"
