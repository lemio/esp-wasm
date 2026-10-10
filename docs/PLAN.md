# esp-wasm — Plan

A fully client-side (static hosting, no backend) IDE that compiles C/C++ for the
**ESP32-S3** in the browser and flashes it over USB serial.

```
┌──────────────── Browser (main thread) ────────────────┐      ┌──────── Web Worker ────────┐
│ Monaco editor ──► "Build" ────────────────────────────┼─────►│ WASI runtime (wasi shim)   │
│                                                       │      │  ├─ llvm.wasm   (C/C++→.o) │
│ Console / diagnostics ◄───────────────────────────────┼──────┤  ├─ ld.wasm     (.o→.elf)  │
│                                                       │      │  └─ in-memory FS + sysroot │
│ elf2image (TS) ─► app.bin                             │◄─────┤ app.elf                    │
│ esptool-js + Web Serial ─► ESP32-S3 (USB-Serial/JTAG) │      └────────────────────────────┘
└───────────────────────────────────────────────────────┘
         ▲ static assets: llvm.wasm (clang), ld.wasm, sysroot.tar.gz, bootloader.bin, partition-table.bin
         └─ cached in the browser (Cache API) after the first download
```

## 1. The key idea

Compiling *all* of ESP-IDF in the browser on every build would be far too slow and
heavy. Instead we:

1. **Precompile ESP-IDF offline** (one fixed `sdkconfig` for the ESP32-S3) into a
   *sysroot*: headers, every component's `.a` archive, the generated linker scripts,
   newlib/libgcc, and the exact compile and link flags IDF used.
2. Also ship the **prebuilt `bootloader.bin` and `partition-table.bin`** from that same
   build. They never change per user program.
3. In the browser we only **compile the user's sources** and **link** them against
   the sysroot. That's the same thing IDF does when it rebuilds after editing `main.c`.
4. Convert the ELF to an ESP app image with a **TypeScript port of `esptool elf2image`**.
5. Flash bootloader, partition table and app with **esptool-js** over **Web Serial**.

## 2. Components and technology choices

| Concern | Choice | Notes |
|---|---|---|
| Editor | `monaco-editor` (ESM, bundled by Vite) | Compiler diagnostics become Monaco markers. Later: clangd-wasm for IntelliSense. |
| Build system for the web app | Vite + TypeScript | Static output, deployable to any static host. |
| Compiler | **Clang from `espressif/llvm-project`**, built for `wasm32-wasi` | Upstream LLVM's Xtensa backend is still experimental. Espressif's fork supports `-mcpu=esp32s3` and has the integrated Xtensa assembler, so we don't need a separate `as`. |
| Linker | **GNU `ld` from `espressif/binutils-gdb`** (2.45), built for WASI with the esp32s3 overlay | **Decided.** lld lays out IDF's linker scripts differently and IDF's own checks reject the result ("IRAM0 segment data does not fit"). Espressif also pairs esp-clang with GNU ld. The wasm ld links byte-identical ELFs to the native one. |
| WASI runtime in the browser | `@bjorn3/browser_wasi_shim` | Synchronous in-memory FS, runs inside a Web Worker. |
| Sysroot transport | `sysroot.tar.gz`, unpacked in JS with the native `DecompressionStream` | No extra decompression dependency. |
| Asset caching | Cache API (optionally OPFS later) | Toolchain and sysroot will be tens of MB; download them once per version. |
| ELF → image | Own TS implementation (`src/image/`) | Port of `esptool elf2image` for ESP32-S3: 64 KiB MMU alignment for IROM/DROM, checksum, SHA-256. |
| Flashing | `esptool-js` (Espressif) + Web Serial API | Works with the S3's native USB-Serial/JTAG (VID 0x303A) and UART bridges. Chrome/Edge only, HTTPS or localhost. |
| Serial monitor | Same Web Serial `Transport` after flashing | Phase 4. |

### Why WASI rather than Emscripten for the toolchain?
Clang and ld are ordinary "read files, write files, exit" CLI programs. WASI builds
(via `wasi-sdk`) are smaller, need no JS glue, and can be driven by one generic runner.
YoWASP (`@yowasp/clang`) already shows that upstream LLVM builds and runs this way. We
reuse that recipe with Espressif's fork.

Constraints this puts on the toolchain build:
- No `fork`/`exec`: call `clang -c` for each file (the driver runs `-cc1` in-process) and
  call the linker directly, never through `clang` as the link driver.
- No threads: build with `LLVM_ENABLE_THREADS=OFF`.
- `llvm.wasm` is a multicall binary. It still contains lld, which we don't use; dropping
  it would shrink the download.

## 3. Build pipeline in the browser

```
main.c ──clang -c──► main.o ─┐
foo.cpp ─clang -c──► foo.o ──┼─ ld (+ sysroot/lib/*.a, memory.ld, sections.ld, rom *.ld) ─► app.elf
                             ┘
app.elf ──elf2image (TS)──► app.bin
flash: 0x0000 bootloader.bin | 0x8000 partition-table.bin | 0x10000 app.bin
```

- Compile flags come from `sysroot/flags/{common,c,cxx}.txt`, taken from IDF's
  `compile_commands.json` for the template's `main` component (built with
  `IDF_TOOLCHAIN=clang`, so they're already clang flags). They hold the include dirs,
  defines, `-mlongcalls`, `-ffunction-sections` and so on.
- Link arguments come from `sysroot/flags/link.txt`: IDF's `.elf` link command, expanded
  to the raw linker call with `clang -###`, with `libmain.a` replaced by `@OBJECTS@`
  and every host path mirrored under `/sysroot`. `toolchain/scripts/collect_sysroot.py`
  does this.
- The user's code provides `app_main()`. An Arduino layer (`setup()`/`loop()`) comes later.

## 4. Risks and how we reduce them

| Risk | Impact | How we handle it |
|---|---|---|
| ~~lld can't handle IDF's linker scripts~~ | — | **Confirmed, resolved:** GNU ld built for WASI. |
| ~~Binutils Xtensa needs `xtensa-dynconfig`~~ | — | **Resolved:** `--disable-plugins` + the esp32s3 overlay gives a static config. |
| Download size: llvm.wasm 44 MB (15.6 MB gzip), sysroot 12 MB gzip | Slow first load | Cache API (done). Next: drop lld from llvm.wasm, dedupe sysroot multilib dirs, brotli on the host. |
| ~~Clang objects mixed with GCC-built IDF libs~~ | — | **Avoided:** the sysroot is built with `IDF_TOOLCHAIN=clang`. |
| ~~elf2image differs from esptool~~ | — | **Resolved:** byte-identical to `esptool elf2image` (sections, merging, ELF SHA-256 at 0xb0). |
| Building LLVM overloads a laptop | Machine crash (it happened once) | `JOBS=3`, `nice`, and `scripts/mem-guard.sh` stop the build when memory runs low. |
| Web Serial only works in Chromium browsers | Firefox/Safari users can't flash | Detect support and show a clear message. Still allow downloading the `.bin` files. |
| Memory: a large sysroot in the in-memory FS | Tab crashes | Load only headers and libs that are actually referenced. Consider OPFS-backed files later. |

## 5. Phases

**Phase 0 — Scaffold** ✅
- Vite + TS app with Monaco, toolbar and log console.
- Flashing works end to end already: connect, then flash the prebuilt `.bin` files a
  user drops in (to check esptool-js and Web Serial against a real S3).
- Compiler worker, WASI runner, VFS, tar loader and elf2image are in place. They wait
  on toolchain assets.

**Phase 1 — Clang to WASM** ✅
- `toolchain/build-llvm.sh`: build `espressif/llvm-project` (Xtensa only) with
  `wasi-sdk`.
- Done when: in the browser, `hello.c` becomes `hello.o`, and it matches a native
  `clang --target=xtensa-esp-elf -mcpu=esp32s3` build (`llvm-objdump -d` diff).

**Phase 2 — Sysroot and linker** ✅
- `toolchain/build-sysroot.sh`: build the template IDF project in
  `toolchain/sysroot-project/`, then collect headers, `.a` files, linker scripts,
  `flags/*.txt`, `bootloader.bin` and `partition-table.bin`.
- Pick the linker (lld or GNU ld), build it for WASI, and link `blink` in the browser.
- Done when: the ELF produced in the browser has the same section layout as the native one.
- Result: blink built in Chrome gives the same image as native `idf.py build`, except the
  build time stored in the app descriptor (and the hashes that depend on it).

**Phase 3 — Image and flash** (elf2image ✅; flashing on a real board still to verify)
- elf2image is byte-identical to esptool, including the ELF SHA-256 in `esp_app_desc`.
- Done when: `examples/blink` is edited, built and flashed from the browser, and the LED blinks.

**Phase 4 — Developer experience**
- Serial monitor, clang diagnostics as Monaco markers, multi-file projects saved in
  IndexedDB, progress UI for downloads, incremental builds (cache `.o` files by content
  hash), and "Download .bin" for users without Web Serial.

**Phase 5 — Ecosystem**
- ✅ Arduino: arduino-esp32 3.3.12 and 15 popular libraries are precompiled into the same
  sysroot. Sketches (`.ino`) and ESP-IDF programs both build; C++ with exceptions works.
- Next: user-uploaded libraries, Arduino-style prototype generation, several sdkconfig/board presets, clangd-wasm IntelliSense, and a
  `coi-serviceworker` for hosts that can't set COOP/COEP headers.

## 6. Repository layout

```
esp-wasm/
├── docs/PLAN.md                 ← this file
├── index.html                   app shell
├── vite.config.ts               dev server (COOP/COEP headers), worker config
├── src/
│   ├── main.ts                  wires editor, toolbar, compiler, flasher
│   ├── styles.css
│   ├── editor/                  Monaco setup, default sketch
│   ├── compiler/
│   │   ├── compiler.worker.ts   runs the toolchain off the main thread
│   │   ├── client.ts            main-thread proxy for the worker
│   │   ├── pipeline.ts          compile → link → elf2image
│   │   ├── wasi-runner.ts       runs a WASI binary (clang/ld) over the VFS
│   │   ├── vfs.ts               in-memory file tree helpers
│   │   ├── toolchain.ts         fetch and cache the manifest, wasm and sysroot
│   │   ├── tar.ts               minimal ustar reader
│   │   └── types.ts             worker message protocol
│   ├── image/
│   │   ├── elf.ts               ELF32 parser
│   │   ├── esp-image.ts         elf2image for ESP32-S3
│   │   └── flash-layout.ts      offsets for bootloader / partitions / app
│   ├── flasher/flasher.ts       esptool-js + Web Serial wrapper
│   └── ui/console.ts            log panel
├── public/toolchain/            build output of toolchain/ (gitignored, served statically)
├── toolchain/                   offline scripts that produce public/toolchain/
│   ├── setup-idf.sh             fetch ESP-IDF v6.0.3 (+ esp-clang) and wasi-sdk
│   ├── build-all.sh             runs the three below, writes manifest.json
│   ├── build-llvm.sh            clang → llvm.wasm (Espressif LLVM 20, multicall)
│   ├── build-binutils.sh        GNU ld → ld.wasm
│   ├── build-sysroot.sh         template IDF build → sysroot.tar.gz + bootloader/partitions
│   ├── scripts/                 collect_sysroot.py, mem-guard.sh, pipeline tests
│   ├── patches/                 WASI patch for LLVM (from YoWASP, rebased)
│   ├── wasi-compat/             POSIX stubs + setjmp.h so binutils builds for WASI
│   └── sysroot-project/         template ESP-IDF project for the precompiled sysroot
└── examples/blink/main.c
```
