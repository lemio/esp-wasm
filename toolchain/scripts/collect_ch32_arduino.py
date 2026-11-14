#!/usr/bin/env python3
"""
Add WCH's Arduino core (github.com/openwch/arduino_core_ch32) to the CH32 sysroot,
precompiled with the native esp-clang (the same clang as llvm.wasm), so the browser
only compiles and links the sketch. For each chip in CHIPS (<chip>: ch32v003, ch32x035):

  /sysroot/arduino/cores, system/<series>, variants/<series>   headers (in the repo's
                                     layout: the core includes some by relative path)
  /sysroot/arduino/libraries/<lib>/src   the core's libraries' headers
  /sysroot/arduino/lib/<chip>/  libcore.a (core + HAL + variant), lib<library>.a, and
                              from WCH's GCC (the chip's multilib, without WCH's xw
                              instructions): newlib-nano, libm, libnosys, WCH's
                              libprintf, libstdc++ (Wire uses std::function),
                              libsupc++, libgcc
  /sysroot/arduino/ld/<chip>.ld   the chip's linker script
  /sysroot/wch/include        newlib's headers (+ newlib-nano), libstdc++'s headers
  /sysroot/flags-arduino-<chip>/  common.txt, c.txt, cxx.txt, link.txt

Clang differences handled here:
  - interrupt("WCH-Interrupt-fast") (WCH's GCC: the hardware saves the registers) is
    rewritten to interrupt("machine"); clang would ignore the unknown type and end
    the handler with ret instead of mret. -Werror=ignored-attributes guards this.
  - -fgnuc-version=6.3.0: the core requires GCC >= 6.3 and picks utoa()'s signature
    by GCC version; clang otherwise reports GCC 4.2.1.
  - -march=rv32ec / rv32imac: clang doesn't know WCH's xw extension (rv32ecxw /
    rv32imacxw in boards.txt).
  - patches/arduino_core_ch32.patch: source fixes (a missing #include).
"""
import argparse, pathlib, re, shutil, subprocess, tempfile

# boards.txt's entries. The CH32X035F8U6 (20 pins) uses the core's CH32X035G8U variant (28 pins,
# same die, flash and RAM); the pins its package lacks just aren't there.
CHIPS = {
    "ch32v003": dict(series="CH32V00x", variant="CH32V003F4", march="rv32ec", mabi="ilp32e",
                     multilib="rv32ec/ilp32e", flash=16384, ram=2048, libraries=["Wire", "SPI", "EEPROM"]),
    "ch32x035": dict(series="CH32X035", variant="CH32X035G8U", march="rv32imac", mabi="ilp32",
                     multilib="rv32imac_zaamo_zalrsc/ilp32", flash=63488, ram=20480,
                     libraries=["Wire", "SPI", "EEPROM", "USBPD_SINK"]),
}
# The boards' defaults: 48 MHz internal clock, -Os, no core logs, newlib-nano.
def defines(c: dict) -> list[str]:
    return ["-DARDUINO=10808", "-DARDUINO_ARCH_CH32V", "-DARDUINO_ARCH_CH32", f"-DARDUINO_{c['variant']}",
            f"-D{c['series']}", f"-D{c['variant']}", f'-DVARIANT_H="variant_{c["variant"]}.h"', "-DNDEBUG",
            "-DSYSCLK_FREQ_48MHz_HSI=48000000", "-DF_CPU=48000000"]
def arch(c: dict) -> list[str]:
    return ["--target=riscv32-unknown-elf", f"-march={c['march']}", f"-mabi={c['mabi']}", "-msmall-data-limit=8", "-msave-restore"]
CODEGEN = ["-fgnuc-version=6.3.0", "-Os", "-fsigned-char", "-ffunction-sections", "-fdata-sections", "-fno-common",
           "-Werror=ignored-attributes"]
CXX = ["-std=gnu++14", "-fno-threadsafe-statics", "-fno-rtti", "-fno-exceptions", "-fno-use-cxa-atexit"]
C = ["-std=gnu99"]


def include_dirs(root: str, c: dict) -> list[str]:
    """The core's include path (platform.txt's compiler.ch.extra_include), under root."""
    sr = c["series"]
    return [f"{root}/{d}" for d in (
        "cores/arduino", "cores/arduino/avr", "cores/arduino/ch32", "cores/arduino/ch32/lib",
        f"system/{sr}/USER", f"system/{sr}/SRC/Core", f"system/{sr}/SRC/Debug",
        f"system/{sr}/SRC/Startup", f"system/{sr}/SRC/Peripheral/inc",
        f"system/{sr}/SRC/Peripheral/src", f"variants/{sr}/{c['variant']}")]


def system_includes(cxx_root: str, wch_include: str, clang_include: str, cxx: bool, multilib: str) -> list[str]:
    dirs = ([f"{cxx_root}", f"{cxx_root}/riscv32-wch-elf/{multilib}", f"{cxx_root}/backward"] if cxx else [])
    dirs += [f"{wch_include}/newlib-nano", clang_include, wch_include]
    return [a for d in dirs for a in ("-isystem", d)]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", type=pathlib.Path, required=True, help="arduino_core_ch32 checkout")
    ap.add_argument("--gcc", type=pathlib.Path, required=True, help="WCH's riscv-wch-gcc (for its rv32ec libraries)")
    ap.add_argument("--clang-bin", type=pathlib.Path, required=True, help="esp-clang's bin/")
    ap.add_argument("--clang-include", type=pathlib.Path, required=True, help="clang's resource headers")
    ap.add_argument("--sysroot", type=pathlib.Path, required=True, help="the CH32V003 sysroot to add to")
    ap.add_argument("--patch", type=pathlib.Path, default=pathlib.Path(__file__).parent.parent / "patches/arduino_core_ch32.patch")
    ns = ap.parse_args()
    S = ns.sysroot
    target = ns.gcc / "riscv32-wch-elf"
    gcc_ver = next((ns.gcc / "lib/gcc/riscv32-wch-elf").iterdir()).name
    clang = str(ns.clang_bin / "clang")
    cxx_root = str(target / "include/c++" / gcc_ver)
    objcopy = str(ns.clang_bin / "llvm-objcopy")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(tmp)
        core = tmp / "core"
        shutil.copytree(ns.core, core, ignore=shutil.ignore_patterns(".git", "tools", "*.exe", "*.dll"))
        # Fixes for clang (see the comments in the patch).
        subprocess.run(["patch", "-s", "-p1", "-d", str(core), "-i", str(ns.patch)], check=True)
        for f in core.rglob("*"):
            if f.suffix in (".c", ".cpp", ".h", ".hpp", ".S", ".s") and f.is_file():
                t = f.read_text(errors="replace")
                if "WCH-Interrupt-fast" in t:
                    f.write_text(t.replace('interrupt("WCH-Interrupt-fast")', 'interrupt("machine")'))

        def compile_all(c: dict, srcs: list[pathlib.Path], extra_inc: list[str], name: str) -> pathlib.Path:
            objs = []
            for i, s in enumerate(srcs):
                cxx = s.suffix == ".cpp"
                lang = (["-x", "c++", *CXX] if cxx else ["-x", "assembler-with-cpp"] if s.suffix == ".S" else C)
                obj = tmp / f"{c['variant']}-{name}-{i:03d}.o"
                cmd = [clang, *arch(c), *CODEGEN, "-nostdinc", *defines(c), *lang,
                       *system_includes(cxx_root, str(target / "include"), str(ns.clang_include), cxx, c["multilib"]),
                       *[f"-I{d}" for d in include_dirs(str(core), c) + extra_inc], "-c", str(s), "-o", str(obj)]
                r = subprocess.run(cmd, capture_output=True, text=True)
                if r.returncode:
                    raise SystemExit(f"{c['variant']}: {s.relative_to(core)}:\n{r.stderr}")
                objs.append(str(obj))
            lib = tmp / f"lib{name}.a"
            lib.unlink(missing_ok=True)
            subprocess.run([str(ns.clang_bin / "llvm-ar"), "rcs", str(lib), *objs], check=True)
            return lib

        def copy_headers(rel: str) -> None:
            for f in (core / rel).rglob("*"):
                if f.is_file() and f.suffix in (".h", ".hpp", ".inl"):
                    d = S / "arduino" / f.relative_to(core)
                    d.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(f, d)

        copy_headers("cores/arduino")
        for chip, c in CHIPS.items():
            out = S / "arduino/lib" / chip
            out.mkdir(parents=True, exist_ok=True)
            sr, var = c["series"], f"variants/{c['series']}/{c['variant']}"
            core_srcs = sorted(p for p in (core / "cores/arduino").rglob("*") if p.suffix in (".c", ".cpp", ".S"))
            core_srcs += sorted(p for p in (core / var).iterdir() if p.suffix in (".c", ".cpp"))
            shutil.copy(compile_all(c, core_srcs, [], "core"), out)
            for name in c["libraries"]:
                src = core / "libraries" / name / "src"
                srcs = sorted(p for p in src.rglob("*") if p.suffix in (".c", ".cpp"))
                incs = [str(src), *(str(d) for d in src.rglob("*") if d.is_dir())]
                shutil.copy(compile_all(c, srcs, incs, name), out)
                copy_headers(f"libraries/{name}/src")
            copy_headers(f"system/{sr}")
            copy_headers(f"variants/{sr}")
            # Some of WCH's linker scripts have old Mac line endings (\r only).
            (S / "arduino/ld").mkdir(exist_ok=True)
            ld = (core / f"system/{sr}/SRC/Ld/Link.ld").read_text().replace("\r\n", "\n").replace("\r", "\n")
            (S / "arduino/ld" / f"{chip}.ld").write_text(ld)
            # WCH's runtime libraries (debug info stripped: DWARF 5, and the line table only needs the sketch's).
            wch_lib = target / "lib" / c["multilib"]
            gcc_lib = ns.gcc / "lib/gcc/riscv32-wch-elf" / gcc_ver / c["multilib"]
            for lib, src in [("libprintf.a", wch_lib), ("libc_nano.a", wch_lib), ("libm.a", wch_lib), ("libnosys.a", wch_lib),
                             ("libstdc++.a", wch_lib), ("libsupc++.a", wch_lib), ("libgcc.a", gcc_lib)]:
                subprocess.run([objcopy, "--strip-debug", str(src / lib), str(out / lib)], check=True)
            print(f"  {chip} ({c['variant']}): libcore.a ({len(core_srcs)} files), {', '.join(c['libraries'])}")
        for lic in ("LICENSE", "README.md"):
            if (ns.core / lic).exists():
                shutil.copy(ns.core / lic, S / "arduino" / lic)

    # newlib's and libstdc++'s headers, only the chips' multilibs' target-specific parts.
    inc = S / "wch/include"
    shutil.copytree(target / "include", inc, ignore=shutil.ignore_patterns("c++"))
    cxx_dst = inc / "c++" / gcc_ver
    shutil.copytree(target / "include/c++" / gcc_ver, cxx_dst, ignore=shutil.ignore_patterns("riscv32-wch-elf"))
    for c in CHIPS.values():
        shutil.copytree(target / "include/c++" / gcc_ver / "riscv32-wch-elf" / c["multilib"],
                        cxx_dst / "riscv32-wch-elf" / c["multilib"])
    for lic in ns.gcc.glob("*LICENSE*"):
        shutil.copy(lic, S / "wch" / lic.name)

    # Flags for the browser (one argument per line). The sketch is in /src.
    cxx_sys = "/sysroot/wch/include/c++/" + gcc_ver
    for chip, c in CHIPS.items():
        fl = S / f"flags-arduino-{chip}"
        fl.mkdir(exist_ok=True)
        sysinc_c = system_includes(cxx_sys, "/sysroot/wch/include", "/sysroot/clang/include", False, c["multilib"])
        sysinc_cxx = system_includes(cxx_sys, "/sysroot/wch/include", "/sysroot/clang/include", True, c["multilib"])
        lib_inc = [f"-I/sysroot/arduino/libraries/{n}/src" for n in c["libraries"]]
        common = [*arch(c), *CODEGEN, "-gdwarf-4", "-nostdinc", *defines(c), "-I/src",
                  *[f"-I{d}" for d in include_dirs("/sysroot/arduino", c)], *lib_inc]
        (fl / "common.txt").write_text("\n".join(common) + "\n")
        (fl / "c.txt").write_text("\n".join([*C, *sysinc_c]) + "\n")
        (fl / "cxx.txt").write_text("\n".join([*CXX, *sysinc_cxx]) + "\n")
        L = f"/sysroot/arduino/lib/{chip}"
        link = ["-T", f"/sysroot/arduino/ld/{chip}.ld", "--gc-sections",
                f"--defsym=__FLASH_SIZE={c['flash']}", f"--defsym=__RAM_SIZE={c['ram']}",
                "@OBJECTS@", "--whole-archive", f"{L}/libcore.a", "--no-whole-archive", "--start-group",
                *[f"{L}/lib{n}.a" for n in c["libraries"]],
                *[f"{L}/{n}" for n in ("libprintf.a", "libc_nano.a", "libm.a", "libnosys.a", "libstdc++.a", "libsupc++.a", "libgcc.a")],
                "--end-group", "-o", "@OUTPUT@"]
        (fl / "link.txt").write_text("\n".join(link) + "\n")
    print(f"arduino: {', '.join(CHIPS)} → {S}")

if __name__ == "__main__":
    main()
