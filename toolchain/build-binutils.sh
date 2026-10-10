#!/usr/bin/env bash
# Build GNU ld for xtensa-esp-elf (ESP32-S3) as a wasm32-wasip1 binary: ld.wasm.
#
# ESP-IDF's linker scripts need GNU ld (lld lays the sections out differently
# and IDF's own checks reject the result), which is also what Espressif ships
# alongside esp-clang. The output links byte-identical ELFs to the native ld.
#
# The ESP32-S3 core configuration normally comes from a dlopen'ed
# xtensa-dynconfig library; with --disable-plugins binutils uses the built-in
# one instead, which we replace with the esp32s3 overlay from
# espressif/xtensa-overlays.
#
# Needs: a host C compiler, make, curl, git, and wasi-sdk (WASI_SDK, default
# ./out/wasi-sdk). Works on macOS and Linux.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${1:?usage: build-binutils.sh <out-dir>}" && cd "$1" && pwd)"
WASI_SDK="${WASI_SDK:-$HERE/out/wasi-sdk}"
# Matches the GNU toolchain pinned by ESP-IDF v6.0 (xtensa-esp-elf esp-15.2.0_20251204).
BINUTILS_REF="${BINUTILS_REF:-esp-2.45.0_20251204}"
JOBS="${JOBS:-3}"
WORK="${WORK:-$HERE/out/binutils}"
mkdir -p "$WORK" && cd "$WORK"

# The git history is huge; a tarball of the tag is enough.
if [[ ! -d src ]]; then
  mkdir src
  curl -fsSL --retry 3 "https://codeload.github.com/espressif/binutils-gdb/tar.gz/refs/tags/$BINUTILS_REF" \
    | tar xz -C src --strip-components=1
fi
[[ -d overlays ]] || git clone --depth 1 https://github.com/espressif/xtensa-overlays.git overlays
cp -R overlays/xtensa_esp32s3/binutils/* src/

# Stubs for POSIX functions wasi-libc lacks (see ../wasi-compat/).
CC_WASI="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
COMPAT="$HERE/wasi-compat"
$CC_WASI -Os -c "$COMPAT/wasi-compat.c" -o wasi-compat.o
rm -f libwasi-compat.a && "$WASI_SDK/bin/llvm-ar" rcs libwasi-compat.a wasi-compat.o

rm -rf build && mkdir build && cd build
export CC="$CC_WASI"
export CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
export AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" NM="$WASI_SDK/bin/llvm-nm"
export CC_FOR_BUILD=cc
export CFLAGS="-Os -I$COMPAT/include -include $COMPAT/wasi-compat.h -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID"
export LDFLAGS="-L$WORK -lwasi-compat -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -Wl,-z,stack-size=8388608"
# wasi-libc declares these with different prototypes than libiberty's fallbacks.
export ac_cv_func_psignal=yes ac_cv_func_strsignal=yes

../src/configure --host=wasm32-wasi --build="$(../src/config.guess)" --target=xtensa-esp-elf \
  --disable-gdb --disable-gdbserver --disable-sim --disable-nls --disable-plugins \
  --disable-shared --enable-static --disable-werror --disable-gprof --disable-gprofng \
  --disable-gold --disable-libctf --without-zstd --with-system-zlib=no \
  --disable-readline --disable-libdecnumber
make -j"$JOBS" MAKEINFO=true all-ld

cp ld/ld-new "$OUT/ld.wasm"
ls -lh "$OUT/ld.wasm"
