/**
 * The program as built: its code (from the ELF's executable sections), every function's name and
 * range (from the symbol table), and how app.bin, the file written to flash, is laid out, so
 * an address can be found in the file. For the inspector's Program view.
 *
 * app.bin is an ESP image (ESP-IDF's "App image format"): a 24-byte header (magic 0xE9, the
 * number of segments, flash settings), then each segment as [load address, length, bytes].
 * Code and constants in flash are mapped by the cache's MMU straight from these bytes, which is
 * why a flash address of the CPU corresponds to one place in the file.
 */
import { parseElf } from "../../image/elf";
import { demangle } from "../line-table";

export interface Func {
  addr: number;
  size: number;
  name: string;
}

export interface Segment {
  /** Where it's loaded (or mapped) on the chip. */
  load: number;
  length: number;
  /** Where its bytes start in app.bin. */
  fileOffset: number;
}

export interface Program {
  /** Executable sections: name, address range and bytes. */
  code: { name: string; addr: number; size: number; data: Uint8Array }[];
  /** Initialized data sections, for L32R constants. */
  data: { name: string; addr: number; size: number; data: Uint8Array }[];
  funcs: Func[];
  segments: Segment[];
  appSize: number;
  /** Where app.bin is written in flash. */
  flashOffset: number;
}

const SHF_EXECINSTR = 0x4, SHF_ALLOC = 0x2, SHT_SYMTAB = 2, SHT_NOBITS = 8, STT_FUNC = 2;

export function loadProgram(elfBytes: Uint8Array, app?: { data: Uint8Array; address: number }): Program {
  const elf = parseElf(elfBytes);
  const alloc = elf.sections.filter((s) => s.flags & SHF_ALLOC && s.type !== SHT_NOBITS && s.size && s.addr);
  const code = alloc.filter((s) => s.flags & SHF_EXECINSTR).map((s) => ({ name: s.name, addr: s.addr, size: s.size, data: s.data }));
  const data = alloc.filter((s) => !(s.flags & SHF_EXECINSTR)).map((s) => ({ name: s.name, addr: s.addr, size: s.size, data: s.data }));

  const funcs: Func[] = [];
  const symtab = elf.sections.find((s) => s.type === SHT_SYMTAB);
  const strtab = symtab && elf.sections[symtab.link];
  if (symtab && strtab) {
    const dv = new DataView(symtab.data.buffer, symtab.data.byteOffset, symtab.data.byteLength);
    const dec = new TextDecoder();
    for (let o = 0; o + 16 <= symtab.data.length; o += 16) {
      const value = dv.getUint32(o + 4, true), size = dv.getUint32(o + 8, true), info = dv.getUint8(o + 12);
      if ((info & 0xf) !== STT_FUNC || !value || !size) continue;
      let end = dv.getUint32(o, true);
      const start = end;
      while (strtab.data[end]) end++;
      funcs.push({ addr: value, size, name: demangle(dec.decode(strtab.data.subarray(start, end))) });
    }
  }
  funcs.sort((x, y) => x.addr - y.addr);

  const segments: Segment[] = [];
  if (app && app.data[0] === 0xe9) {
    const dv = new DataView(app.data.buffer, app.data.byteOffset, app.data.byteLength);
    let at = 24;
    for (let i = 0; i < app.data[1] && at + 8 <= app.data.length; i++) {
      const load = dv.getUint32(at, true), length = dv.getUint32(at + 4, true);
      segments.push({ load, length, fileOffset: at + 8 });
      at += 8 + length;
    }
  }
  return { code, data, funcs, segments, appSize: app?.data.length ?? 0, flashOffset: app?.address ?? 0x10000 };
}

/** The function an address is in. */
export function funcAt(p: Program, addr: number): Func | undefined {
  let lo = 0, hi = p.funcs.length - 1, best: Func | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.funcs[mid].addr <= addr) {
      best = p.funcs[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best && addr < best.addr + best.size ? best : undefined;
}

/** Where an address of the chip is in app.bin, if it's part of the file. */
export function fileOffsetOf(p: Program, addr: number): { segment: number; offset: number } | undefined {
  const i = p.segments.findIndex((s) => addr >= s.load && addr < s.load + s.length);
  return i < 0 ? undefined : { segment: i, offset: p.segments[i].fileOffset + (addr - p.segments[i].load) };
}

/** A 32-bit word of the program's initialized contents, if the address is in it. */
export function wordAt(p: Program, addr: number): number | undefined {
  for (const s of [...p.data, ...p.code]) {
    if (addr >= s.addr && addr + 4 <= s.addr + s.size) {
      const o = addr - s.addr;
      return (s.data[o] | (s.data[o + 1] << 8) | (s.data[o + 2] << 16) | (s.data[o + 3] << 24)) >>> 0;
    }
  }
  return undefined;
}

/** The code section an address is in. */
export const codeAt = (p: Program, addr: number) => p.code.find((s) => addr >= s.addr && addr < s.addr + s.size);
