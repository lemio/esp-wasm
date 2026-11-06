/**
 * Builds for the WCH CH32V003 (RISC-V rv32ec, 16 KB flash, 2 KB RAM) with ch32fun:
 * clang compiles the program and ch32fun.c (its startup code and helpers), ld.lld
 * links them with ch32fun's linker script, and the ELF becomes a flat image
 * (app.bin, plus app.hex) that starts at flash address 0.
 * The sysroot comes from toolchain/build-ch32v003.sh.
 */
import { buildLineTable } from "../debug/line-table";
import { PT_LOAD, parseElf } from "../image/elf";
import { BuildError, parseDiagnostics } from "./diagnostics";
import type { Toolchain } from "./toolchain";
import type { BuildOptions, BuildResult, Diagnostic, LogLevel, SourceFile } from "./types";
import { runWasi } from "./wasi-runner";

export const CH32V003_FLASH_SIZE = 16 * 1024;

/** ch32fun.c includes the program's funconfig.h; this is the one used when there's none. */
const DEFAULT_FUNCONFIG = `#ifndef _FUNCONFIG_H
#define _FUNCONFIG_H
// ch32fun configuration (see ch32fun.h for the options).
#endif
`;

type Log = (text: string, level?: LogLevel) => void;

function readArgs(tc: Toolchain, name: string): string[] {
  const text = new TextDecoder().decode(tc.vfs.readFile(`sysroot/flags/${name}`) ?? new Uint8Array());
  return text.split("\n").filter((l) => l.length > 0);
}

/** The loadable bytes of a linked CH32V003 program, as one image from flash address 0. */
export function flatImage(elf: Uint8Array): Uint8Array {
  // Load addresses (paddr): .data's initial values sit in flash after the code.
  const segs = parseElf(elf).segments.filter((s) => s.type === PT_LOAD && s.filesz > 0 && s.paddr < CH32V003_FLASH_SIZE);
  const end = Math.max(0, ...segs.map((s) => s.paddr + s.filesz));
  if (end > CH32V003_FLASH_SIZE) throw new BuildError(`The program is ${end} bytes; the CH32V003 has ${CH32V003_FLASH_SIZE}.`);
  const image = new Uint8Array(end);
  for (const s of segs) image.set(s.data, s.paddr);
  return image;
}

/** Intel HEX of an image at `base` (what WCH-LinkUtility and most programmers accept). */
export function intelHex(image: Uint8Array, base = 0): string {
  const hex = (n: number, w = 2) => n.toString(16).toUpperCase().padStart(w, "0");
  const record = (type: number, addr: number, data: ArrayLike<number>) => {
    const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...Array.from(data)];
    const sum = (0x100 - (bytes.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;
    return `:${bytes.map((b) => hex(b)).join("")}${hex(sum)}`;
  };
  const lines: string[] = [];
  let upper = -1;
  for (let off = 0; off < image.length; off += 16) {
    const addr = base + off;
    if (addr >>> 16 !== upper) {
      upper = addr >>> 16;
      lines.push(record(4, 0, [(upper >> 8) & 0xff, upper & 0xff]));
    }
    lines.push(record(0, addr & 0xffff, image.subarray(off, off + 16)));
  }
  lines.push(":00000001FF");
  return `${lines.join("\n")}\n`;
}

export async function buildCh32v003(
  tc: Toolchain,
  userSources: SourceFile[],
  log: Log,
  _options: BuildOptions = {},
): Promise<BuildResult> {
  const start = performance.now();
  const { vfs } = tc;
  vfs.resetDir("src");
  vfs.resetDir("build");
  const sources = userSources.some((s) => s.path === "funconfig.h")
    ? userSources
    : [...userSources, { path: "funconfig.h", content: DEFAULT_FUNCONFIG }];
  for (const s of sources) vfs.writeFile(`src/${s.path}`, s.content);

  const common = readArgs(tc, "common.txt");
  const diagnostics: Diagnostic[] = [];
  const objects: string[] = [];
  const units = [
    ...sources.filter((s) => /\.(c|cpp|cc|cxx|S)$/.test(s.path)).map((s) => `/src/${s.path}`),
    "/sysroot/ch32fun/ch32fun.c",
  ];
  const isCxx = sources.some((s) => /\.(cpp|cc|cxx)$/.test(s.path));
  for (const [i, path] of units.entries()) {
    const ext = path.split(".").pop()!;
    const cxx = ["cpp", "cc", "cxx"].includes(ext);
    // ch32fun.c calls the C++ constructors (__libc_init_array) when the program has C++ code.
    const lang = cxx ? readArgs(tc, "cxx.txt") : readArgs(tc, "c.txt").concat(isCxx && path.endsWith("ch32fun.c") ? ["-DCPLUSPLUS=1"] : []);
    if (path.startsWith("/src/")) log(`CC ${path.slice(5)}`, "muted");
    const obj = `/build/${i}.o`;
    const res = await runWasi(tc.clang, [
      tc.manifest.tools.clang.argv0,
      ...common,
      ...(ext === "S" ? [] : lang),
      "-fno-color-diagnostics",
      "-c", path,
      "-o", obj,
    ], vfs);
    diagnostics.push(...parseDiagnostics(res.stderr));
    if (res.exitCode !== 0) throw new BuildError(`Compilation of ${path.replace("/src/", "")} failed`, diagnostics, res.stderr);
    if (res.stderr && path.startsWith("/src/")) log(res.stderr, "info");
    objects.push(obj);
  }

  const elfPath = "/build/app.elf";
  const linkArgs = readArgs(tc, "link.txt").flatMap((a) => (a === "@OBJECTS@" ? objects : [a.replace("@OUTPUT@", elfPath)]));
  log("LD app.elf", "muted");
  const ld = await runWasi(tc.clang, ["ld.lld", ...linkArgs], vfs);
  if (ld.stderr) log(ld.stderr, ld.exitCode ? "error" : "info");
  if (ld.exitCode !== 0) throw new BuildError("Linking failed", diagnostics, ld.stderr);

  const elf = vfs.readFile(elfPath);
  if (!elf) throw new BuildError("Linker produced no output");
  const app = flatImage(elf);
  log(`Flash: ${app.length} of ${CH32V003_FLASH_SIZE} bytes (${Math.round((app.length / CH32V003_FLASH_SIZE) * 100)}%)`, "muted");
  const lineTable = buildLineTable(parseElf(elf).sections, elf, (f) => f.startsWith("/src/"));
  return {
    parts: [
      { name: "app.bin", address: 0, data: app },
      { name: "app.hex", address: 0, data: new TextEncoder().encode(intelHex(app)) },
    ],
    diagnostics,
    lineTable,
    elfSize: elf.length,
    elf: elf.slice(),
    durationMs: performance.now() - start,
    instrumented: false,
  };
}
