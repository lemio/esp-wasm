/** Minimal little-endian ELF32 reader: enough for elf2image. */

export interface ElfSegment {
  type: number;
  offset: number;
  vaddr: number;
  paddr: number;
  filesz: number;
  memsz: number;
  flags: number;
  data: Uint8Array;
}

export interface ElfSection {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  /** sh_link: e.g. the string table of a symbol table. */
  link: number;
  data: Uint8Array;
}

export interface ElfFile {
  machine: number;
  entry: number;
  segments: ElfSegment[];
  sections: ElfSection[];
}

export const PT_LOAD = 1;
export const SHT_PROGBITS = 1;
export const SHT_NOBITS = 8;
export const SHT_INIT_ARRAY = 14;
export const SHT_FINI_ARRAY = 15;
export const SHT_PREINIT_ARRAY = 16;
export const SHF_ALLOC = 0x2;
export const EM_XTENSA = 94;

export function parseElf(bytes: Uint8Array): ElfFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0x7f454c46) throw new Error("Not an ELF file");
  if (bytes[4] !== 1) throw new Error("Only ELF32 is supported");
  if (bytes[5] !== 1) throw new Error("Only little-endian ELF is supported");

  const machine = dv.getUint16(18, true);
  const entry = dv.getUint32(24, true);
  const phoff = dv.getUint32(28, true);
  const phentsize = dv.getUint16(42, true);
  const phnum = dv.getUint16(44, true);

  const segments: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    const offset = dv.getUint32(o + 4, true);
    const filesz = dv.getUint32(o + 16, true);
    segments.push({
      type: dv.getUint32(o, true),
      offset,
      vaddr: dv.getUint32(o + 8, true),
      paddr: dv.getUint32(o + 12, true),
      filesz,
      memsz: dv.getUint32(o + 20, true),
      flags: dv.getUint32(o + 24, true),
      data: bytes.subarray(offset, offset + filesz),
    });
  }

  const shoff = dv.getUint32(32, true);
  const shentsize = dv.getUint16(46, true);
  const shnum = dv.getUint16(48, true);
  const shstrndx = dv.getUint16(50, true);
  const raw = Array.from({ length: shnum }, (_, i) => {
    const o = shoff + i * shentsize;
    return {
      nameOff: dv.getUint32(o, true),
      type: dv.getUint32(o + 4, true),
      flags: dv.getUint32(o + 8, true),
      addr: dv.getUint32(o + 12, true),
      offset: dv.getUint32(o + 16, true),
      size: dv.getUint32(o + 20, true),
      link: dv.getUint32(o + 24, true),
    };
  });
  const strtab = raw[shstrndx];
  const dec = new TextDecoder();
  const nameAt = (off: number) => {
    const start = strtab.offset + off;
    let end = start;
    while (bytes[end] !== 0) end++;
    return dec.decode(bytes.subarray(start, end));
  };
  const sections: ElfSection[] = raw.map((s) => ({
    name: strtab ? nameAt(s.nameOff) : "",
    type: s.type,
    flags: s.flags,
    addr: s.addr,
    offset: s.offset,
    size: s.size,
    link: s.link,
    data: s.type === SHT_NOBITS ? new Uint8Array(0) : bytes.subarray(s.offset, s.offset + s.size),
  }));

  return { machine, entry, segments, sections };
}
