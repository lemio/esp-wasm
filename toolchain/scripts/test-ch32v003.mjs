#!/usr/bin/env node
// Build every CH32V003 example with the browser's build function (src/compiler/ch32v003.ts)
// under Node, using llvm.wasm and sysroot-ch32v003.tar.gz, and record the result in each
// example's "status" field: { ok, stage?, error? }.
// The app's sources use TypeScript that Node can't run as is, so bundle first:
//   npx rolldown toolchain/scripts/test-ch32v003.mjs --platform node -o toolchain/out/test-ch32v003.mjs
//   node toolchain/out/test-ch32v003.mjs <toolchain-dir> [name-filter]
// <toolchain-dir> holds llvm.wasm, sysroot-ch32v003.tar.gz and examples-ch32v003.json.
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { buildCh32v003 } from "../../src/compiler/ch32v003";
import { untar } from "../../src/compiler/tar";
import { Vfs } from "../../src/compiler/vfs";

const [dir, filter = ""] = process.argv.slice(2);
const clang = await WebAssembly.compile(await readFile(`${dir}/llvm.wasm`));
const files = untar(gunzipSync(await readFile(`${dir}/sysroot-ch32v003.tar.gz`)));
const tc = { manifest: { version: "test", tools: { clang: { argv0: "clang" } } }, clang, vfs: new Vfs(files) };
const jsonPath = `${dir}/examples-ch32v003.json`;
const doc = JSON.parse(await readFile(jsonPath, "utf8"));

let ok = 0, failed = 0;
for (const ex of doc.examples) {
  if (filter && !ex.path.includes(filter)) continue;
  try {
    const r = await buildCh32v003(tc, ex.files, () => {});
    ex.status = { ok: true };
    ok++;
    console.log(`ok   ${ex.path} (${r.parts[0].data.length} bytes)`);
  } catch (e) {
    const first = (e.output ?? "").split("\n").find((l) => /error/.test(l)) ?? "";
    ex.status = { ok: false, stage: /Link/.test(e.message) ? "link" : "compile", error: `${e.message}${first ? `: ${first}` : ""}`.slice(0, 300) };
    failed++;
    console.log(`FAIL ${ex.path}: ${ex.status.error}`);
  }
}
if (!filter) await writeFile(jsonPath, JSON.stringify(doc));
console.log(`${ok} built, ${failed} failed`);
