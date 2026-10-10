#!/usr/bin/env bash
# Build Espressif's LLVM fork (clang + lld, Xtensa only) as one multicall
# wasm32-wasip1 binary: llvm.wasm, invoked with argv[0] = clang | ld.lld.
#
# Recipe adapted from YoWASP (https://github.com/YoWASP/clang). The WASI
# portability patch in patches/llvm-wasi-posix.patch is YoWASP's LLVM 20 patch,
# rebased onto the Espressif fork.
#
# Needs: cmake, ninja, a host C++ compiler, and wasi-sdk (WASI_SDK, default
# ./out/wasi-sdk). Works on macOS and Linux.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${1:?usage: build-llvm.sh <out-dir>}" && cd "$1" && pwd)"
WASI_SDK="${WASI_SDK:-$HERE/out/wasi-sdk}"
LLVM_REPO="${LLVM_REPO:-https://github.com/espressif/llvm-project.git}"
# Must match the esp-clang version pinned by the ESP-IDF used for the sysroot.
LLVM_REF="${LLVM_REF:-esp-20.1.1_20250829}"
WORK="${WORK:-$HERE/out/llvm}"
# LLVM compile jobs use ~1 GB each and links several GB. Keep this low on
# laptops: an unbounded build has panicked a 16 GB Mac.
JOBS="${JOBS:-3}"
mkdir -p "$WORK" && cd "$WORK"

if [[ ! -d src ]]; then
  git clone --depth 1 --branch "$LLVM_REF" "$LLVM_REPO" src
fi
if git -C src apply --check "$HERE/patches/llvm-wasi-posix.patch" 2>/dev/null; then
  git -C src apply "$HERE/patches/llvm-wasi-posix.patch"
fi

# 1. Native table generators, run during the cross build.
if [[ ! -x native/bin/llvm-tblgen || ! -x native/bin/clang-tblgen ]]; then
  cmake -B native -S src/llvm -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DLLVM_TARGETS_TO_BUILD="" -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa \
    -DLLVM_ENABLE_PROJECTS=clang -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_BUILD_TOOLS=OFF -DCLANG_BUILD_TOOLS=OFF
  ninja -j"$JOBS" -C native llvm-tblgen clang-tblgen
fi

# 2. Cross-compile to wasm32-wasip1.
SYSROOT="$WASI_SDK/share/wasi-sysroot"
cat > Toolchain-WASI.cmake <<EOF
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
set(CMAKE_C_COMPILER $WASI_SDK/bin/clang)
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER $WASI_SDK/bin/clang++)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER $WASI_SDK/bin/wasm-ld)
set(CMAKE_AR $WASI_SDK/bin/ar)
set(CMAKE_RANLIB $WASI_SDK/bin/ranlib)
# LLVM has some (unreachable in this configuration) calls to mmap, signal and
# getrusage. Recent wasi-sdk refuses those headers unless emulation is enabled.
set(WASI_EMU "-D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS")
set(CMAKE_C_FLAGS "--sysroot $SYSROOT -mcpu=lime1 \${WASI_EMU}")
set(CMAKE_CXX_FLAGS "--sysroot $SYSROOT -mcpu=lime1 \${WASI_EMU}")
# Clang needs a big stack for deep ASTs; --stack-first turns overflow into a trap
# instead of silent heap corruption.
set(CMAKE_EXE_LINKER_FLAGS "--sysroot $SYSROOT -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -Wl,--strip-all")
EOF

# Every tool that would otherwise end up in the multicall binary. We only want clang and lld.
TOOLS_OFF=()
for t in SANCOV LLVM_SYMBOLIZER LLVM_SIZE LLVM_READOBJ LLVM_RC LLVM_PROFDATA LLVM_OBJDUMP \
         LLVM_OBJCOPY LLVM_NM LLVM_MT LLVM_ML LLVM_LIPO LLVM_LIBTOOL_DARWIN LLVM_IFS LLVM_GSYMUTIL \
         LLVM_DWP LLVM_DEBUGINFOD_FIND LLVM_DEBUGINFOD LLVM_CXXFILT LLVM_CGDATA LLVM_AR DSYMUTIL; do
  TOOLS_OFF+=("-DLLVM_TOOL_${t}_BUILD=OFF")
done

cmake -B wasi -S src/llvm -G Ninja \
  -DCMAKE_TOOLCHAIN_FILE="$PWD/Toolchain-WASI.cmake" \
  -DLLVM_NATIVE_TOOL_DIR="$PWD/native/bin" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DLLVM_ENABLE_ASSERTIONS=OFF \
  -DLLVM_BUILD_SHARED_LIBS=OFF -DLLVM_ENABLE_PIC=OFF -DLLVM_BUILD_STATIC=ON \
  -DLLVM_ENABLE_THREADS=OFF \
  -DLLVM_BUILD_RUNTIME=OFF -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_UTILS=OFF -DLLVM_BUILD_UTILS=OFF \
  -DLLVM_INCLUDE_RUNTIMES=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_TESTS=OFF \
  -DLLVM_INCLUDE_BENCHMARKS=OFF -DLLVM_INCLUDE_DOCS=OFF \
  -DLLVM_TARGETS_TO_BUILD="" -DLLVM_EXPERIMENTAL_TARGETS_TO_BUILD=Xtensa \
  -DLLVM_DEFAULT_TARGET_TRIPLE=xtensa-esp-elf \
  -DLLVM_TOOL_LLVM_DRIVER_BUILD=ON \
  "${TOOLS_OFF[@]}" \
  -DLLVM_ENABLE_PROJECTS="clang;lld" \
  -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
  -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF -DCLANG_INCLUDE_TESTS=OFF \
  -DCLANG_BUILD_TOOLS=OFF -DCLANG_BUILD_EXAMPLES=OFF -DCLANG_INCLUDE_DOCS=OFF \
  -DCLANG_TOOL_CLANG_SCAN_DEPS_BUILD=OFF -DCLANG_TOOL_CLANG_INSTALLAPI_BUILD=OFF \
  -DCLANG_LINKS_TO_CREATE="clang;clang++" -DLLD_BUILD_TOOLS=OFF \
  -DCLANG_HAVE_RLIMITS=OFF \
  -DLLVM_PARALLEL_LINK_JOBS=1
ninja -j"$JOBS" -k "${KEEP_GOING:-1}" -C wasi llvm-driver clang-resource-headers

# Clang's own headers (stdarg.h, stddef.h, …), shipped in the sysroot and
# passed with -resource-dir. A wasm binary can't locate them next to itself.
rm -rf "$OUT/clang-resource" && mkdir -p "$OUT/clang-resource"
cp -R wasi/lib/clang/*/include "$OUT/clang-resource/"

if command -v wasm-opt >/dev/null; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals \
    --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types \
    --enable-extended-const --enable-call-indirect-overlong \
    wasi/bin/llvm -o "$OUT/llvm.wasm"
else
  cp wasi/bin/llvm "$OUT/llvm.wasm"
fi
ls -lh "$OUT/llvm.wasm"
