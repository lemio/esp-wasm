#!/usr/bin/env bash
# Fetch everything the toolchain build needs into toolchain/out/:
# ESP-IDF (with esp-clang) and wasi-sdk. Re-running resumes where it stopped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
IDF_REF="${IDF_REF:-v6.0.3}"
WASI_SDK_VERSION="${WASI_SDK_VERSION:-34}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$HERE/out/espressif}"
mkdir -p "$HERE/out" && cd "$HERE/out"

if [[ ! -d esp-idf ]]; then
  git clone --depth 1 --branch "$IDF_REF" --recursive --shallow-submodules \
    https://github.com/espressif/esp-idf.git esp-idf
fi
# Fixes for building ESP-IDF with clang (see the comments in the patch).
if git -C esp-idf apply --check "$HERE/patches/esp-idf.patch" 2>/dev/null; then
  git -C esp-idf apply "$HERE/patches/esp-idf.patch"
fi
(cd esp-idf && ./install.sh esp32s3 && python3 tools/idf_tools.py install esp-clang)

if [[ ! -x wasi-sdk/bin/clang ]]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) PLAT=arm64-macos ;;
    Darwin-x86_64) PLAT=x86_64-macos ;;
    Linux-aarch64) PLAT=arm64-linux ;;
    *) PLAT=x86_64-linux ;;
  esac
  mkdir -p wasi-sdk
  curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$WASI_SDK_VERSION/wasi-sdk-$WASI_SDK_VERSION.0-$PLAT.tar.gz" \
    | tar xz -C wasi-sdk --strip-components=1
  xattr -dr com.apple.quarantine wasi-sdk 2>/dev/null || true
fi
echo "Ready: ESP-IDF $IDF_REF, wasi-sdk $WASI_SDK_VERSION"
