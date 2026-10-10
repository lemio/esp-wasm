/**
 * Variables and types from .debug_info (DWARF 2–4, 32-bit), for the JTAG inspector:
 * which locals a function has, where they live (a frame offset or a fixed address),
 * and what shape they have, so structs and arrays can be shown the way the source
 * declares them. Plain data, so it can cross from the worker to the page.
 */
import type { ElfSection } from "../image/elf";

export type TypeInfo =
  | { k: "base"; name: string; size: number; enc: number }
  | { k: "ptr"; size: number; to: number }
  | { k: "struct"; name: string; size: number; union: boolean; members: { name: string; off: number; type: number }[] }
  | { k: "array"; of: number; count: number[] }
  | { k: "enum"; name: string; size: number; values: [string, number][] }
  | { k: "alias"; to: number };

export interface VarInfo {
  name: string;
  /** Index into DebugInfo.types, -1 if unknown. */
  type: number;
  /** Fixed address (globals, statics). */
  addr?: number;
  /** Offset from the frame base (the CFA), for locals and parameters. */
  fbreg?: number;
  /** Code range [lo, hi) where the variable is in scope; 0, 0 for globals. */
  lo: number;
  hi: number;
  func?: string;
  funcLo?: number;
  param?: boolean;
}

export interface DebugInfo {
  types: TypeInfo[];
  vars: VarInfo[];
}

// Tags
const TAG_ARRAY = 0x01, TAG_CLASS = 0x02, TAG_ENUM = 0x04, TAG_PARAM = 0x05, TAG_LEXBLOCK = 0x0b, TAG_MEMBER = 0x0d,
  TAG_POINTER = 0x0f, TAG_REFERENCE = 0x10, TAG_STRUCT = 0x13, TAG_TYPEDEF = 0x16, TAG_UNION = 0x17, TAG_SUBRANGE = 0x21,
  TAG_BASE = 0x24, TAG_CONST = 0x26, TAG_ENUMERATOR = 0x28, TAG_SUBPROGRAM = 0x2e, TAG_VARIABLE = 0x34, TAG_VOLATILE = 0x35,
  TAG_RESTRICT = 0x37, TAG_INLINED = 0x1d;
// Attributes
const AT_LOCATION = 0x02, AT_NAME = 0x03, AT_BYTE_SIZE = 0x0b, AT_CONST_VALUE = 0x1c, AT_LOW_PC = 0x11, AT_HIGH_PC = 0x12,
  AT_ENCODING = 0x3e, AT_UPPER_BOUND = 0x2f, AT_COUNT = 0x37, AT_MEMBER_LOC = 0x38, AT_TYPE = 0x49, AT_ORIGIN = 0x31,
  AT_SPEC = 0x47;
const OP_ADDR = 0x03, OP_FBREG = 0x91;

type Value = number | string | Uint8Array;
interface Die {
  tag: number;
  attrs: Map<number, Value>;
  /** Attribute forms that were address-class (for high_pc). */
  highIsAddr: boolean;
  children: Die[];
  off: number;
}
interface Abbrev { tag: number; children: boolean; specs: [number, number][] }

class R {
  constructor(readonly dv: DataView, public pos: number) {}
  u8() { return this.dv.getUint8(this.pos++); }
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
}

function cstr(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < bytes.length && bytes[end]) end++;
  return new TextDecoder().decode(bytes.subarray(at, end));
}

function parseAbbrevs(data: Uint8Array, offset: number): Map<number, Abbrev> {
  const r = new R(new DataView(data.buffer, data.byteOffset, data.byteLength), offset);
  const out = new Map<number, Abbrev>();
  for (;;) {
    const code = r.uleb();
    if (!code) return out;
    const tag = r.uleb();
    const children = r.u8() !== 0;
    const specs: [number, number][] = [];
    for (;;) {
      const at = r.uleb(), form = r.uleb();
      if (!at && !form) break;
      specs.push([at, form]);
    }
    out.set(code, { tag, children, specs });
  }
}

/** Read one attribute value; references come back as absolute .debug_info offsets. */
function readForm(r: R, form: number, cuStart: number, info: Uint8Array, str: Uint8Array | undefined): { v: Value; addr?: boolean } {
  switch (form) {
    case 0x01: return { v: r.u32(), addr: true };
    case 0x03: { const n = r.u16(); const v = info.subarray(r.pos, r.pos + n); r.pos += n; return { v }; }
    case 0x04: { const n = r.u32(); const v = info.subarray(r.pos, r.pos + n); r.pos += n; return { v }; }
    case 0x05: return { v: r.u16() };
    case 0x06: return { v: r.u32() };
    case 0x07: { const lo = r.u32(); return { v: lo + r.u32() * 2 ** 32 }; }
    case 0x08: { let end = r.pos; while (info[end]) end++; const v = cstr(info, r.pos); r.pos = end + 1; return { v }; }
    case 0x09: case 0x18: { const n = r.uleb(); const v = info.subarray(r.pos, r.pos + n); r.pos += n; return { v }; }
    case 0x0a: { const n = r.u8(); const v = info.subarray(r.pos, r.pos + n); r.pos += n; return { v }; }
    case 0x0b: return { v: r.u8() };
    case 0x0c: return { v: r.u8() };
    case 0x0d: return { v: r.sleb() };
    case 0x0e: { const off = r.u32(); return { v: str ? cstr(str, off) : "" }; }
    case 0x0f: return { v: r.uleb() };
    case 0x10: return { v: r.u32() };
    case 0x11: return { v: cuStart + r.u8() };
    case 0x12: return { v: cuStart + r.u16() };
    case 0x13: return { v: cuStart + r.u32() };
    case 0x14: { const lo = r.u32(); return { v: cuStart + lo + r.u32() * 2 ** 32 }; }
    case 0x15: return { v: cuStart + r.uleb() };
    case 0x16: return readForm(r, r.uleb(), cuStart, info, str);
    case 0x17: return { v: r.u32() };
    case 0x19: return { v: 1 };
    case 0x20: r.pos += 8; return { v: 0 };
    default: throw new Error(`unsupported DWARF form 0x${form.toString(16)}`);
  }
}

function parseDies(info: Uint8Array, abbrevData: Uint8Array, str: Uint8Array | undefined): Map<number, Die> {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const byOffset = new Map<number, Die>();
  const abbrevCache = new Map<number, Map<number, Abbrev>>();
  let unit = 0;
  while (unit + 11 <= info.length) {
    const r = new R(dv, unit);
    const length = r.u32();
    if (length === 0xffffffff) throw new Error("64-bit DWARF isn't supported");
    const end = unit + 4 + length;
    const version = r.u16();
    if (version < 2 || version > 4) throw new Error(`DWARF ${version} isn't supported`);
    const abbrevOffset = r.u32();
    r.u8(); // address size
    let abbrevs = abbrevCache.get(abbrevOffset);
    if (!abbrevs) abbrevCache.set(abbrevOffset, (abbrevs = parseAbbrevs(abbrevData, abbrevOffset)));
    const stack: Die[] = [];
    while (r.pos < end) {
      const off = r.pos;
      const code = r.uleb();
      if (!code) { stack.pop(); continue; }
      const ab = abbrevs.get(code);
      if (!ab) break;
      const die: Die = { tag: ab.tag, attrs: new Map(), highIsAddr: false, children: [], off };
      for (const [at, form] of ab.specs) {
        const { v, addr } = readForm(r, form, unit, info, str);
        die.attrs.set(at, v);
        if (at === AT_HIGH_PC && addr) die.highIsAddr = true;
      }
      byOffset.set(off, die);
      if (stack.length) stack[stack.length - 1].children.push(die);
      if (ab.children) stack.push(die);
    }
    unit = end;
  }
  return byOffset;
}

const num = (d: Die, at: number): number | undefined => {
  const v = d.attrs.get(at);
  return typeof v === "number" ? v : undefined;
};
const text = (d: Die, at: number): string | undefined => {
  const v = d.attrs.get(at);
  return typeof v === "string" ? v : undefined;
};

export function parseDebugInfo(sections: ElfSection[], bytes: Uint8Array): DebugInfo {
  const out: DebugInfo = { types: [], vars: [] };
  const sec = (n: string) => {
    const s = sections.find((x) => x.name === n);
    return s ? bytes.subarray(s.offset, s.offset + s.size) : undefined;
  };
  const info = sec(".debug_info"), abbrev = sec(".debug_abbrev");
  if (!info || !abbrev) return out;
  const dies = parseDies(info, abbrev, sec(".debug_str"));

  // Types
  const typeIndex = new Map<number, number>();
  const placeholder: TypeInfo = { k: "alias", to: -1 };
  const typeOf = (d: Die): number => {
    const ref = num(d, AT_TYPE);
    return ref === undefined ? -1 : (typeIndex.get(ref) ?? -1);
  };
  const typeDies: Die[] = [];
  for (const d of dies.values()) {
    if ([TAG_BASE, TAG_POINTER, TAG_REFERENCE, TAG_STRUCT, TAG_CLASS, TAG_UNION, TAG_ARRAY, TAG_ENUM, TAG_TYPEDEF, TAG_CONST, TAG_VOLATILE, TAG_RESTRICT].includes(d.tag)) {
      typeIndex.set(d.off, out.types.length);
      out.types.push(placeholder);
      typeDies.push(d);
    }
  }
  typeDies.forEach((d, i) => {
    const size = num(d, AT_BYTE_SIZE) ?? 0;
    const name = text(d, AT_NAME) ?? "";
    switch (d.tag) {
      case TAG_BASE: out.types[i] = { k: "base", name, size, enc: num(d, AT_ENCODING) ?? 7 }; break;
      case TAG_POINTER: case TAG_REFERENCE: out.types[i] = { k: "ptr", size: size || 4, to: typeOf(d) }; break;
      case TAG_STRUCT: case TAG_CLASS: case TAG_UNION: {
        const members = d.children.filter((c) => c.tag === TAG_MEMBER).map((c) => {
          const loc = c.attrs.get(AT_MEMBER_LOC);
          const off = typeof loc === "number" ? loc : 0;
          return { name: text(c, AT_NAME) ?? "", off, type: typeOf(c) };
        });
        out.types[i] = { k: "struct", name, size, union: d.tag === TAG_UNION, members };
        break;
      }
      case TAG_ARRAY: {
        const count = d.children.filter((c) => c.tag === TAG_SUBRANGE).map((c) => {
          const n = num(c, AT_COUNT);
          if (n !== undefined) return n;
          const ub = num(c, AT_UPPER_BOUND);
          return ub === undefined ? -1 : ub + 1;
        });
        out.types[i] = { k: "array", of: typeOf(d), count: count.length ? count : [-1] };
        break;
      }
      case TAG_ENUM:
        out.types[i] = { k: "enum", name, size: size || 4, values: d.children.filter((c) => c.tag === TAG_ENUMERATOR).map((c) => [text(c, AT_NAME) ?? "", num(c, AT_CONST_VALUE) ?? 0]) };
        break;
      default: out.types[i] = { k: "alias", to: typeOf(d) };
    }
  });

  // Variables: walk each subprogram, tracking the innermost scope range.
  const resolveName = (d: Die): string | undefined => {
    for (let cur: Die | undefined = d, n = 0; cur && n < 4; n++) {
      const nm = text(cur, AT_NAME);
      if (nm) return nm;
      const o: number | undefined = num(cur, AT_ORIGIN) ?? num(cur, AT_SPEC);
      cur = o === undefined ? undefined : dies.get(o);
    }
    return undefined;
  };
  const resolveType = (d: Die): number => {
    for (let cur: Die | undefined = d, n = 0; cur && n < 4; n++) {
      const t = num(cur, AT_TYPE);
      if (t !== undefined) return typeIndex.get(t) ?? -1;
      const o: number | undefined = num(cur, AT_ORIGIN) ?? num(cur, AT_SPEC);
      cur = o === undefined ? undefined : dies.get(o);
    }
    return -1;
  };
  const range = (d: Die): [number, number] | undefined => {
    const lo = num(d, AT_LOW_PC), hi = num(d, AT_HIGH_PC);
    if (lo === undefined || hi === undefined) return undefined;
    return [lo, d.highIsAddr ? hi : lo + hi];
  };
  const addVar = (d: Die, scope: [number, number], func?: { name: string; lo: number }): void => {
    const name = resolveName(d);
    if (!name) return;
    const loc = d.attrs.get(AT_LOCATION);
    const v: VarInfo = { name, type: resolveType(d), lo: scope[0], hi: scope[1], func: func?.name, funcLo: func?.lo, param: d.tag === TAG_PARAM };
    if (loc instanceof Uint8Array && loc.length) {
      const r = new R(new DataView(loc.buffer, loc.byteOffset, loc.byteLength), 1);
      if (loc[0] === OP_ADDR && loc.length === 5) v.addr = r.u32();
      else if (loc[0] === OP_FBREG) v.fbreg = r.sleb();
    }
    out.vars.push(v);
  };
  const walk = (d: Die, scope: [number, number], func?: { name: string; lo: number }): void => {
    for (const c of d.children) {
      if (c.tag === TAG_VARIABLE || c.tag === TAG_PARAM) addVar(c, scope, func);
      else if (c.tag === TAG_LEXBLOCK || c.tag === TAG_INLINED) walk(c, range(c) ?? scope, func);
      else if (c.tag === TAG_SUBPROGRAM) {
        const r = range(c);
        if (r) walk(c, r, { name: resolveName(c) ?? "?", lo: r[0] });
      }
    }
  };
  for (const d of dies.values()) {
    if (d.tag === 0x11) { // compile unit
      for (const c of d.children) {
        if (c.tag === TAG_VARIABLE) addVar(c, [0, 0]);
        else if (c.tag === TAG_SUBPROGRAM) {
          const r = range(c);
          if (r) walk(c, r, { name: resolveName(c) ?? "?", lo: r[0] });
        } else if (c.tag === 0x39 /* namespace */) {
          for (const n of c.children) {
            if (n.tag === TAG_VARIABLE) addVar(n, [0, 0]);
            else if (n.tag === TAG_SUBPROGRAM) { const r = range(n); if (r) walk(n, r, { name: resolveName(n) ?? "?", lo: r[0] }); }
          }
        }
      }
    }
  }
  return out;
}
