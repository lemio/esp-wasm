#!/usr/bin/env node
// Check a Trace build: compile a sketch with line tracing plus src/debug/trace-runtime.cpp, and link.
//   node --experimental-strip-types --no-warnings toolchain/scripts/test-trace.mjs <toolchain-dir> <sketch.ino> src/debug/trace-runtime.cpp <out.elf>
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";
import { addPrototypes } from "../../src/compiler/prototypes.ts";
import { addStatementHooks } from "../../src/debug/statement-hooks.ts";
const [tc, sketchPath, runtimePath, outElf] = process.argv.slice(2);
async function load(dir) { const m = new Map(); for (const n of await readdir(dir)) { const p = join(dir, n); m.set(n, (await stat(p)).isDirectory() ? new Directory(await load(p)) : new File(await readFile(p), { readonly: true })); } return m; }
const flags = async (n) => (await readFile(`${tc}/sysroot/flags/${n}`, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const root = new Map([["sysroot", new Directory(await load(`${tc}/sysroot`))], ["src", new Directory(new Map())], ["build", new Directory(new Map())], ["tmp", new Directory(new Map())]]);
root.get("src").contents.set("sketch.ino", new File(new TextEncoder().encode(addStatementHooks(addPrototypes(await readFile(sketchPath, "utf8"), "/src/sketch.ino"), "/src/sketch.ino", false))));
root.get("src").contents.set("trace.cpp", new File(await readFile(runtimePath)));
const clang = await WebAssembly.compile(await readFile(`${tc}/llvm.wasm`)), ld = await WebAssembly.compile(await readFile(`${tc}/ld.wasm`));
function run(m, argv) { const out = []; const wasi = new WASI(argv, ["PWD=/"], [new OpenFile(new File([])), ConsoleStdout.lineBuffered((l) => out.push(l)), ConsoleStdout.lineBuffered((l) => out.push(l)), new PreopenDirectory("/", root)], { debug: false }); let c; try { c = wasi.start(new WebAssembly.Instance(m, { wasi_snapshot_preview1: wasi.wasiImport })); } catch (e) { if (e instanceof WASIProcExit) c = e.code; else throw e; } return { c, out }; }
const common = await flags("common.txt"), cxx = [...await flags("cxx.txt"), "-Wno-c++11-narrowing"];
const TRACE = ["-fsanitize-coverage=trace-pc", "-Og", "-gdwarf-4", "-gline-tables-only"];
let r = run(clang, ["clang", ...common, ...cxx, "-x", "c++", "-include", "Arduino.h", ...TRACE, "-DARDUINO_USB_CDC_ON_BOOT=0", "-c", "/src/sketch.ino", "-o", "/build/sketch.o"]);
console.log("sketch compile", r.c, r.out.filter((l) => /error/.test(l)).slice(0, 3).join(" | "));
r = run(clang, ["clang", ...common, ...cxx, "-DESP_WASM_ARDUINO=1", "-DARDUINO_USB_CDC_ON_BOOT=0", "-c", "/src/trace.cpp", "-o", "/build/trace.o"]);
console.log("runtime compile", r.c, r.out.filter((l) => /error/.test(l)).slice(0, 3).join(" | "));
const link = (await flags("link.txt")).flatMap((a) => (a === "@OBJECTS@" ? ["/build/sketch.o", "/build/trace.o"] : [a.replace("@OUTPUT@", "/build/app.elf")]));
r = run(ld, ["ld", ...link]);
console.log("link", r.c, r.out.filter((l) => /error|undefined|orphan/.test(l)).slice(0, 3).join(" | "));
if (r.c === 0) await writeFile(outElf, root.get("build").contents.get("app.elf").data);
