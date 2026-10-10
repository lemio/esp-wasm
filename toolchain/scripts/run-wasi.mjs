#!/usr/bin/env node
// Run llvm.wasm (or any WASI command) under Node, for testing outside the browser.
//   node scripts/run-wasi.mjs <file.wasm> <argv0> [args…]
// The current directory is mounted at "/" (paths are relative to it).
import { readFile } from "node:fs/promises";
import { WASI } from "node:wasi";

const [wasmPath, ...argv] = process.argv.slice(2);
const wasi = new WASI({ version: "preview1", args: argv, env: { PWD: "/" }, preopens: { "/": process.cwd() } });
const module = await WebAssembly.compile(await readFile(wasmPath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
