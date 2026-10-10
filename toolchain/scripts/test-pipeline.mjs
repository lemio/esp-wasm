#!/usr/bin/env node
// Run the browser build pipeline (compile → link) under Node's WASI, using the
// same wasm binaries and sysroot flag files the web app uses.
//   node scripts/test-pipeline.mjs <toolchain-dir> <source.c> <out-dir>
// <toolchain-dir> holds llvm.wasm, ld.wasm and an unpacked sysroot/.
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { WASI } from "node:wasi";

const [tcDir, source, outDir] = process.argv.slice(2).map((p) => resolve(p));
await rm(outDir, { recursive: true, force: true });
await mkdir(`${outDir}/src`, { recursive: true });
await mkdir(`${outDir}/build`, { recursive: true });
await import("node:fs/promises").then((fs) => fs.copyFile(source, `${outDir}/src/${basename(source)}`));

const preopens = { "/sysroot": `${tcDir}/sysroot`, "/src": `${outDir}/src`, "/build": `${outDir}/build` };
const args = async (name) =>
  (await readFile(`${tcDir}/sysroot/flags/${name}`, "utf8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

async function run(wasm, argv) {
  const wasi = new WASI({ version: "preview1", args: argv, env: {}, preopens, returnOnExit: true });
  const mod = await WebAssembly.compile(await readFile(`${tcDir}/${wasm}`));
  const t = performance.now();
  const code = wasi.start(await WebAssembly.instantiate(mod, wasi.getImportObject()));
  console.error(`${argv[0]} exit ${code} in ${((performance.now() - t) / 1000).toFixed(2)}s`);
  if (code !== 0) process.exit(code);
}

const name = basename(source);
const obj = `/build/${name}.o`;
await run("llvm.wasm", ["clang", ...(await args("common.txt")), ...(await args("c.txt")), "-c", `/src/${name}`, "-o", obj]);
const link = (await args("link.txt")).flatMap((a) => (a === "@OBJECTS@" ? [obj] : [a.replace("@OUTPUT@", "/build/app.elf")]));
await run("ld.wasm", ["ld", ...link]);
