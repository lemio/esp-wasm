#!/usr/bin/env bash
# Package the CH32V003 sysroot for the browser: ch32fun (https://github.com/cnlohr/ch32fun,
# MIT) with its startup code, headers and linker script, newlib's headers, clang's
# generic headers, and ch32fun's rv32e libgcc. Programs link with ld.lld (in llvm.wasm,
# built with the RISCV target), so no binutils are needed.
#
#   toolchain/build-ch32v003.sh <out-dir>
#
# Writes <out-dir>/sysroot-ch32v003.tar.gz and <out-dir>/examples-ch32v003.json.
# Needs: git, python3, and the esp-clang + riscv32-esp-elf toolchains from
# setup-idf.sh (for the linker-script preprocessing and newlib's headers).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${1:?usage: build-ch32v003.sh <out-dir>}" && cd "$1" && pwd)"
IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$HERE/out/espressif}"
CH32FUN_REF="${CH32FUN_REF:-b28d285460ce052a179dba8f4a22c6f73ff8e328}"
SRC="$HERE/out/ch32fun"
STAGE="$HERE/out/stage-ch32v003"
CLANG_RESOURCE="${CLANG_RESOURCE:-$HERE/out/stage-wasm/clang-resource/include}"

# 1. ch32fun at a fixed commit, with the clang fixes (see the comments in the patch).
if [[ ! -d "$SRC" ]]; then
  git init -q "$SRC"
  git -C "$SRC" fetch -q --depth 1 https://github.com/cnlohr/ch32fun.git "$CH32FUN_REF"
  git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
  git -C "$SRC" apply "$HERE/patches/ch32fun.patch"
fi

CLANG="$(ls -d "$IDF_TOOLS_PATH"/tools/esp-clang/*/esp-clang/bin/clang | head -1)"
NEWLIB="$(dirname "$(find "$IDF_TOOLS_PATH/tools/riscv32-esp-elf" -path '*riscv32-esp-elf/include/stdio.h' | head -1)")"
[[ -x "$CLANG" && -d "$NEWLIB" ]] || { echo "Needs esp-clang and riscv32-esp-elf (toolchain/setup-idf.sh)" >&2; exit 1; }
[[ -d "$CLANG_RESOURCE" ]] || { echo "Needs clang's headers in $CLANG_RESOURCE (toolchain/build-llvm.sh)" >&2; exit 1; }

# 2. The sysroot, laid out as the browser sees it (/sysroot/…).
S="$STAGE/sysroot"
rm -rf "$STAGE" && mkdir -p "$S"/{ch32fun,lib,clang/include,flags}
cp "$SRC"/ch32fun/*.h "$SRC/ch32fun/ch32fun.c" "$S/ch32fun/"
cp -R "$SRC/extralibs" "$S/extralibs"
cp -R "$NEWLIB" "$S/newlib"
# Without its debug info (DWARF 5; the line table only needs the program's own).
"$(dirname "$CLANG")/llvm-objcopy" --strip-debug "$SRC/misc/libgcc.a" "$S/lib/libgcc.a"
cp "$SRC/LICENSE" "$S/ch32fun/LICENSE"
cp "$SRC/misc/LIBGCC_LICENSE" "$S/lib/LIBGCC_LICENSE"
# Clang's own target-independent headers (stdint.h, stddef.h, …) and RISC-V's.
for h in "$CLANG_RESOURCE"/*.h; do
  case "$(basename "$h")" in
    std*.h|__std*.h|float.h|limits.h|iso646.h|varargs.h|tgmath.h|inttypes.h|riscv_*.h) cp "$h" "$S/clang/include/" ;;
  esac
done
# ch32fun's linker script, preprocessed for the CH32V003 (TARGET_MCU_LD=0: 16K flash, 2K RAM).
"$CLANG" -E -P -x c -DTARGET_MCU=CH32V003 -DMCU_PACKAGE=0 -DTARGET_MCU_LD=0 -DTARGET_MCU_MEMORY_SPLIT=0 \
  "$SRC/ch32fun/ch32fun.ld" > "$S/ch32v003.ld"

# Flags, one argument per line, as for the ESP32-S3 sysroot. /src holds the
# program (and its funconfig.h, which ch32fun.c includes).
cat > "$S/flags/common.txt" <<'EOF'
--target=riscv32-unknown-elf
-march=rv32ec
-mabi=ilp32e
-DCH32V003=1
-Os
-gdwarf-4
-ffunction-sections
-fdata-sections
-msmall-data-limit=8
-ffreestanding
-nostdlib
-nostdinc
-isystem
/sysroot/clang/include
-isystem
/sysroot/newlib
-I/src
-I/sysroot/ch32fun
-I/sysroot/extralibs
-Wall
EOF
printf '%s\n' -std=gnu11 > "$S/flags/c.txt"
printf '%s\n' -std=gnu++17 -fno-exceptions -fno-rtti -fno-use-cxa-atexit -DCPLUSPLUS=1 > "$S/flags/cxx.txt"
cat > "$S/flags/link.txt" <<'EOF'
-T
/sysroot/ch32v003.ld
--gc-sections
@OBJECTS@
/sysroot/lib/libgcc.a
-o
@OUTPUT@
EOF

COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT/sysroot-ch32v003.tar.gz" sysroot
ls -lh "$OUT/sysroot-ch32v003.tar.gz"

# 3. ch32fun's CH32V003 examples (examples/; the other folders are for other chips),
#    in the format of examples.json.
python3 - "$SRC/examples" "$OUT/examples-ch32v003.json" <<'PY'
import json, pathlib, re, sys
root, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
examples = []
for d in sorted(p for p in root.iterdir() if p.is_dir()):
    mk = (d / "Makefile").read_text(errors="replace") if (d / "Makefile").exists() else ""
    mcu = re.search(r"^TARGET_MCU\s*\??:?=\s*(\S+)", mk, re.M)
    if mcu and mcu.group(1) != "CH32V003":
        continue
    files = [f for f in sorted(d.iterdir()) if f.is_file() and f.suffix in (".c", ".cpp", ".h", ".hpp", ".inl", ".S")]
    if not any(f.suffix in (".c", ".cpp") for f in files):
        continue
    target = re.search(r"^TARGET\s*:?=\s*(\S+)", mk, re.M)
    main = next((f for f in files if target and f.stem == target.group(1) and f.suffix in (".c", ".cpp")), None)
    main = main or next(f for f in files if f.suffix in (".c", ".cpp"))
    files.remove(main)
    examples.append({
        "id": f"ch32fun/{d.name}",
        "library": "ch32fun",
        "kind": "ch32v003",
        "title": d.name.replace("_", " "),
        "path": d.name,
        # "../../extralibs/x.h" (relative to ch32fun's repo) is on the include path as "x.h".
        "files": [{"path": f.name, "content": re.sub(r'#include\s+"(?:\.\./)+extralibs/', '#include "', f.read_text(errors="replace"))}
                  for f in [main, *files]],
    })
out.write_text(json.dumps({"examples": examples}))
print(f"examples: {len(examples)} → {out}")
PY
