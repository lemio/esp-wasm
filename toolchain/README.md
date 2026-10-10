# toolchain/

Offline build of everything the browser downloads from `public/toolchain/`:

| File | Produced by | Contents |
|---|---|---|
| `llvm.wasm` (44 MB, 15.6 MB gzip) | `build-llvm.sh` | clang from `espressif/llvm-project` `esp-20.1.1_20250829`, Xtensa only, wasm32-wasip1 |
| `ld.wasm` (1.6 MB) | `build-binutils.sh` | GNU ld 2.45 (`espressif/binutils-gdb`) with the static ESP32-S3 core config |
| `sysroot.tar.gz` | `build-sysroot.sh` | ESP-IDF + Arduino core + libraries: headers, `.a` files (debug info stripped), linker scripts, `flags/*.txt` |
| `bootloader.bin`, `partition-table.bin` | `build-sysroot.sh` | prebuilt from `sysroot-project/` |
| `manifest.json` | `build-all.sh` | version and URLs; the version is the browser cache key |

## Build

Natively on macOS or Linux, with cmake, ninja, git and Python 3 installed:

```sh
toolchain/setup-idf.sh   # ESP-IDF v6.0.3 + esp-clang + wasi-sdk 34 → toolchain/out/
                         # (build-sysroot.sh runs fetch-arduino.sh itself)
toolchain/build-all.sh   # ~1 h, mostly LLVM; writes public/toolchain/
```

Everything goes under `toolchain/out/` (gitignored, about 10 GB).

**Resource limits.** An unbounded LLVM build crashed a 16 GB Mac once. The scripts
default to `JOBS=3` (LLVM) / `JOBS=4` (IDF), run at low priority, and wrap the LLVM and
binutils builds in `scripts/mem-guard.sh`. That script stops the build when free memory
falls below 15% or swap grows by more than 4 GB during the build (`MIN_FREE_PCT`,
`MAX_SWAP_GROWTH_MB`). The builds are
incremental, so re-running continues where they stopped.

## Verify

```sh
# Full browser pipeline (browser_wasi_shim, in-memory FS) under Node:
ln -sfn ../stage/sysroot toolchain/out/stage-wasm/sysroot
node toolchain/scripts/test-pipeline-shim.mjs toolchain/out/stage-wasm examples/blink/main.c /tmp/app.elf
```

Checked so far:
- The wasm ld links IDF's app ELF **byte-identically** to the native GNU ld.
- `src/image/esp-image.ts` produces images **byte-identical** to `esptool elf2image`.
- blink built in Chrome matches native `idf.py build` except the build time in
  `esp_app_desc_t` (and the hashes that depend on it).

Node's built-in `node:wasi` segfaults on large ld runs. Use the shim-based test
(`test-pipeline-shim.mjs`), which is also what the browser runs.

## How the pieces fit

- **LLVM**: YoWASP's recipe, with its WASI portability patch rebased onto the Espressif
  fork (`patches/llvm-wasi-posix.patch`), plus guards for wasi-sdk 34, which only
  allows `signal.h` and `sys/resource.h` when emulation is enabled.
- **ESP-IDF with clang** (`patches/esp-idf.patch`, applied by `setup-idf.sh`): IDF is
  written for GCC. In the RMT driver, clang split the 32-bit end-of-frame write into
  RMT memory into two 16-bit stores. RMT memory only takes whole words, so
  transmissions never ended (NeoPixel `show()` hung). The patch makes it one volatile
  32-bit write. Other drivers that write peripheral memory through plain pointers
  could have the same issue; check with `llvm-objdump` for `s8i`/`s16i` if a
  peripheral misbehaves only in clang builds.
- **GNU ld instead of lld**: lld lays out IDF's linker scripts differently and IDF's
  own checks reject the result. Espressif pairs esp-clang with GNU ld too.
- **binutils on WASI**: `wasi-compat/` stubs the process functions wasi-libc lacks
  (never reached when linking) and replaces `setjmp.h`. ld runs without `--cref`,
  which overflows the stack.
- **Arduino**: `fetch-arduino.sh` clones arduino-esp32 (as an ESP-IDF component) and
  the libraries in `arduino-libraries.txt`, and generates a component per library.
  Dependencies between libraries come from `library.properties`/`library.json`. The
  template project (`sysroot-project/`) builds them all with esp-clang.
  - `components/esp_wasm` holds the glue: weak `setup()`/`loop()` (so ESP-IDF programs
    link too), `HWCDCSerial` (so `Serial` can be the native USB port per sketch), and
    Kconfig switches the core forgot to declare.
  - Clang workarounds: `-Wno-error` for the core (GCC-only code), `-Wno-c++11-narrowing`
    for libraries and sketches, and `-rtlib=libgcc --unwindlib=none` so C++ exceptions
    get an unwinder. FastLED has a patch (`patches/arduino-libs/FastLED.patch`) for an
    Xtensa backend crash on the constant 32512 (`ADDMI`'s maximum).
  - The user's objects go first on the link line, so an ESP-IDF program's `app_main`
    wins over the Arduino core's.
- **Sysroot**: `scripts/collect_sysroot.py` reads the template build's
  `compile_commands.json` and the expanded link line (`clang -###`). It maps host paths
  to `/sysroot/{idf,build,clang,project}`, and passes clang's system include path
  explicitly (`-nostdinc -isystem …`), since a wasm clang can't find its install dir.

## Flag files (`sysroot/flags/`)

One argument per line. `#` starts a comment.

- `common.txt`: shared C/C++ flags (target, `-mcpu=esp32s3`, defines, `-I/sysroot/...`)
- `c.txt` / `cxx.txt`: language-specific flags, including the system include path
- `link.txt`: raw GNU ld arguments. `@OBJECTS@` expands to the user's objects, and
  `@OUTPUT@` is replaced by the output ELF path.
