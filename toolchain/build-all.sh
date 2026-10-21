#!/usr/bin/env bash
# Produce everything the web app loads from public/toolchain/.
# Run toolchain/setup-idf.sh first.
#
# Resource use: the LLVM build dominates (~1 h). Parallelism is capped with
# JOBS (default 3) and the build runs under scripts/mem-guard.sh, which stops it
# when memory runs low; re-running resumes where it stopped.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${OUT:-$HERE/../public/toolchain}" && cd "${OUT:-$HERE/../public/toolchain}" && pwd)"
STAGE="$HERE/out/stage-wasm"
mkdir -p "$STAGE"

nice -n 15 "$HERE/scripts/mem-guard.sh" "$HERE/build-llvm.sh" "$STAGE"
nice -n 15 "$HERE/scripts/mem-guard.sh" "$HERE/build-binutils.sh" "$STAGE"
nice -n 15 "$HERE/build-sysroot.sh" "$STAGE"

# Examples panel: every example of the core and libraries that applies to this
# sysroot. TEST_EXAMPLES=1 also builds each one (~1 h) and marks the ones that
# don't build.
python3 "$HERE/scripts/collect_examples.py" --core "$HERE/out/components/arduino" \
  --libs "$HERE/out/arduino-libs" --sdkconfig "$HERE/sysroot-project/sdkconfig" \
  --out "$STAGE/examples.json"
if [[ "${TEST_EXAMPLES:-0}" == "1" ]]; then
  rm -rf "$STAGE/sysroot" && tar -C "$STAGE" -xzf "$STAGE/sysroot.tar.gz"
  nice -n 15 "$HERE/scripts/mem-guard.sh" node --experimental-strip-types --no-warnings \
    --max-old-space-size=4096 "$HERE/scripts/test-examples.mjs" "$STAGE" "$STAGE/examples.json"
fi

for f in llvm.wasm ld.wasm sysroot.tar.gz sysroot-usb.tar.gz bootloader.bin partition-table.bin examples.json builtin-libraries.json; do
  cp "$STAGE/$f" "$OUT/$f"
done

IDF_VER="$(git -C "${IDF_PATH:-$HERE/out/esp-idf}" describe --tags 2>/dev/null || echo idf)"
cat > "$OUT/manifest.json" <<JSON
{
  "version": "$(date -u +%Y%m%d%H%M)-$IDF_VER",
  "tools": {
    "clang": { "url": "llvm.wasm", "argv0": "clang" },
    "ld": { "url": "ld.wasm", "argv0": "ld" }
  },
  "sysroot": "sysroot.tar.gz",
  "variants": { "usb": { "overlay": "sysroot-usb.tar.gz", "description": "USB mode USB-OTG (TinyUSB): for sketches that are a USB device themselves (USB.h)" } },
  "bootloader": "bootloader.bin",
  "partitionTable": "partition-table.bin",
  "image": { "flashMode": "dio", "flashFreq": "80m", "flashSize": "4MB" }
}
JSON
echo "Toolchain written to $OUT"
ls -lh "$OUT"
