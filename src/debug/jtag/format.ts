/** Human-readable values from raw bytes and DWARF types: structs as {x: 1, y: 2}, arrays as [1, 2], enums by name. */
import type { DebugInfo, TypeInfo } from "../dwarf-info";

const MAX_DEPTH = 4;
const MAX_ITEMS = 16;

/** The type behind typedefs, const and volatile. */
export function strip(info: DebugInfo, t: number): TypeInfo | undefined {
  for (let n = 0; t >= 0 && n < 16; n++) {
    const ty = info.types[t];
    if (!ty) return undefined;
    if (ty.k !== "alias") return ty;
    t = ty.to;
  }
  return undefined;
}

export function typeSize(info: DebugInfo, t: number): number {
  const ty = strip(info, t);
  if (!ty) return 0;
  switch (ty.k) {
    case "base": case "ptr": case "struct": case "enum": return ty.size;
    case "array": return ty.count.reduce((a, c) => a * Math.max(c, 0), 1) * typeSize(info, ty.of);
    default: return 0;
  }
}

export function typeName(info: DebugInfo, t: number): string {
  if (t < 0) return "?";
  const raw = info.types[t];
  if (!raw) return "?";
  switch (raw.k) {
    case "base": return raw.name;
    case "struct": return raw.name || (raw.union ? "union" : "struct");
    case "enum": return raw.name || "enum";
    case "ptr": return `${raw.to < 0 ? "void" : typeName(info, raw.to)} *`;
    case "array": return `${typeName(info, raw.of)}${raw.count.map((c) => `[${c < 0 ? "" : c}]`).join("")}`;
    default: return raw.to < 0 ? "void" : typeName(info, raw.to);
  }
}

function int(b: Uint8Array, signed: boolean): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  if (signed && b.length && v >= 1n << BigInt(b.length * 8 - 1)) v -= 1n << BigInt(b.length * 8);
  return v;
}

const hex = (n: number) => "0x" + (n >>> 0).toString(16);

/** Format `bytes` as a value of type `t`. */
export function formatTyped(info: DebugInfo, t: number, bytes: Uint8Array, depth = 0): string {
  const ty = strip(info, t);
  if (!ty) return "—";
  switch (ty.k) {
    case "base": {
      const b = bytes.subarray(0, ty.size);
      if (b.length < ty.size) return "—";
      if (ty.enc === 4) {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        if (ty.size === 4) return Number(dv.getFloat32(0, true).toPrecision(7)).toString();
        if (ty.size === 8) return Number(dv.getFloat64(0, true).toPrecision(15)).toString();
      }
      if (ty.enc === 2) return int(b, false) ? "true" : "false";
      const signed = ty.enc === 5 || ty.enc === 6;
      const v = int(b, signed);
      // Only a plain char is text; uint8_t (an unsigned char) is a number like 41, not ')'.
      if ((ty.enc === 6 || ty.enc === 8) && ty.size === 1 && ty.name === "char") {
        const c = Number(v & 0xffn);
        return c >= 32 && c < 127 ? `${v} '${String.fromCharCode(c)}'` : String(v);
      }
      return v.toString();
    }
    case "ptr": {
      const v = Number(int(bytes.subarray(0, 4), false));
      return v ? hex(v) : "NULL";
    }
    case "enum": {
      const v = Number(int(bytes.subarray(0, ty.size), false));
      const named = ty.values.find(([, x]) => x === v);
      return named ? named[0] : String(v);
    }
    case "struct": {
      if (depth >= MAX_DEPTH) return "{…}";
      const parts = ty.members.slice(0, MAX_ITEMS).map((m) => {
        const size = typeSize(info, m.type);
        return `${m.name || "?"}: ${formatTyped(info, m.type, bytes.subarray(m.off, m.off + size), depth + 1)}`;
      });
      return `{${parts.join(", ")}${ty.members.length > MAX_ITEMS ? ", …" : ""}}`;
    }
    case "array": return formatArray(info, ty.of, ty.count, bytes, depth);
    default: return "—";
  }
}

function formatArray(info: DebugInfo, of: number, counts: number[], bytes: Uint8Array, depth: number): string {
  const elem = strip(info, of);
  const elemSize = typeSize(info, of);
  if (!elemSize) return "[…]";
  const [first, ...rest] = counts;
  const n = first < 0 ? Math.floor(bytes.length / elemSize) : first;
  const innerSize = rest.reduce((a, c) => a * Math.max(c, 0), 1) * elemSize;
  if (elem?.k === "base" && (elem.enc === 6 || elem.enc === 8) && elem.size === 1 && !rest.length) {
    let end = 0;
    while (end < n && end < bytes.length && bytes[end]) end++;
    return JSON.stringify(new TextDecoder().decode(bytes.subarray(0, end)));
  }
  if (depth >= MAX_DEPTH) return "[…]";
  const items: string[] = [];
  for (let i = 0; i < Math.min(n, MAX_ITEMS); i++) {
    const slice = bytes.subarray(i * innerSize, (i + 1) * innerSize);
    items.push(rest.length ? formatArray(info, of, rest, slice, depth + 1) : formatTyped(info, of, slice, depth + 1));
  }
  return `[${items.join(", ")}${n > MAX_ITEMS ? `, … (${n})` : ""}]`;
}
