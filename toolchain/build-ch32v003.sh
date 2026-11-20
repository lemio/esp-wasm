#!/usr/bin/env bash
# Package the CH32V003 sysroot for the browser. Two frameworks, both built with clang
# and linked with ld.lld (in llvm.wasm, built with the RISCV target):
#  - ch32fun (https://github.com/cnlohr/ch32fun, MIT): its startup code, headers and
#    linker script, newlib's headers, clang's generic headers, and ch32fun's rv32e libgcc.
#  - WCH's Arduino core (https://github.com/openwch/arduino_core_ch32), precompiled for
#    the CH32V003F4 by scripts/collect_ch32_arduino.py, with the C library and runtime
#    from WCH's own GCC (its rv32ec/ilp32e multilib).
#
#   toolchain/build-ch32v003.sh <out-dir>
#
# Writes <out-dir>/sysroot-ch32v003.tar.gz and <out-dir>/examples-ch32v003.json.
# Needs: git, curl, python3, and the esp-clang + riscv32-esp-elf toolchains from
# setup-idf.sh (for the linker-script preprocessing and newlib's headers). Downloads
# WCH's GCC (~300 MB, checksum-verified) once, for its rv32ec libraries.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mkdir -p "${1:?usage: build-ch32v003.sh <out-dir>}" && cd "$1" && pwd)"
IDF_TOOLS_PATH="${IDF_TOOLS_PATH:-$HERE/out/espressif}"
CH32FUN_REF="${CH32FUN_REF:-b28d285460ce052a179dba8f4a22c6f73ff8e328}"
SRC="$HERE/out/ch32fun"
STAGE="$HERE/out/stage-ch32v003"
CLANG_RESOURCE="${CLANG_RESOURCE:-$HERE/out/stage-wasm/clang-resource/include}"
ARDUINO_CH32_REF="${ARDUINO_CH32_REF:-65d902038aafff6bd2e2322828fa055bcb5704e9}"
ARDUINO_CH32="$HERE/out/arduino_core_ch32"
# WCH's GCC 15.2, as listed in WCH's Arduino board index (package_ch32v_index.json).
WCH_GCC="$HERE/out/wch-gcc/riscv-wch-gcc"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) WCH_GCC_TGZ=riscv-wch-gcc-15.2.0-macos-arm64.tar.gz
                WCH_GCC_SHA=67483328687f4cafa38edf7b54622101b3a4b31ed23fc1b48f9359c081d99444 ;;
  Linux-x86_64) WCH_GCC_TGZ=riscv-wch-gcc-15.2.0-linux-x86_64.tar.gz; WCH_GCC_SHA="${WCH_GCC_SHA:-}" ;;
  *) echo "No WCH GCC for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# 1. ch32fun at a fixed commit, with the clang fixes (see the comments in the patch).
if [[ ! -d "$SRC" ]]; then
  git init -q "$SRC"
  git -C "$SRC" fetch -q --depth 1 https://github.com/cnlohr/ch32fun.git "$CH32FUN_REF"
  git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
  git -C "$SRC" apply "$HERE/patches/ch32fun.patch"
fi

if [[ ! -d "$ARDUINO_CH32" ]]; then
  git init -q "$ARDUINO_CH32"
  git -C "$ARDUINO_CH32" fetch -q --depth 1 https://github.com/openwch/arduino_core_ch32.git "$ARDUINO_CH32_REF"
  git -C "$ARDUINO_CH32" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi
if [[ ! -x "$WCH_GCC/bin/riscv32-wch-elf-gcc" ]]; then
  mkdir -p "$(dirname "$WCH_GCC")"
  tgz="$(dirname "$WCH_GCC")/$WCH_GCC_TGZ"
  curl -fL -o "$tgz" "https://github.com/medtty/board_manager_files/releases/download/riscv-wch-gcc-15.2.0/$WCH_GCC_TGZ"
  if [[ -n "$WCH_GCC_SHA" ]]; then
    echo "$WCH_GCC_SHA  $tgz" | shasum -a 256 -c - || { rm -f "$tgz"; exit 1; }
  fi
  tar -C "$(dirname "$WCH_GCC")" -xzf "$tgz"
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

# The CH32X035 (QingKe V4C: rv32imac, 62K flash, 20K RAM; the F8U6 and its siblings, ch32fun's
# MCU_PACKAGE=1, TARGET_MCU_LD=4): its own linker script, flags and libgcc (WCH GCC's
# rv32imac multilib; ch32fun's libgcc.a is rv32e only).
"$CLANG" -E -P -x c -DTARGET_MCU=CH32X035 -DMCU_PACKAGE=1 -DTARGET_MCU_LD=4 -DTARGET_MCU_MEMORY_SPLIT=0 \
  "$SRC/ch32fun/ch32fun.ld" > "$S/ch32x035.ld"
mkdir -p "$S/lib/rv32imac" "$S/flags-x035"
"$(dirname "$CLANG")/llvm-objcopy" --strip-debug \
  "$WCH_GCC/lib/gcc/riscv32-wch-elf/15.2.0/rv32imac_zaamo_zalrsc/ilp32/libgcc.a" "$S/lib/rv32imac/libgcc.a"
sed -e 's/^-march=rv32ec$/-march=rv32imac/' -e 's/^-mabi=ilp32e$/-mabi=ilp32/' -e 's/^-DCH32V003=1$/-DCH32X035=1/' \
  "$S/flags/common.txt" > "$S/flags-x035/common.txt"
echo "-DCH32X03x=1" >> "$S/flags-x035/common.txt"
cp "$S/flags/c.txt" "$S/flags/cxx.txt" "$S/flags-x035/"
sed -e 's#/sysroot/ch32v003.ld#/sysroot/ch32x035.ld#' -e 's#/sysroot/lib/libgcc.a#/sysroot/lib/rv32imac/libgcc.a#' \
  "$S/flags/link.txt" > "$S/flags-x035/link.txt"

# WCH's Arduino core, precompiled (see scripts/collect_ch32_arduino.py).
python3 "$HERE/scripts/collect_ch32_arduino.py" --core "$ARDUINO_CH32" --gcc "$WCH_GCC" \
  --clang-bin "$(dirname "$CLANG")" --clang-include "$S/clang/include" --sysroot "$S"

COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$OUT/sysroot-ch32v003.tar.gz" sysroot
ls -lh "$OUT/sysroot-ch32v003.tar.gz"

# 3. ch32fun's CH32V003 examples (examples/; the other folders are for other chips),
#    in the format of examples.json.
#    Then the Arduino core's library examples (Wire, SPI, EEPROM), kind "ch32v003-arduino".
python3 - "$SRC/examples" "$OUT/examples-ch32v003.json" "$ARDUINO_CH32/libraries" <<'PY'
import json, pathlib, re, sys
root, out, ard = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
examples = []
def ch32fun_examples(root, chip, mcu):
    for d in sorted(p for p in root.iterdir() if p.is_dir()):
        mk = (d / "Makefile").read_text(errors="replace") if (d / "Makefile").exists() else ""
        m = re.search(r"^TARGET_MCU\s*\??:?=\s*(\S+)", mk, re.M)
        if m and not m.group(1).startswith(mcu):
            continue
        files = [f for f in sorted(d.iterdir()) if f.is_file() and f.suffix in (".c", ".cpp", ".h", ".hpp", ".inl", ".S")]
        if not any(f.suffix in (".c", ".cpp") for f in files):
            continue
        target = re.search(r"^TARGET\s*:?=\s*(\S+)", mk, re.M)
        main = next((f for f in files if target and f.stem == target.group(1) and f.suffix in (".c", ".cpp")), None)
        main = main or next(f for f in files if f.suffix in (".c", ".cpp"))
        files.remove(main)
        # Headers taken from a neighbouring example ("../i2c_sensor_test/lib_i2c.h"): copied in.
        for f in [main, *files]:
            for rel in re.findall(r'#include\s+"\.\./([^"./][^"]*/[^"/]+)"', f.read_text(errors="replace")):
                dep = d.parent / rel
                if dep.is_file() and dep.name not in [g.name for g in files]:
                    files.append(dep)
        examples.append({
            "id": f"ch32fun/{chip}/{d.name}",
            "library": "ch32fun",
            "kind": "ch32v003",
            **({"chip": chip} if chip != "ch32v003" else {}),
            "title": d.name.replace("_", " "),
            "path": d.name if chip == "ch32v003" else f"x035/{d.name}",
            # "../../extralibs/x.h" (relative to ch32fun's repo) is on the include path as "x.h".
            "files": [{"path": f.name, "content": re.sub(r'#include\s+"\.\./[^"./][^"]*/([^"/]+)"', r'#include "\1"',
                                                         re.sub(r'#include\s+"(?:\.\./)+extralibs/', '#include "', f.read_text(errors="replace")))}
                      for f in [main, *files]],
        })
ch32fun_examples(root, "ch32v003", "CH32V003")
ch32fun_examples(root.parent / "examples_x035", "ch32x035", "CH32X03")
for lib in ("Wire", "SPI", "EEPROM", "USBPD_SINK"):
    for d in sorted((ard / lib / "examples").glob("*/")):
        files = sorted(f for f in d.iterdir() if f.is_file() and f.suffix in (".ino", ".c", ".cpp", ".h"))
        main = next((f for f in files if f.suffix == ".ino"), None)
        if not main:
            continue
        files.remove(main)
        examples.append({
            "id": f"arduino-ch32/{lib}/{d.name}",
            "library": f"Arduino {lib}",
            "kind": "ch32v003-arduino",
            **({"chip": "ch32x035"} if lib == "USBPD_SINK" else {}),
            "title": d.name.replace("_", " "),
            "path": f"{lib}/{d.name}",
            "files": [{"path": f.name, "content": f.read_text(errors="replace")} for f in [main, *files]],
        })
out.write_text(json.dumps({"examples": examples}))
print(f"examples: {len(examples)} → {out}")
PY
