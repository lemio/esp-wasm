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

# The USB-OTG variant: the same project with TinyUSB (ESP_WASM_USB=1, sdkconfig.usb), in its own build dir,
# collected under the same virtual paths. Only the files that differ from the sysroot above are shipped,
# as an overlay the browser lays over it for sketches that include USB.h.
ESP_WASM_USB=1 idf.py -B build-usb -D SDKCONFIG="$PROJECT/build-usb/sdkconfig" \
  -D SDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.usb" set-target esp32s3
ESP_WASM_USB=1 ninja -j"$JOBS" -C build-usb
rm -rf "$STAGE/usb" && mkdir -p "$STAGE/usb"
python3 "$HERE/scripts/collect_sysroot.py" \
  --build "$PROJECT/build-usb" --project "$PROJECT" --idf "$IDF_PATH" \
  --clang-root "$CLANG_ROOT" --out "$STAGE/usb/full/sysroot" \
  --prefix "$HERE/out/components=components" --prefix "$HERE/out/components-usb=components-usb" \
  --prefix "$HERE/out/arduino-libs=libraries"
python3 - "$STAGE/sysroot" "$STAGE/usb/full/sysroot" "$STAGE/usb/overlay/sysroot" <<'PY'
import filecmp, shutil, sys
from pathlib import Path
base, full, out = map(Path, sys.argv[1:])
n = 0
for f in full.rglob("*"):
    if f.is_file():
        b = base / f.relative_to(full)
        if not b.is_file() or not filecmp.cmp(b, f, shallow=False):
            d = out / f.relative_to(full); d.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(f, d); n += 1
print(f"usb overlay: {n} files differ from the sysroot")
PY
COPYFILE_DISABLE=1 tar -C "$STAGE/usb/overlay" -czf "$OUT/sysroot-usb.tar.gz" sysroot
ls -lh "$OUT/sysroot-usb.tar.gz"

cp build/bootloader/bootloader.bin "$OUT/bootloader.bin"
cp build/partition_table/partition-table.bin "$OUT/partition-table.bin"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT/sysroot.tar.gz" sysroot
ls -lh "$OUT/sysroot.tar.gz"
