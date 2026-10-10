#!/usr/bin/env python3
"""
Collect a relocatable sysroot from a finished ESP-IDF build made with
IDF_TOOLCHAIN=clang, for the in-browser compiler (clang) and linker (GNU ld).

Host paths are mapped to short virtual paths under /sysroot (see PREFIXES) so
the browser VFS sees the same tree the native build used:
  /sysroot/idf/…      $IDF_PATH (headers, linker scripts)
  /sysroot/build/…    the template build dir (component archives, generated ld scripts, sdkconfig.h)
  /sysroot/clang/…    esp-clang (builtin headers, newlib/libstdc++ headers and libs)
  /sysroot/project/…  the template project (incl. managed_components)
  /sysroot/<name>/…   extra --prefix PATH=NAME mappings (Arduino core, libraries)

Writes <out>/flags/{common,c,cxx,link}.txt (one argument per line).
"""
import argparse, json, os, re, shlex, shutil, subprocess, sys
from pathlib import Path

HEADER_EXT = {".h", ".hpp", ".hh", ".hxx", ".inc", ".inl", ".ipp", ".tpp", ".tcc", ".def", ""}

# Flags that make sense for IDF's own build but not for user code in the browser.
DROP_EXACT = {"-MD", "-MMD", "-MP", "-fcolor-diagnostics", "-fdiagnostics-color=always",
              "-Werror", "-ggdb", "-g", "-gdwarf-4"}
DROP_WITH_ARG = {"-o", "-c", "-MT", "-MF", "-MQ"}
DROP_PREFIX = ("-fmacro-prefix-map=", "-ffile-prefix-map=", "-fdebug-prefix-map=", "-Werror=")
# GNU ld options we drop: --cref crashes the wasm build (deep recursion), and the
# map file is useless in the browser.
LD_DROP_EXACT = {"--cref"}
LD_DROP_PREFIX = ("--Map=", "-Map=")


class Sysroot:
    def __init__(self, out: Path, prefixes: list[tuple[Path, str]], objcopy: str):
        self.out = out
        self.prefixes = [(p.resolve(), v) for p, v in prefixes]
        self.objcopy = objcopy
        self.copied: set[Path] = set()

    def virt(self, host: Path) -> str:
        host = host.resolve()
        for prefix, v in self.prefixes:
            if host == prefix:
                return f"/sysroot/{v}"
            if prefix in host.parents:
                return f"/sysroot/{v}/{host.relative_to(prefix).as_posix()}"
        sys.exit(f"collect_sysroot: no virtual prefix for {host}")

    def copy_file(self, host: Path) -> str:
        host = host.resolve()
        v = self.virt(host)
        if host not in self.copied:
            dst = self.out / v.removeprefix("/sysroot/")
            dst.parent.mkdir(parents=True, exist_ok=True)
            if host.suffix in (".a", ".o", ".obj"):
                # Debug info is useless in the browser and doubles the download.
                subprocess.run([self.objcopy, "--strip-debug", str(host), str(dst)], check=True)
            else:
                shutil.copy2(host, dst)
            self.copied.add(host)
        return v

    def copy_dir(self, host: Path, exts: set[str] | None) -> str:
        host = host.resolve()
        if host.is_dir():
            for f in host.rglob("*"):
                if f.is_file() and (exts is None or f.suffix in exts):
                    self.copy_file(f)
        return self.virt(host)


def system_includes(clang: str, lang: str, extra: list[str]) -> list[str]:
    """The implicit <...> search path of the native esp-clang for this language."""
    res = subprocess.run([clang, *extra, "-x", lang, "-E", "-v", "-"], input="", capture_output=True, text=True)
    m = re.search(r"#include <\.\.\.> search starts here:\n(.*?)\nEnd of search list", res.stderr, re.S)
    return [l.strip() for l in m.group(1).splitlines()] if m else []


def compile_flags(cmd: str, cwd: Path, sr: Sysroot) -> list[tuple[str, ...]]:
    """Flags as groups, so "-I <dir>" pairs stay together when C and C++ are diffed."""
    args = shlex.split(cmd)[1:]  # drop the compiler
    out: list[tuple[str, ...]] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a in DROP_WITH_ARG:
            i += 2
            continue
        if a in DROP_EXACT or a.startswith(DROP_PREFIX) or a.endswith((".c", ".cpp", ".cc", ".S")):
            i += 1
            continue
        for flag in ("-isystem", "-iquote", "-idirafter", "-include", "-imacros", "-I"):
            if a == flag or (flag == "-I" and a.startswith("-I")):
                val = args[i + 1] if a == flag else a[len(flag):]
                p = Path(val) if os.path.isabs(val) else cwd / val
                target = sr.copy_file(p) if p.is_file() else sr.copy_dir(p, HEADER_EXT)
                out.append((flag, target))
                i += 2 if a == flag else 1
                break
        else:
            out.append((a,))
            i += 1
    return out


def link_args(build: Path, sr: Sysroot) -> list[str]:
    elf = json.loads((build / "project_description.json").read_text())["app_elf"]
    cmds = subprocess.check_output(["ninja", "-C", str(build), "-t", "commands", elf], text=True)
    link_line = next(l for l in reversed(cmds.splitlines()) if f"-o {elf}" in l)
    # "cmd1 && cmd2 && …": keep only the clang link step.
    link_cmd = next(p.strip() for p in link_line.split(" && ") if f"-o {elf}" in p)
    # Ask the clang driver for the underlying GNU ld invocation.
    res = subprocess.run(link_cmd + " -###", shell=True, cwd=build, capture_output=True, text=True)
    ld_line = [l for l in res.stderr.splitlines() if l.startswith(' "')][-1]
    args = shlex.split(ld_line)[1:]

    out: list[str] = ["-L", sr.copy_dir(build, {".ld"})]  # -T scripts relative to the build dir
    first_input = None  # where the first object/archive goes on the line
    found_main = False
    i = 0
    while i < len(args):
        a = args[i]
        if a in LD_DROP_EXACT or a.startswith(LD_DROP_PREFIX):
            i += 1
            continue
        if a == "-o":
            out += ["-o", "@OUTPUT@"]
            i += 2
            continue
        p = Path(a) if os.path.isabs(a) else build / a
        if a.endswith("/libmain.a"):
            found_main = True  # replaced by the user's objects (see below)
        elif a.startswith("-L"):
            d = Path(a[2:]) if os.path.isabs(a[2:]) else build / a[2:]
            out.append("-L" + sr.copy_dir(d, {".a", ".ld"}))
        elif a == "-T":
            out += ["-T", args[i + 1]]  # resolved through -L
            i += 1
        elif not a.startswith("-") and p.is_file():
            if first_input is None:
                first_input = len(out)
            out.append(sr.copy_file(p))
        else:
            out.append(a)
        i += 1
    if not found_main or first_input is None:
        sys.exit("collect_sysroot: libmain.a not found in the link line")
    # The user's objects go before every library, as in the Arduino IDE. IDF
    # repeats its library list to resolve cycles, and libarduino.a appears
    # before libmain.a; there its app_main would win over an ESP-IDF
    # program's own. Objects first, the user's definitions always win.
    out.insert(first_input, "@OBJECTS@")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", type=Path, required=True)
    ap.add_argument("--project", type=Path, required=True)
    ap.add_argument("--idf", type=Path, required=True)
    ap.add_argument("--clang-root", type=Path, required=True, help="esp-clang install dir")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--prefix", action="append", default=[], metavar="PATH=NAME",
                    help="map another host directory to /sysroot/NAME")
    ns = ap.parse_args()
    extra = [(Path(p.split("=", 1)[0]), p.split("=", 1)[1]) for p in ns.prefix]
    clang = str(ns.clang_root / "bin" / "clang")
    sr = Sysroot(
        ns.out,
        [(ns.build, "build"), (ns.project, "project"), (ns.idf, "idf"), (ns.clang_root, "clang"), *extra],
        str(ns.clang_root / "bin" / "llvm-objcopy"),
    )

    entries = json.loads((ns.build / "compile_commands.json").read_text())
    c_entry = next((e for e in entries if e["file"].endswith("main/main.c")), None)
    cxx_entry = next((e for e in entries if e["file"].endswith("main/cxx_stub.cpp")), None)
    if not c_entry or not cxx_entry:
        sys.exit("compile_commands.json has no main/main.c or main/cxx_stub.cpp entry")

    c = compile_flags(c_entry["command"], Path(c_entry["directory"]), sr)
    cxx = compile_flags(cxx_entry["command"], Path(cxx_entry["directory"]), sr)

    common = [g for g in c if g in cxx]
    only_c = [g for g in c if g not in common]
    only_cxx = [g for g in cxx if g not in common]

    # A wasm clang can't find its install dir, so pass the system include path
    # explicitly. Per language: C++ needs libstdc++'s dirs before newlib's.
    target = ["--target=xtensa-esp-elf", "-mcpu=esp32s3"]
    # Match the multilib (rtti / no-rtti) the build actually uses.
    rtti = [] if ("-fno-rtti",) not in cxx else ["-fno-rtti"]
    for groups, lang, extra in ((only_c, "c", []), (only_cxx, "c++", rtti)):
        groups.append(("-nostdinc",))
        for d in system_includes(clang, lang, target + extra):
            groups.append(("-isystem", sr.copy_dir(Path(d), None)))
    lines = lambda groups: "\n".join(a for g in groups for a in g) + "\n"

    flags = ns.out / "flags"
    flags.mkdir(parents=True, exist_ok=True)
    (flags / "common.txt").write_text(lines(common))
    (flags / "c.txt").write_text(lines(only_c))
    (flags / "cxx.txt").write_text(lines(only_cxx))
    (flags / "link.txt").write_text("\n".join(link_args(ns.build, sr)) + "\n")
    print(f"sysroot: {len(sr.copied)} files → {ns.out}")


if __name__ == "__main__":
    main()
