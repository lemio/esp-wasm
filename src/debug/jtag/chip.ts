/**
 * What the inspector needs to know about one chip: its CPU (register names, how calls and
 * returns look), its memory map and registers (SocApi), its pins, its machine code
 * (a disassembler) and the words it uses to talk about connecting to it. One profile per
 * chip: chip-esp32s3.ts, chip-ch32v003.ts.
 */
import type { Db, SocApi } from "./soc";

/** An instruction, as the Program view shows it. */
export interface Insn {
  addr: number;
  size: number;
  bytes: number[];
  mnemonic: string;
  operands: string;
  /** What it does, in words. */
  explain: string;
  /** A branch, jump or call destination. */
  target?: number;
  /** A load of a constant from memory (Xtensa L32R): the constant's address. */
  literal?: number;
}

export interface DisasmContext {
  /** A 32-bit word of the program (for constants loaded from memory), if known. */
  word(addr: number): number | undefined;
  /** A name for an address: a function, a variable. */
  name(addr: number): string | undefined;
  /** What a value is, in words, if it's an address of something ("the address of function x"). */
  describe?(value: number): string | undefined;
}

/** One row of the Pins tab. */
export interface PinRow {
  /** The pin's name ("12", "PD6"). */
  id: string;
  /** Clicking the name shows these registers (its configuration). */
  idLink?: { base: number; filter: string; title: string };
  /** "output", "input", "output from", "set by", "off". */
  dir: string;
  dirTitle: string;
  /** What drives it, if not plain GPIO; with a link to its registers when known. */
  peripheral?: string;
  peripheralLink?: { base: number; filter: string; label: string };
  pull?: string;
  level: string;
  /** The level shown as a dot. */
  dot?: number;
  /** A level that doesn't add up (driven high, reads low): replaces `level`. */
  warn?: string;
  changed: boolean;
  /** Not in use (shown dimmed). */
  off: boolean;
  drive: string;
  note: string;
  /** The note in full, when `note` is short for it. */
  noteTitle?: string;
}

export interface PinModel {
  /** The columns' headings and explanations: pin, direction, history, level, drive, note. */
  headers: [string, string][];
  /** The registers that hold every pin's level: read for each sample of the history. */
  levelRegs: number[];
  /** Everything the table needs (levels, configuration, clocks). */
  allRegs(db: Db): number[];
  /** The CPU clock, from registers of `allRegs`, to turn cycles into time. */
  hz(words: Map<number, number>): number | undefined;
  /** A pin's level (driven if an output, read otherwise) from a sample of `levelRegs`. */
  level(levels: (number | undefined)[], pin: string): number | undefined;
  rows(words: Map<number, number>, prev: Map<number, number> | undefined, db: Db): PinRow[];
  /** The cycle counter the samples are stamped with, for their tooltips ("CCOUNT"). */
  counter: string;
}

export interface ChipProfile {
  /** For remembered settings. */
  id: string;
  /** "ESP32-S3" */
  name: string;
  arch: "xtensa" | "riscv";
  /** What the link to the chip is called in messages ("JTAG", "SWIO"). */
  link: string;
  soc: SocApi;
  pins: PinModel;
  /** The working registers, by index in Registers.ar. */
  regNames: string[];
  /** Which of them is the stack pointer. */
  sp: number;
  /** A word or two next to a register's name, and a sentence for its tooltip. */
  roleShort: Record<string, string>;
  roleLong: Record<string, string>;
  /** Bytes back from a return address that are surely inside the call instruction. */
  callBack: number;
  /** Breakpoints that can be set at once. */
  maxBreakpoints: number;
  /** Where the Memory tab starts. */
  defaultMemory: number;
  /** Where static data (globals) lives: below the heap or the stack. */
  ram: { lo: number; hi: number };
  /** Values below this aren't called addresses in the Program view (small numbers aren't pointers). */
  minAddress: number;
  /** Peripherals offered in the Memory tab before anything is typed: name, address, what it is. */
  places: [string, number, string][];
  disassemble(data: Uint8Array, base: number, start: number, end: number, ctx: DisasmContext): Insn[];
  /** Which address each load or store touches, where straight-line code makes it known. `regs`: register values known at the start. */
  constantAddresses(insns: Insn[], word: (addr: number) => number | undefined, regs?: Map<string, number>): Map<number, number>;
  /** Register names an instruction's operands mention, and their index in Registers.ar. */
  operandRegs(operands: string): { name: string; index: number }[];
  text: {
    connecting: string;
    notConnected: string;
    connectTitle: string;
    /** What the file written to flash is called ("app.bin"). */
    image: string;
    /** Under the file map. */
    fileMapNote: string;
    /** For an address with nothing there. */
    unmapped: string;
    /** System code, for the call stack: "(Arduino, ESP-IDF or a library)". */
    systemCode: string;
    /** The tabs' help texts that differ from the ESP32-S3's. */
    help: Record<string, string>;
    /** The instruction set, for the Program view's column title. */
    isa: string;
    /** How the chip stores numbers, for the Memory tab. */
    endian: string;
  };
}
