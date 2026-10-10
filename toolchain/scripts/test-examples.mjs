#!/usr/bin/env node --experimental-strip-types --no-warnings
// Build every example in examples.json the way the browser does (same flags,
// prototypes and extra files), through browser_wasi_shim, and record the result
// in each example's "status" field: { ok, stage?, error? }.
//
//   node --experimental-strip-types --no-warnings toolchain/scripts/test-examples.mjs \
//        <toolchain-dir> <examples.json> [filter]
//
// <toolchain-dir> holds llvm.wasm, ld.wasm and an unpacked sysroot/. One example
// at a time, single-threaded; ~1 hour for all of them.
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";
import { addPrototypes } from "../../src/compiler/prototypes.ts";
import { addStatementHooks } from "../../src/debug/statement-hooks.ts";

// TRACE=1: build as the browser's Trace builds do (statement hooks, coverage
// flags, debug runtime), to check that instrumentation doesn't break examples.
// Results go to "traceStatus" instead of "status"; only examples that build normally are tried.
const TRACE = process.env.TRACE === "1";
const TRACE_FLAGS = ["-fsanitize-coverage=trace-pc", "-Og", "-gdwarf-4", "-gline-tables-only"];
const traceRuntime = TRACE ? await readFile(new URL("../../src/debug/trace-runtime.cpp", import.meta.url), "utf8") : "";

const [tcDir, examplesPath, filter = ""] = process.argv.slice(2).map((p, i) => (i < 2 ? resolve(p) : p));

async function load(dir) {
  const m = new Map();
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    m.set(name, (await stat(p)).isDirectory() ? new Directory(await load(p)) : new File(await readFile(p), { readonly: true }));
  }
  return m;
}
const sysroot = new Directory(await load(`${tcDir}/sysroot`));
const flags = async (n) =>
  (await readFile(`${tcDir}/sysroot/flags/${n}`, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const [common, cxxBase, link] = await Promise.all([flags("common.txt"), flags("cxx.txt"), flags("link.txt")]);
const cxx = [...cxxBase, "-Wno-c++11-narrowing"];
const clang = await WebAssembly.compile(await readFile(`${tcDir}/llvm.wasm`));
const ld = await WebAssembly.compile(await readFile(`${tcDir}/ld.wasm`));

function run(module, argv, root) {
  const out = [];
  const fds = [new OpenFile(new File([])), ConsoleStdout.lineBuffered((l) => out.push(l)),
    ConsoleStdout.lineBuffered((l) => out.push(l)), new PreopenDirectory("/", root)];
  const wasi = new WASI(argv, ["PWD=/"], fds, { debug: false });
  const inst = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi.wasiImport });
  let code;
  try { code = wasi.start(inst); } catch (e) { if (e instanceof WASIProcExit) code = e.code; else throw e; }
  return { code, out };
}

const firstError = (lines) =>
  (lines.find((l) => /error:|undefined reference|multiple definition/.test(l)) ?? lines.at(-1) ?? "").slice(0, 300);

const data = JSON.parse(await readFile(examplesPath, "utf8"));
const todo = data.examples.filter((e) => e.id.includes(filter) && (!TRACE || e.status?.ok));
let ok = 0;
const t0 = Date.now();
for (const [n, ex] of todo.entries()) {
  const root = new Map([["sysroot", sysroot], ["src", new Directory(new Map())], ["build", new Directory(new Map())], ["tmp", new Directory(new Map())]]);
  const srcDir = root.get("src");
  const files = TRACE ? [...ex.files, { path: "__esp_wasm_trace.cpp", content: traceRuntime, runtime: true }] : ex.files;
  for (const f of files) {
    let content = f.path.endsWith(".ino") ? addPrototypes(f.content, `/src/${f.path}`) : f.content;
    if (TRACE && !f.runtime && /\.(ino|cpp|c)$/.test(f.path)) content = addStatementHooks(content, `/src/${f.path}`, f.path.endsWith(".c"));
    const parts = f.path.split("/");
    let dir = srcDir;
    for (const p of parts.slice(0, -1)) {
      if (!dir.contents.has(p)) dir.contents.set(p, new Directory(new Map()));
      dir = dir.contents.get(p);
    }
    dir.contents.set(parts.at(-1), new File(new TextEncoder().encode(content)));
  }
  const objects = [];
  let status = { ok: true };
  for (const f of files) {
    const ext = f.path.split(".").pop();
    if (!["ino", "cpp", "c"].includes(ext)) continue;
    const lang = ext === "c" ? await flags("c.txt") : ext === "ino" ? [...cxx, "-x", "c++", "-include", "Arduino.h"] : cxx;
    const obj = `/build/${f.path.replaceAll("/", "__")}.o`;
    const extra = !TRACE ? [] : f.runtime ? ["-DESP_WASM_ARDUINO=1"] : TRACE_FLAGS;
    const r = run(clang, ["clang", ...common, ...lang, "-DARDUINO_USB_CDC_ON_BOOT=0", ...extra, "-fno-color-diagnostics", "-c", `/src/${f.path}`, "-o", obj], root);
    if (r.code !== 0) { status = { ok: false, stage: "compile", error: firstError(r.out) }; break; }
    objects.push(obj);
  }
  if (status.ok) {
    const args = link.flatMap((a) => (a === "@OBJECTS@" ? objects : [a.replace("@OUTPUT@", "/build/app.elf")]));
    const r = run(ld, ["ld", ...args], root);
    if (r.code !== 0) status = { ok: false, stage: "link", error: firstError(r.out) };
  }
  if (TRACE) ex.traceStatus = status; else ex.status = status;
  if (status.ok) ok++;
  const eta = ((Date.now() - t0) / (n + 1)) * (todo.length - n - 1) / 60000;
  console.log(`[${n + 1}/${todo.length}] ${status.ok ? "ok  " : "FAIL"} ${ex.id}${status.ok ? "" : `  (${status.stage}) ${status.error}`}  eta ${eta.toFixed(0)}m`);
  if ((n + 1) % 20 === 0) await writeFile(examplesPath, JSON.stringify(data)); // keep progress
}
await writeFile(examplesPath, JSON.stringify(data));
console.log(`DONE ${ok}/${todo.length} build`);
