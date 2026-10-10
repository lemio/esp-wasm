#!/usr/bin/env node
// Same as test-pipeline.mjs, but through @bjorn3/browser_wasi_shim with an
// in-memory FS: the exact runtime the browser uses.
//   [DEFINES="A=1 B"] node toolchain/scripts/test-pipeline-shim.mjs <toolchain-dir> <source.c|.cpp|.ino> <out.elf>
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";

const [tcDir, source, outElf] = process.argv.slice(2).map((p) => resolve(p));

async function load(dir) {
  const m = new Map();
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    m.set(name, (await stat(p)).isDirectory() ? new Directory(await load(p)) : new File(await readFile(p), { readonly: true }));
  }
  return m;
}
let t = performance.now();
const root = new Map([
  ["sysroot", new Directory(await load(`${tcDir}/sysroot`))],
  ["src", new Directory(new Map([[basename(source), new File(await readFile(source))]]))],
  ["build", new Directory(new Map())],
  ["tmp", new Directory(new Map())],
]);
console.error(`loaded sysroot in ${((performance.now() - t) / 1000).toFixed(2)}s`);

const flags = async (n) => (await readFile(`${tcDir}/sysroot/flags/${n}`, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
async function run(wasm, argv) {
  const out = [];
  const fds = [new OpenFile(new File([])), ConsoleStdout.lineBuffered((l) => out.push(l)), ConsoleStdout.lineBuffered((l) => out.push(l)), new PreopenDirectory("/", root)];
  const wasi = new WASI(argv, ["PWD=/"], fds, { debug: false });
  const inst = await WebAssembly.instantiate(await WebAssembly.compile(await readFile(`${tcDir}/${wasm}`)), { wasi_snapshot_preview1: wasi.wasiImport });
  t = performance.now();
  let code;
  try { code = wasi.start(inst); } catch (e) { if (e instanceof WASIProcExit) code = e.code; else { console.error(out.join("\n")); throw e; } }
  console.error(`${argv[0]} exit ${code} in ${((performance.now() - t) / 1000).toFixed(2)}s`);
  if (out.length) console.error(out.slice(0, 30).join("\n"));
  if (code !== 0) process.exit(1);
}
const name = basename(source);
// Same language handling as src/compiler/pipeline.ts.
const ext = name.split(".").pop();
const cxx = [...(await flags("cxx.txt")), "-Wno-c++11-narrowing"];
const lang = ext === "c" ? await flags("c.txt")
  : ext === "ino" ? [...cxx, "-x", "c++", "-include", "Arduino.h"]
  : cxx;
const defines = (process.env.DEFINES ?? "").split(" ").filter(Boolean).map((d) => `-D${d}`);
await run("llvm.wasm", ["clang", ...(await flags("common.txt")), ...lang, ...defines, "-c", `/src/${name}`, "-o", `/build/${name}.o`]);
const link = (await flags("link.txt")).flatMap((a) => (a === "@OBJECTS@" ? [`/build/${name}.o`] : [a.replace("@OUTPUT@", "/build/app.elf")]));
await run("ld.wasm", ["ld", ...link]);
await writeFile(outElf, root.get("build").contents.get("app.elf").data);
console.error(`wrote ${outElf}`);
