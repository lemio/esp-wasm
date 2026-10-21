#!/usr/bin/env bash
# Fetch the Arduino core (arduino-esp32, as an ESP-IDF component) and the
# third-party libraries in arduino-libraries.txt, and wrap each library as an
# ESP-IDF component so the sysroot build precompiles it.
#
# Output (all gitignored):
#   out/components/arduino/       arduino-esp32
#   out/arduino-libs/<name>/      library sources (+ patches/arduino-libs/<name>.patch)
#   out/components/lib_<name>/    generated component wrappers
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ARDUINO_REF="${ARDUINO_REF:-3.3.12}"   # supports ESP-IDF >=5.3,<6.2
OUT="$HERE/out"
mkdir -p "$OUT/components" "$OUT/arduino-libs"

if [[ ! -d "$OUT/components/arduino" ]]; then
  git clone --depth 1 --branch "$ARDUINO_REF" https://github.com/espressif/arduino-esp32.git "$OUT/components/arduino"
  # Fixes for the browser build (see the comments in the patch).
  git -C "$OUT/components/arduino" apply "$HERE/patches/arduino-esp32.patch"
fi

# TinyUSB, for the USB-OTG variant of the sysroot (USB keyboards, mice, MIDI…: USB.h, USBHIDKeyboard.h).
# Arduino's own builds take the arduino_tinyusb component from esp32-arduino-lib-builder, with TinyUSB
# cloned into it and patched. It lives outside out/components: its Kconfig turns TinyUSB on by default,
# and the regular sysroot (USB mode "Hardware CDC and JTAG") must not see it.
LIB_BUILDER_REF="${LIB_BUILDER_REF:-release/v6.0}"
TINYUSB_REF="${TINYUSB_REF:-cb3caee74de7dbb9fc91a5fdb37b448a63eadae0}"   # the commit before TinyUSB dropped the host vendor driver, which release/v6.0's component still lists
USB_COMP="$OUT/components-usb/arduino_tinyusb"
if [[ ! -d "$USB_COMP" ]]; then
  tmp="$(mktemp -d)"
  git clone -q --depth 1 --branch "$LIB_BUILDER_REF" --filter=blob:none --sparse https://github.com/espressif/esp32-arduino-lib-builder.git "$tmp/lb"
  git -C "$tmp/lb" sparse-checkout set components/arduino_tinyusb patches/tinyusb
  mkdir -p "$OUT/components-usb" && cp -R "$tmp/lb/components/arduino_tinyusb" "$USB_COMP"
  git init -q "$USB_COMP/tinyusb" && git -C "$USB_COMP/tinyusb" fetch -q --depth 1 https://github.com/hathach/tinyusb.git "$TINYUSB_REF" && git -C "$USB_COMP/tinyusb" checkout -q FETCH_HEAD
  for d in "$tmp"/lb/patches/tinyusb/*.diff; do
    [[ -e "$d" ]] || continue
    git -C "$USB_COMP/tinyusb" apply --reverse --check "$d" 2>/dev/null && continue   # already upstream
    git -C "$USB_COMP/tinyusb" apply "$d" && echo "patched TinyUSB: $(basename "$d")"
  done
  rm -rf "$tmp"
fi

LIBS="$(grep -vE '^\s*(#|$)' "$HERE/arduino-libraries.txt")"

# 1. Fetch and patch.
while read -r name repo tag; do
  src="$OUT/arduino-libs/$name"
  if [[ ! -d "$src" ]]; then
    git -c advice.detachedHead=false clone -q --depth 1 --branch "$tag" "https://github.com/$repo.git" "$src"
    patch="$HERE/patches/arduino-libs/$name.patch"
    if [[ -f "$patch" ]]; then git -C "$src" apply "$patch" && echo "patched $name"; fi
  fi
done <<< "$LIBS"

# 2. Generate a component per library. Dependencies on other listed libraries
#    come from library.properties ("depends=Adafruit BusIO, …").
python3 - "$OUT" <<'PY'
import pathlib, re, sys
out = pathlib.Path(sys.argv[1])
libs = {}
for line in (out.parent / "arduino-libraries.txt").read_text().splitlines():
    if line.strip() and not line.lstrip().startswith("#"):
        name, repo, tag = line.split()
        libs[name] = (repo, tag)

def props(src):
    f = src / "library.properties"
    return dict(re.findall(r"^(\w+)=(.*)$", f.read_text(), re.M)) if f.exists() else {}

import json
key = lambda n: re.sub(r"[^a-z0-9]", "", n.lower())
by_name = {}
for name, (repo, _) in libs.items():
    p = props(out / "arduino-libs" / name)
    for alias in (name, p.get("name", name), repo.split("/")[1]):
        by_name[key(alias)] = name

def declared_deps(src):
    """Dependency names from library.properties (Arduino) and library.json (PlatformIO)."""
    names = [re.sub(r"\(.*\)", "", d) for d in props(src).get("depends", "").split(",")]
    j = src / "library.json"
    if j.exists():
        d = json.loads(j.read_text()).get("dependencies", [])
        names += [x.get("name", "") for x in d] if isinstance(d, list) else list(d)
    return names

# Headers a library may use beyond the Arduino core, as in the Arduino IDE
# (where all of ESP-IDF is visible).
IDF = ("esp_wifi esp_netif esp_event lwip esp_http_server esp_http_client mbedtls "
       "nvs_flash esp_timer bt driver esp_driver_gpio esp_driver_rmt esp_driver_spi "
       "esp_driver_i2c esp_driver_ledc esp_driver_uart esp_driver_mcpwm esp_driver_i2s esp_driver_pcnt "
       "esp_adc esp_lcd esp_mm espressif__network_provisioning")

for name, (repo, tag) in libs.items():
    src = out / "arduino-libs" / name
    deps = sorted({"lib_" + by_name[key(d)] for d in declared_deps(src)
                   if key(d) in by_name and by_name[key(d)] != name})
    # Arduino library layout: sources under src/ (recursive), or else in the
    # root folder plus utility/ (Arduino library specification).
    if (src / "src").is_dir():
        glob, pats, incs = "GLOB_RECURSE", ["src/*.c", "src/*.cpp", "src/*.S"], ["src"]
    else:
        glob, pats, incs = "GLOB", ["*.c", "*.cpp", "utility/*.c", "utility/*.cpp"], ["."]
        if (src / "utility").is_dir():
            incs.append("utility")
    q = lambda rel: '"%s"' % (src / rel).as_posix().replace("/./", "/").rstrip("/.")
    comp = out / "components" / f"lib_{name}"
    comp.mkdir(parents=True, exist_ok=True)
    (comp / "CMakeLists.txt").write_text(f"""# Generated by fetch-arduino.sh from {repo}@{tag}.
file({glob} srcs {" ".join(q(p) for p in pats)})
idf_component_register(SRCS ${{srcs}} INCLUDE_DIRS {" ".join(q(i) for i in incs)}
                       REQUIRES arduino {" ".join(deps)} {IDF})
# Third-party code: don't fail the sysroot build on its warnings. Narrowing in
# braces is only a warning in GCC (which these libraries are written for).
# (Header-only libraries have no sources and get an INTERFACE target.)
if(srcs)
  target_compile_options(${{COMPONENT_LIB}} PRIVATE -Wno-error -w
                         $<$<COMPILE_LANGUAGE:CXX>:-Wno-c++11-narrowing>)
endif()
""")
    print(f"lib_{name:<18} {repo}@{tag}" + (f"  deps: {', '.join(deps)}" if deps else ""))
PY
