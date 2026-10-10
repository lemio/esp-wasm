/**
 * Address → source line, for Trace builds. Reads the DWARF v4 line program
 * (.debug_line) and the function symbols (.symtab) of the linked ELF. Only the
 * user's sources carry debug info (the sysroot libraries are stripped).
 */
import type { ElfSection } from "../image/elf";

export interface SourceLocation {
  file: string; // as compiled, e.g. "/src/sketch.ino"
  line: number;
  func?: string;
}

/** Plain data, so it can cross from the worker to the page. */
export interface LineTable {
  files: string[];
  /** Sorted rows: address, line, file index (into files); one row per [address, next row's address). */
  rows: number[];
  /** Function ranges: start, end, name index (into names). */
  funcs: number[];
  names: string[];
  /** Data symbols (globals, statics): address, size, name index (into names). Used by the JTAG inspector. */
  objects: number[];
}

class Reader {
  pos: number;
  private readonly dv: DataView;
  constructor(dv: DataView, start: number) {
    this.dv = dv;
    this.pos = start;
  }
  u8() { return this.dv.getUint8(this.pos++); }
  i8() { return this.dv.getInt8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  uleb() {
    let result = 0, shift = 0, b;
    do { b = this.u8(); result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return result;
  }
  sleb() {
    let result = 0, shift = 0, b;
    do { b = this.u8(); result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
    return b & 0x40 ? result - 2 ** shift : result;
  }
  str() {
    let s = "";
    for (let c = this.u8(); c; c = this.u8()) s += String.fromCharCode(c);
    return s;
  }
}

/** Parse .debug_line (DWARF 2–4; Trace builds use -gdwarf-4). */
function parseDebugLine(data: Uint8Array, files: string[], rows: number[][]): void {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let unit = 0;
  while (unit + 4 <= data.length) {
    const r = new Reader(dv, unit);
    const length = r.u32();
    if (length === 0xffffffff) throw new Error("64-bit DWARF isn't supported");
    const end = r.pos + length;
    const version = r.u16();
    if (version < 2 || version > 4) throw new Error(`DWARF ${version} line tables aren't supported (use -gdwarf-4)`);
    const headerLength = r.u32();
    const programStart = r.pos + headerLength;
    const minInst = r.u8();
    if (version >= 4) r.u8(); // maximum_operations_per_instruction
    r.u8(); // default_is_stmt
    const lineBase = r.i8();
    const lineRange = r.u8();
    const opcodeBase = r.u8();
    const opLengths = [0];
    for (let i = 1; i < opcodeBase; i++) opLengths.push(r.u8());
    const dirs = [""];
    for (let d = r.str(); d; d = r.str()) dirs.push(d);
    const unitFiles: number[] = [-1]; // DWARF 4 file numbers start at 1
    const addFile = (name: string, dir: number) => {
      const full = name.startsWith("/") || !dirs[dir] ? name : `${dirs[dir]}/${name}`;
      let idx = files.indexOf(full);
      if (idx < 0) idx = files.push(full) - 1;
      unitFiles.push(idx);
    };
    for (let f = r.str(); f; f = r.str()) {
      const dir = r.uleb(); r.uleb(); r.uleb(); // dir, mtime, length
      addFile(f, dir);
    }

    r.pos = programStart;
    let address = 0, file = 1, line = 1;
    const emit = () => rows.push([address, line, unitFiles[file] ?? -1]);
    while (r.pos < end) {
      const op = r.u8();
      if (op >= opcodeBase) {
        const adj = op - opcodeBase;
        address += Math.floor(adj / lineRange) * minInst;
        line += lineBase + (adj % lineRange);
        emit();
      } else if (op === 0) {
        const len = r.uleb();
        const next = r.pos + len;
        const sub = r.u8();
        if (sub === 1) { // end_sequence: the row ends the previous range
          rows.push([address, 0, -1]);
          address = 0; file = 1; line = 1;
        } else if (sub === 2) {
          address = r.u32();
        } else if (sub === 3) {
          const name = r.str(); const dir = r.uleb(); r.uleb(); r.uleb();
          addFile(name, dir);
        }
        r.pos = next;
      } else if (op === 1) emit(); // copy
      else if (op === 2) address += r.uleb() * minInst; // advance_pc
      else if (op === 3) line += r.sleb(); // advance_line
      else if (op === 4) file = r.uleb(); // set_file
      else if (op === 8) address += Math.floor((255 - opcodeBase) / lineRange) * minInst; // const_add_pc
      else if (op === 9) address += r.u16(); // fixed_advance_pc
      else for (let i = 0; i < opLengths[op]; i++) r.uleb(); // other standard opcodes: skip operands
    }
    unit = end;
  }
}

/** Minimal demangler for the common case: _Z4loopv → loop, _ZN3Foo3barEv → Foo::bar. */
export function demangle(name: string): string {
  if (!name.startsWith("_Z")) return name;
  let i = 2;
  const parts: string[] = [];
  const nested = name[i] === "N";
  if (nested) i++;
  while (i < name.length && /\d/.test(name[i])) {
    let n = 0;
    while (/\d/.test(name[i])) n = n * 10 + Number(name[i++]);
    parts.push(name.slice(i, i + n));
    i += n;
    if (!nested) break;
  }
  return parts.length ? parts.join("::") : name;
}

function parseSymbols(sections: ElfSection[], bytes: Uint8Array, table: LineTable, covered: (a: number) => boolean) {
  const symtab = sections.find((s) => s.type === 2); // SHT_SYMTAB
  if (!symtab) return;
  const strtab = sections[symtab.link];
  if (!strtab) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const nameAt = (off: number) => {
    const start = strtab.offset + off;
    let end = start;
    while (bytes[end]) end++;
    return dec.decode(bytes.subarray(start, end));
  };
  for (let o = symtab.offset; o + 16 <= symtab.offset + symtab.size; o += 16) {
    const info = dv.getUint8(o + 12);
    const value = dv.getUint32(o + 4, true);
    const size = dv.getUint32(o + 8, true);
    if ((info & 0xf) === 1 && size && value) { // STT_OBJECT
      table.objects.push(value, size, table.names.push(demangle(nameAt(dv.getUint32(o, true)))) - 1);
      continue;
    }
    if ((info & 0xf) !== 2 || !size || !covered(value)) continue; // STT_FUNC with user line info
    table.funcs.push(value, value + size, table.names.push(demangle(nameAt(dv.getUint32(o, true)))) - 1);
  }
}

/** Build the line table for the files matching `isUserFile` (e.g. the user's /src/ files). */
export function buildLineTable(sections: ElfSection[], bytes: Uint8Array, isUserFile: (f: string) => boolean): LineTable {
  const table: LineTable = { files: [], rows: [], funcs: [], names: [], objects: [] };
  const debugLine = sections.find((s) => s.name === ".debug_line");
  if (!debugLine) return table;
  const raw: number[][] = [];
  parseDebugLine(debugLine.data, table.files, raw);
  raw.sort((a, b) => a[0] - b[0] || (a[1] === 0 ? -1 : 1));
  for (const [addr, line, file] of raw) {
    // Line 0: compiler-generated code with no source line.
    const user = file >= 0 && line > 0 && isUserFile(table.files[file]);
    table.rows.push(addr, user ? line : 0, user ? file : -1);
  }
  const covered = (a: number) => lookupRow(table, a) >= 0;
  parseSymbols(sections, bytes, table, covered);
  return table;
}

function lookupRow(t: LineTable, addr: number): number {
  let lo = 0, hi = t.rows.length / 3 - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t.rows[mid * 3] <= addr) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && t.rows[found * 3 + 2] >= 0 ? found : -1;
}

/** Map a reported PC (a return address, just after the call) to a source location. */
export function locate(t: LineTable, pc: number): SourceLocation | undefined {
  const at = pc - 3; // the call8/callx8 instruction that called the trace hook
  const row = lookupRow(t, at);
  if (row < 0) return undefined;
  let func: string | undefined;
  for (let i = 0; i < t.funcs.length; i += 3) {
    if (at >= t.funcs[i] && at < t.funcs[i + 1]) func = t.names[t.funcs[i + 2]];
  }
  return { file: t.files[t.rows[row * 3 + 2]], line: t.rows[row * 3 + 1], func };
}

/** Source location of a PC that is the exact address of the next instruction (as JTAG reports it). */
export function locateExact(t: LineTable, pc: number): SourceLocation | undefined {
  return locate(t, pc + 3); // locate() takes a return address and looks 3 bytes (a call instruction) before it
}

export interface DataSymbol {
  name: string;
  addr: number;
  size: number;
}

/** All data symbols, sorted by address. */
export function dataSymbols(t: LineTable): DataSymbol[] {
  const out: DataSymbol[] = [];
  for (let i = 0; i + 2 < t.objects.length; i += 3) {
    out.push({ addr: t.objects[i], size: t.objects[i + 1], name: t.names[t.objects[i + 2]] });
  }
  return out.sort((a, b) => a.addr - b.addr);
}

/** The function containing pc, if it has line info. */
export function functionAt(t: LineTable, pc: number): { name: string; start: number; end: number } | undefined {
  for (let i = 0; i < t.funcs.length; i += 3) {
    if (pc >= t.funcs[i] && pc < t.funcs[i + 1]) return { start: t.funcs[i], end: t.funcs[i + 1], name: t.names[t.funcs[i + 2]] };
  }
  return undefined;
}

/** Address ranges [start, end) of all code on one line. */
export type Ranges = [number, number][];

function rangesWhere(t: LineTable, match: (line: number, file: number) => boolean): Ranges {
  const out: Ranges = [];
  for (let i = 0; i + 3 < t.rows.length; i += 3) {
    const [addr, line, file] = [t.rows[i], t.rows[i + 1], t.rows[i + 2]];
    const next = t.rows[i + 3];
    if (file >= 0 && line > 0 && next > addr && match(line, file)) {
      const last = out[out.length - 1];
      if (last && last[1] === addr) last[1] = next; // merge adjacent rows
      else out.push([addr, next]);
    }
  }
  return out;
}

/**
 * Code of a source line, for a breakpoint. A line without code (a comment, a
 * blank line, a lone brace) moves to the next line that has some, as in other
 * debuggers. Returns the line actually used.
 */
export function rangesForLine(t: LineTable, file: string, line: number): { line: number; ranges: Ranges } | undefined {
  const f = t.files.indexOf(file);
  if (f < 0) return undefined;
  let best = Infinity;
  for (let i = 0; i < t.rows.length; i += 3) {
    const l = t.rows[i + 1];
    if (t.rows[i + 2] === f && l >= line && l < best) best = l;
  }
  if (best === Infinity || best - line > 20) return undefined;
  return { line: best, ranges: rangesWhere(t, (l, fi) => fi === f && l === best) };
}

/** Code of the line containing pc, for stepping: run until execution leaves these ranges. */
export function rangesOfLineAt(t: LineTable, pc: number): Ranges {
  const loc = locate(t, pc);
  if (!loc) return [];
  const f = t.files.indexOf(loc.file);
  return rangesWhere(t, (l, fi) => fi === f && l === loc.line);
}

export const formatRanges = (r: Ranges): string =>
  r.map(([a, b]) => `${a.toString(16)}-${b.toString(16)}`).join(",");
