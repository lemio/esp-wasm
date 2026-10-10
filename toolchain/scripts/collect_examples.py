#!/usr/bin/env python3
"""
Collect the Arduino examples that can build with this sysroot into one JSON
file for the web app's examples panel.

Sources: the arduino-esp32 core libraries and the third-party libraries in
arduino-libraries.txt. Kept are examples of libraries that are compiled into
the sysroot, whose ci.yml requirements (CONFIG_*=value) hold for our sdkconfig.

An Arduino sketch is a folder <name>/<name>.ino. Other .ino files in the folder
are appended to the main one (as the Arduino IDE does); .h/.hpp/.c/.cpp files
next to it, or under src/, become extra files.

  collect_examples.py --core out/components/arduino --libs out/arduino-libs \
      --sdkconfig sysroot-project/sdkconfig --out ../public/toolchain/examples.json
"""
import argparse, json, re, sys
from pathlib import Path

EXTRA_EXT = {".h", ".hpp", ".c", ".cpp"}
MAX_FILE = 256 * 1024  # skip generated blobs


def load_sdkconfig(path: Path) -> dict[str, str]:
    return dict(re.findall(r"^(CONFIG_[A-Za-z0-9_]+)=(.*)$", path.read_text(), re.M))


def parse_ci(path: Path) -> dict:
    """Tiny parser for the subset of YAML used by arduino-esp32's ci.yml files."""
    out: dict = {}
    key = None
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            key, _, val = line.partition(":")
            key = key.strip()
            out[key] = val.strip() or ([] if key.startswith("requires") else {})
        elif key is not None:
            item = line.strip()
            if item.startswith("- ") and isinstance(out[key], list):
                out[key].append(item[2:].strip())
            elif ":" in item and isinstance(out[key], dict):
                k, _, v = item.partition(":")
                out[key][k.strip()] = v.strip()
    return out


def requirement_holds(req: str, sdk: dict[str, str]) -> bool:
    name, _, pattern = req.partition("=")
    value = sdk.get(name.strip())
    return value is not None and re.fullmatch(pattern.strip(), value.strip('"')) is not None


def supported(example_dir: Path, sdk: dict[str, str]) -> bool:
    ci = example_dir / "ci.yml"
    if not ci.exists():
        return True
    c = parse_ci(ci)
    targets = c.get("targets")
    if isinstance(targets, dict) and targets.get("esp32s3", "").lower() == "false":
        return False
    if any(not requirement_holds(r, sdk) for r in c.get("requires", []) or []):
        return False
    any_of = c.get("requires_any") or []
    return not any_of or any(requirement_holds(r, sdk) for r in any_of)


def read(path: Path) -> str | None:
    if path.stat().st_size > MAX_FILE:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def sketch(main: Path) -> dict | None:
    folder = main.parent
    code = read(main)
    if code is None:
        return None
    # Other .ino files in the folder: concatenated after the main one, in name order.
    for other in sorted(p for p in folder.glob("*.ino") if p != main):
        extra = read(other)
        if extra:
            code += f"\n\n// ---- {other.name} ----\n{extra}"
    files = [{"path": "sketch.ino", "content": code}]
    for p in sorted(folder.iterdir()):
        if p.is_file() and p.suffix in EXTRA_EXT and (c := read(p)) is not None:
            files.append({"path": p.name, "content": c})
    src = folder / "src"
    if src.is_dir():
        for p in sorted(src.rglob("*")):
            if p.is_file() and p.suffix in EXTRA_EXT and (c := read(p)) is not None:
                files.append({"path": p.relative_to(folder).as_posix(), "content": c})
    return {"files": files}


def examples_of(lib_name: str, lib_dir: Path, kind: str, sdk: dict[str, str]):
    ex_root = lib_dir / "examples"
    if not ex_root.is_dir():
        return
    for main in sorted(ex_root.rglob("*.ino")):
        if main.stem != main.parent.name:
            continue  # secondary tab of another sketch
        if not supported(main.parent, sdk):
            continue
        s = sketch(main)
        if s is None:
            continue
        rel = main.parent.relative_to(ex_root).as_posix()
        yield {
            "id": f"{lib_name}/{rel}",
            "library": lib_name,
            "kind": kind,
            "title": main.stem,
            "path": rel,
            **s,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", type=Path, required=True, help="arduino-esp32 checkout")
    ap.add_argument("--libs", type=Path, required=True, help="out/arduino-libs")
    ap.add_argument("--sdkconfig", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ns = ap.parse_args()
    sdk = load_sdkconfig(ns.sdkconfig)

    examples = []
    for lib_dir in sorted((ns.core / "libraries").iterdir()):
        if not lib_dir.is_dir():
            continue
        name = lib_dir.name
        # Core libraries compiled into the sysroot have CONFIG_ARDUINO_SELECTIVE_<name>=y.
        # "ESP32" holds examples of the core itself.
        if name != "ESP32" and sdk.get(f"CONFIG_ARDUINO_SELECTIVE_{name}") != "y":
            continue
        examples += examples_of(name, lib_dir, "core", sdk)
    for lib_dir in sorted(ns.libs.iterdir()):
        if lib_dir.is_dir():
            examples += examples_of(lib_dir.name, lib_dir, "library", sdk)

    ns.out.parent.mkdir(parents=True, exist_ok=True)
    ns.out.write_text(json.dumps({"examples": examples}, separators=(",", ":")))

    # Names of the libraries in the sysroot (folder, Arduino and PlatformIO names),
    # so the browser doesn't install a dependency that's already built in.
    builtin = {p.name for p in (ns.core / "libraries").iterdir() if p.is_dir()}
    for d in ns.libs.iterdir():
        if not d.is_dir():
            continue
        builtin.add(d.name)
        props = d / "library.properties"
        if props.exists() and (m := re.search(r"^name=(.+)$", props.read_text(errors="replace"), re.M)):
            builtin.add(m.group(1).strip())
        lj = d / "library.json"
        if lj.exists():
            try:
                builtin.add(json.loads(lj.read_text())["name"])
            except (ValueError, KeyError):
                pass
    (ns.out.parent / "builtin-libraries.json").write_text(json.dumps(sorted(builtin, key=str.lower)))
    by_kind = {k: sum(1 for e in examples if e["kind"] == k) for k in ("core", "library")}
    print(f"examples: {len(examples)} ({by_kind['core']} core, {by_kind['library']} library) → {ns.out}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
