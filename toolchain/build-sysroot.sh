#!/usr/bin/env bash
# Precompile ESP-IDF for the ESP32-S3 and package what the browser needs to
# compile and link one app: headers, component archives (debug info stripped),
# linker scripts, the exact flags, and the prebuilt bootloader and partition table.
#
# Needs ESP-IDF with esp-clang installed (see setup-idf.sh). IDF_PATH and
# IDF_TOOLS_PATH default to ./out/esp-idf and ./out/espressif.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${1:?usage: build-sysroot.sh <out-dir>}" && cd "$1" && pwd)"
export IDF_PATH="${IDF_PATH:-$HERE/out/esp-idf}"
export IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$HERE/out/espressif}"
JOBS="${JOBS:-4}"
PROJECT="$HERE/sysroot-project"
STAGE="$HERE/out/stage"

# shellcheck disable=SC1091
. "$IDF_PATH/export.sh" >/dev/null
export IDF_TOOLCHAIN=clang   # clang-flavored flags in compile_commands.json
CLANG_ROOT="$(cd "$(dirname "$(command -v clang)")/.." && pwd)"

"$HERE/fetch-arduino.sh"   # Arduino core + libraries (no-op once fetched)

cd "$PROJECT"
idf.py -B build set-target esp32s3
ninja -j"$JOBS" -C build

rm -rf "$STAGE" && mkdir -p "$STAGE"
python3 "$HERE/scripts/collect_sysroot.py" \
  --build "$PROJECT/build" --project "$PROJECT" --idf "$IDF_PATH" \
  --clang-root "$CLANG_ROOT" --out "$STAGE/sysroot" \
  --prefix "$HERE/out/components=components" --prefix "$HERE/out/arduino-libs=libraries"

cp build/bootloader/bootloader.bin "$OUT/bootloader.bin"
cp build/partition_table/partition-table.bin "$OUT/partition-table.bin"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT/sysroot.tar.gz" sysroot
ls -lh "$OUT/sysroot.tar.gz"
