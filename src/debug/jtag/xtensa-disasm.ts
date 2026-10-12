/**
 * An Xtensa disassembler for the ESP32-S3's LX7 cores, with a plain-English explanation of each
 * instruction. Covers the core instruction set and the options the compiler emits for this chip:
 * windowed registers (CALL4/8/12, ENTRY, RETW), code density (the 16-bit ".n" forms), 32-bit
 * multiply/divide, MIN/MAX, SEXT/CLAMPS, NSA, loops, booleans and the single-precision FPU.
 * Encodings follow the Xtensa Instruction Set Architecture Reference Manual. Anything else (the
 * S3's vector extensions, MAC16) is shown as raw bytes.
 *
 * Fields of a 24-bit instruction (little-endian): op0 [3:0], t [7:4], s [11:8], r [15:12],
 * op1 [19:16], op2 [23:20]. An op0 of 8–13 marks a 16-bit instruction.
 */

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
  /** L32R: the address of the constant it loads. */
  literal?: number;
}

export interface Context {
  /** A 32-bit word of the program (for L32R constants), if known. */
  word(addr: number): number | undefined;
  /** A name for an address: a function, a variable. */
  name(addr: number): string | undefined;
  /** What a value is, in words, if it's an address of something ("the address of function x"). */
  describe?(value: number): string | undefined;
}

const sext = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);
const hex = (n: number) => "0x" + (n >>> 0).toString(16);
const a = (n: number) => `a${n}`;
const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];

/** Special registers by number (RSR/WSR/XSR). */
const SR: Record<number, string> = {
  0: "LBEG", 1: "LEND", 2: "LCOUNT", 3: "SAR", 4: "BR", 5: "LITBASE", 12: "SCOMPARE1", 16: "ACCLO", 17: "ACCHI",
  32: "M0", 33: "M1", 34: "M2", 35: "M3", 72: "WINDOWBASE", 73: "WINDOWSTART", 96: "IBREAKENABLE", 97: "MEMCTL",
  98: "ATOMCTL", 104: "DDR", 128: "IBREAKA0", 129: "IBREAKA1", 144: "DBREAKA0", 145: "DBREAKA1", 160: "DBREAKC0",
  161: "DBREAKC1", 177: "EPC1", 178: "EPC2", 179: "EPC3", 180: "EPC4", 181: "EPC5", 182: "EPC6", 183: "EPC7",
  192: "DEPC", 194: "EPS2", 195: "EPS3", 196: "EPS4", 197: "EPS5", 198: "EPS6", 199: "EPS7", 209: "EXCSAVE1",
  210: "EXCSAVE2", 211: "EXCSAVE3", 212: "EXCSAVE4", 213: "EXCSAVE5", 214: "EXCSAVE6", 215: "EXCSAVE7",
  224: "CPENABLE", 226: "INTERRUPT", 227: "INTCLEAR", 228: "INTENABLE", 230: "PS", 231: "VECBASE", 232: "EXCCAUSE",
  233: "DEBUGCAUSE", 234: "CCOUNT", 235: "PRID", 236: "ICOUNT", 237: "ICOUNTLEVEL", 238: "EXCVADDR", 240: "CCOMPARE0",
  241: "CCOMPARE1", 242: "CCOMPARE2", 244: "MISC0", 245: "MISC1", 246: "MISC2", 247: "MISC3",
};
const SR_MEANING: Record<string, string> = {
  SAR: "the shift amount register", PS: "the processor state (interrupt level, window settings)", CCOUNT: "the cycle counter",
  INTENABLE: "the enabled interrupts", INTERRUPT: "the pending interrupts", INTCLEAR: "the interrupt-clear register",
  EXCCAUSE: "the cause of the last exception", EXCVADDR: "the address that caused the last exception", PRID: "the core's ID",
  VECBASE: "the address of the exception vectors", CPENABLE: "the coprocessor (FPU) enable bits", LBEG: "the loop start",
  LEND: "the loop end", LCOUNT: "the loop count", SCOMPARE1: "the compare value for S32C1I", WINDOWBASE: "the register window position",
  WINDOWSTART: "which register windows are in use", THREADPTR: "the thread pointer",
};
/** User registers (RUR/WUR). */
const UR: Record<number, string> = { 231: "THREADPTR", 232: "FCR", 233: "FSR" };

const srName = (n: number) => SR[n] ?? `sr${n}`;
const srText = (n: number) => `${srName(n)}${SR_MEANING[srName(n)] ? ` (${SR_MEANING[srName(n)]})` : ""}`;

function make(addr: number, bytes: number[], mnemonic: string, operands: string, explain: string, extra: Partial<Insn> = {}): Insn {
  return { addr, size: bytes.length, bytes, mnemonic, operands, explain, ...extra };
}

/** Decode the instruction at `bytes[at]`, which is at address `addr` on the chip. */
export function decode(bytes: Uint8Array, at: number, addr: number, ctx: Context): Insn {
  const b0 = bytes[at] ?? 0, b1 = bytes[at + 1] ?? 0, b2 = bytes[at + 2] ?? 0;
  const op0 = b0 & 0xf;
  const label = (target: number) => {
    const n = ctx.name(target);
    return n ? `${hex(target)} <${n}>` : hex(target);
  };
  const where = (target: number) => ctx.name(target) ?? hex(target);

  // ---- 32-bit: the ESP32-S3's vector/DSP extension (op0 = 0xE, 0xF: "ee.*" instructions) ----
  if (op0 >= 14) {
    const bs = [b0, b1, b2, bytes[at + 3] ?? 0];
    return make(addr, bs, "ee.*", bs.map((x) => hex(x)).join(" "), "an ESP32-S3 vector (SIMD/DSP) instruction, used by optimized libraries");
  }

  // ---- 16-bit (code density) ----
  if (op0 >= 8 && op0 <= 13) {
    const ins = b0 | (b1 << 8);
    const t = (ins >> 4) & 0xf, s = (ins >> 8) & 0xf, r = (ins >> 12) & 0xf;
    const bs = [b0, b1];
    switch (op0) {
      case 8: return make(addr, bs, "l32i.n", `${a(t)}, ${a(s)}, ${r * 4}`, `${a(t)} = the 32-bit word at ${a(s)} + ${r * 4}`);
      case 9: return make(addr, bs, "s32i.n", `${a(t)}, ${a(s)}, ${r * 4}`, `store ${a(t)} as a 32-bit word at ${a(s)} + ${r * 4}`);
      case 10: return make(addr, bs, "add.n", `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = ${a(s)} + ${a(t)}`);
      case 11: {
        const imm = t === 0 ? -1 : t;
        return make(addr, bs, "addi.n", `${a(r)}, ${a(s)}, ${imm}`, `${a(r)} = ${a(s)} ${imm < 0 ? "−" : "+"} ${Math.abs(imm)}`);
      }
      case 12: {
        if (t < 8) {
          const imm7 = ((t & 7) << 4) | r;
          const v = imm7 >= 96 ? imm7 - 128 : imm7;
          return make(addr, bs, "movi.n", `${a(s)}, ${v}`, `${a(s)} = ${v}`);
        }
        const target = addr + 4 + (((t & 3) << 4) | r);
        const z = (t & 4) === 0;
        return make(addr, bs, z ? "beqz.n" : "bnez.n", `${a(s)}, ${label(target)}`, `if ${a(s)} ${z ? "is" : "isn't"} 0, go to ${where(target)}`, { target });
      }
      default: { // 13: ST3
        if (r === 0) return make(addr, bs, "mov.n", `${a(t)}, ${a(s)}`, `${a(t)} = ${a(s)}`);
        if (r === 15) {
          if (t === 0) return make(addr, bs, "ret.n", "", "return to the caller (CALL0 convention)");
          if (t === 1) return make(addr, bs, "retw.n", "", "return to the caller, rotating the register window back (the end of a function)");
          if (t === 2) return make(addr, bs, "break.n", `${s}`, "stop here for a debugger (a breakpoint compiled into the code)");
          if (t === 3) return make(addr, bs, "nop.n", "", "do nothing (padding, usually for alignment)");
          if (t === 6) return make(addr, bs, "ill.n", "", "an illegal instruction: causes an exception if run");
        }
        return make(addr, bs, ".short", hex(ins), "an instruction this disassembler doesn't know");
      }
    }
  }

  // ---- 24-bit ----
  const ins = b0 | (b1 << 8) | (b2 << 16);
  const bs = [b0, b1, b2];
  const t = (ins >> 4) & 0xf, s = (ins >> 8) & 0xf, r = (ins >> 12) & 0xf, op1 = (ins >> 16) & 0xf, op2 = (ins >> 20) & 0xf;
  const imm8 = (ins >> 16) & 0xff;
  const m = (k: string, ops: string, explain: string, extra: Partial<Insn> = {}) => make(addr, bs, k, ops, explain, extra);
  const unknown = () => m(".byte", bs.map((x) => hex(x)).join(", "), "an instruction this disassembler doesn't know (perhaps one of the S3's vector extensions)");
  const rrr = (k: string, op: string) => m(k, `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = ${a(s)} ${op} ${a(t)}`);

  switch (op0) {
    case 0: {
      if (op1 === 0) {
        if (op2 === 0) {
          if (r === 0) {
            const mm = (t >> 2) & 3, n = t & 3;
            if (ins === 0) return m("ill", "", "an illegal instruction (all zeros): not code, or padding");
            if (mm === 2 && n === 0) return m("ret", "", "return to the caller (CALL0 convention)");
            if (mm === 2 && n === 1) return m("retw", "", "return to the caller, rotating the register window back (the end of a function)");
            if (mm === 2 && n === 2) return m("jx", a(s), `jump to the address in ${a(s)}`);
            if (mm === 3) return m(`callx${n * 4}`, a(s), `call the function whose address is in ${a(s)}${n ? ` (a windowed call: the callee gets a fresh set of registers, the window shifts by ${n * 4})` : ""}`);
          }
          if (r === 1) return m("movsp", `${a(t)}, ${a(s)}`, `${a(t)} = ${a(s)}, as a new stack pointer (spilling register windows if needed)`);
          if (r === 2) {
            const sync: Record<number, [string, string]> = {
              0: ["isync", "wait until earlier instructions take effect before fetching more"], 1: ["rsync", "wait for register writes to take effect"],
              2: ["esync", "wait for special-register writes to take effect"], 3: ["dsync", "wait for data-related writes to take effect"],
              8: ["excw", "wait for pending exceptions"], 12: ["memw", "memory barrier: finish all earlier memory accesses first (the compiler adds this around volatile accesses)"],
              13: ["extw", "wait until all external effects (memory, interrupts) are done"], 15: ["nop", "do nothing"],
            };
            const k = sync[t];
            if (k) return m(k[0], "", k[1]);
          }
          if (r === 3) {
            if (t === 0) {
              const rfe: Record<number, string> = { 0: "rfe", 1: "rfue", 2: "rfde", 4: "rfwo", 5: "rfwu" };
              if (rfe[s]) return m(rfe[s], "", s >= 4 ? "return from a register-window exception handler" : "return from an exception handler");
            }
            if (t === 1) return m("rfi", `${s}`, `return from a level-${s} interrupt handler`);
          }
          if (r === 4) return m("break", `${s}, ${t}`, "stop here for a debugger (ESP-IDF uses this to hand a crash to an attached debugger)");
          if (r === 5) return m(s === 0 ? "syscall" : "simcall", "", s === 0 ? "a system call exception" : "a simulator call");
          if (r === 6) return m("rsil", `${a(t)}, ${s}`, `${a(t)} = PS, then raise the interrupt level to ${s}: interrupts up to level ${s} are held off (a critical section)`);
          if (r === 7) return m("waiti", `${s}`, `sleep until an interrupt above level ${s} arrives (the idle task does this)`);
          return unknown();
        }
        if (op2 === 1) return rrr("and", "&");
        if (op2 === 2) {
          if (s === t && r === s) return m("or", `${a(r)}, ${a(s)}, ${a(t)}`, "do nothing (or-ing a register with itself: a no-op)");
          return s === t ? m("mov", `${a(r)}, ${a(s)}`, `${a(r)} = ${a(s)}`) : rrr("or", "|");
        }
        if (op2 === 3) return rrr("xor", "^");
        if (op2 === 4) {
          if (r === 0) return m("ssr", a(s), `set the shift amount (SAR) from ${a(s)}, for a right shift`);
          if (r === 1) return m("ssl", a(s), `set the shift amount (SAR) from ${a(s)}, for a left shift`);
          if (r === 2) return m("ssa8l", a(s), `set the shift amount to 8 × ${a(s)} (byte shift, little-endian)`);
          if (r === 3) return m("ssa8b", a(s), `set the shift amount to 8 × ${a(s)} (byte shift, big-endian)`);
          if (r === 4) return m("ssai", `${s | ((t & 1) << 4)}`, `set the shift amount (SAR) to ${s | ((t & 1) << 4)}`);
          if (r === 8) return m("rotw", `${sext(t, 4)}`, `rotate the register window by ${sext(t, 4)} × 4 registers`);
          if (r === 14) return m("nsa", `${a(t)}, ${a(s)}`, `${a(t)} = how many redundant sign bits ${a(s)} has (normalisation)`);
          if (r === 15) return m("nsau", `${a(t)}, ${a(s)}`, `${a(t)} = the number of leading zero bits in ${a(s)}`);
          return unknown();
        }
        if (op2 === 6) {
          if (s === 0) return m("neg", `${a(r)}, ${a(t)}`, `${a(r)} = −${a(t)}`);
          if (s === 1) return m("abs", `${a(r)}, ${a(t)}`, `${a(r)} = |${a(t)}|`);
          return unknown();
        }
        const addsub: Record<number, [string, string]> = {
          8: ["add", "+"], 9: ["addx2", "2× … +"], 10: ["addx4", "4× … +"], 11: ["addx8", "8× … +"],
          12: ["sub", "−"], 13: ["subx2", "2× … −"], 14: ["subx4", "4× … −"], 15: ["subx8", "8× … −"],
        };
        if (addsub[op2]) {
          const [k] = addsub[op2];
          const f = op2 & 3 ? 1 << (op2 & 3) : 0;
          const neg = op2 >= 12;
          return m(k, `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = ${f ? `${f} × ` : ""}${a(s)} ${neg ? "−" : "+"} ${a(t)}${f ? " (array indexing)" : ""}`);
        }
        return unknown();
      }
      if (op1 === 1) {
        if (op2 <= 1) {
          const sh = 32 - (((op2 & 1) << 4) | t);
          return m("slli", `${a(r)}, ${a(s)}, ${sh}`, `${a(r)} = ${a(s)} << ${sh} (× ${2 ** sh})`);
        }
        if (op2 <= 3) {
          const sh = ((op2 & 1) << 4) | s;
          return m("srai", `${a(r)}, ${a(t)}, ${sh}`, `${a(r)} = ${a(t)} >> ${sh}, keeping the sign (÷ ${2 ** sh}, rounding down)`);
        }
        if (op2 === 4) return m("srli", `${a(r)}, ${a(t)}, ${s}`, `${a(r)} = ${a(t)} >> ${s}, filling with zeros`);
        if (op2 === 6) return m("xsr", `${a(t)}, ${srName((r << 4) | s)}`, `swap ${a(t)} with ${srText((r << 4) | s)}`);
        if (op2 === 8) return m("src", `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = the 64-bit value ${a(s)}:${a(t)} shifted right by SAR (funnel shift)`);
        if (op2 === 9) return m("srl", `${a(r)}, ${a(t)}`, `${a(r)} = ${a(t)} >> SAR, filling with zeros`);
        if (op2 === 10) return m("sll", `${a(r)}, ${a(s)}`, `${a(r)} = ${a(s)} << (32 − SAR)`);
        if (op2 === 11) return m("sra", `${a(r)}, ${a(t)}`, `${a(r)} = ${a(t)} >> SAR, keeping the sign`);
        if (op2 === 12) return m("mul16u", `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = the low 16 bits of ${a(s)} × those of ${a(t)} (unsigned)`);
        if (op2 === 13) return m("mul16s", `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = the low 16 bits of ${a(s)} × those of ${a(t)} (signed)`);
        return unknown();
      }
      if (op1 === 2) {
        const bool: Record<number, [string, string]> = { 0: ["andb", "&"], 1: ["andbc", "& !"], 2: ["orb", "|"], 3: ["orbc", "| !"], 4: ["xorb", "^"] };
        if (bool[op2]) return m(bool[op2][0], `b${r}, b${s}, b${t}`, `boolean b${r} = b${s} ${bool[op2][1]} b${t}`);
        if (op2 === 6 || op2 === 7) {
          const u = op2 === 6;
          return m(u ? "saltu" : "salt", `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = 1 if ${a(s)} < ${a(t)}${u ? " (unsigned)" : ""}, else 0`);
        }
        const md: Record<number, [string, string]> = {
          8: ["mull", "×"], 10: ["muluh", "× (high 32 bits, unsigned) of"], 11: ["mulsh", "× (high 32 bits, signed) of"],
          12: ["quou", "÷ (unsigned)"], 13: ["quos", "÷ (signed)"], 14: ["remu", "mod (unsigned)"], 15: ["rems", "mod (signed)"],
        };
        if (md[op2]) return rrr(md[op2][0], md[op2][1]);
        return unknown();
      }
      if (op1 === 3) {
        const sr = (r << 4) | s;
        if (op2 === 0) return m("rsr", `${a(t)}, ${srName(sr)}`, `${a(t)} = ${srText(sr)}`);
        if (op2 === 1) return m("wsr", `${a(t)}, ${srName(sr)}`, `${srText(sr)} = ${a(t)}`);
        if (op2 === 2) return m("sext", `${a(r)}, ${a(s)}, ${t + 7}`, `${a(r)} = ${a(s)} sign-extended from bit ${t + 7} (a ${t + 8}-bit signed value)`);
        if (op2 === 3) return m("clamps", `${a(r)}, ${a(s)}, ${t + 7}`, `${a(r)} = ${a(s)} limited to a ${t + 8}-bit signed range`);
        const mm: Record<number, [string, string]> = {
          4: ["min", "the smaller of"], 5: ["max", "the larger of"], 6: ["minu", "the smaller (unsigned) of"], 7: ["maxu", "the larger (unsigned) of"],
        };
        if (mm[op2]) return m(mm[op2][0], `${a(r)}, ${a(s)}, ${a(t)}`, `${a(r)} = ${mm[op2][1]} ${a(s)} and ${a(t)}`);
        const mv: Record<number, [string, string]> = { 8: ["moveqz", "is 0"], 9: ["movnez", "isn't 0"], 10: ["movltz", "is negative"], 11: ["movgez", "isn't negative"] };
        if (mv[op2]) return m(mv[op2][0], `${a(r)}, ${a(s)}, ${a(t)}`, `if ${a(t)} ${mv[op2][1]}: ${a(r)} = ${a(s)} (a branch-free if)`);
        if (op2 === 14) return m("rur", `${a(r)}, ${UR[(s << 4) | t] ?? `ur${(s << 4) | t}`}`, `${a(r)} = user register ${UR[(s << 4) | t] ?? (s << 4) | t}`);
        if (op2 === 15) return m("wur", `${a(t)}, ${UR[(r << 4) | s] ?? `ur${(r << 4) | s}`}`, `user register ${UR[(r << 4) | s] ?? (r << 4) | s} = ${a(t)}`);
        return unknown();
      }
      if (op1 === 4 || op1 === 5) {
        const shift = ((op1 & 1) << 4) | s, bits = op2 + 1;
        return m("extui", `${a(r)}, ${a(t)}, ${shift}, ${bits}`, `${a(r)} = bits ${shift}–${shift + bits - 1} of ${a(t)} (a ${bits}-bit field)`);
      }
      if (op1 === 8) {
        const k: Record<number, string> = { 0: "lsx", 1: "lsxp", 4: "ssx", 5: "ssxp" };
        if (k[op2]) return m(k[op2], `f${r}, ${a(s)}, ${a(t)}`, op2 < 4 ? `f${r} = the float at ${a(s)} + ${a(t)}` : `store f${r} at ${a(s)} + ${a(t)}`);
        return unknown();
      }
      if (op1 === 10) {
        const f3: Record<number, [string, string]> = { 0: ["add.s", "+"], 1: ["sub.s", "−"], 2: ["mul.s", "×"] };
        if (f3[op2]) return m(f3[op2][0], `f${r}, f${s}, f${t}`, `f${r} = f${s} ${f3[op2][1]} f${t} (floating point)`);
        if (op2 === 4) return m("madd.s", `f${r}, f${s}, f${t}`, `f${r} += f${s} × f${t} (floating point)`);
        if (op2 === 5) return m("msub.s", `f${r}, f${s}, f${t}`, `f${r} −= f${s} × f${t} (floating point)`);
        const conv: Record<number, [string, string]> = {
          8: ["round.s", "rounded"], 9: ["trunc.s", "truncated"], 10: ["floor.s", "rounded down"], 11: ["ceil.s", "rounded up"], 14: ["utrunc.s", "truncated, unsigned"],
        };
        if (conv[op2]) return m(conv[op2][0], `${a(r)}, f${s}, ${t}`, `${a(r)} = f${s} × 2^${t}, ${conv[op2][1]} to an integer`);
        if (op2 === 12) return m("float.s", `f${r}, ${a(s)}, ${t}`, `f${r} = ${a(s)} as a float${t ? ` ÷ 2^${t}` : ""}`);
        if (op2 === 13) return m("ufloat.s", `f${r}, ${a(s)}, ${t}`, `f${r} = ${a(s)} (unsigned) as a float${t ? ` ÷ 2^${t}` : ""}`);
        if (op2 === 15) {
          if (t === 0) return m("mov.s", `f${r}, f${s}`, `f${r} = f${s}`);
          if (t === 1) return m("abs.s", `f${r}, f${s}`, `f${r} = |f${s}|`);
          if (t === 4) return m("rfr", `${a(r)}, f${s}`, `${a(r)} = the bits of f${s}`);
          if (t === 5) return m("wfr", `f${r}, ${a(s)}`, `f${r} = the bits of ${a(s)}`);
          if (t === 6) return m("neg.s", `f${r}, f${s}`, `f${r} = −f${s}`);
        }
        return unknown();
      }
      if (op1 === 11) {
        const cmp: Record<number, [string, string]> = {
          1: ["un.s", "is unordered with (one is NaN)"], 2: ["oeq.s", "=="], 3: ["ueq.s", "== (or NaN)"], 4: ["olt.s", "<"],
          5: ["ult.s", "< (or NaN)"], 6: ["ole.s", "<="], 7: ["ule.s", "<= (or NaN)"],
        };
        if (cmp[op2]) return m(cmp[op2][0], `b${r}, f${s}, f${t}`, `b${r} = whether f${s} ${cmp[op2][1]} f${t}`);
        const mv: Record<number, [string, string]> = { 8: ["moveqz.s", "is 0"], 9: ["movnez.s", "isn't 0"], 10: ["movltz.s", "is negative"], 11: ["movgez.s", "isn't negative"] };
        if (mv[op2]) return m(mv[op2][0], `f${r}, f${s}, ${a(t)}`, `if ${a(t)} ${mv[op2][1]}: f${r} = f${s}`);
        return unknown();
      }
      if (op1 === 9) {
        const off = (r << 2) - 64;
        if (op2 === 0) return m("l32e", `${a(t)}, ${a(s)}, ${off}`, `${a(t)} = the word at ${a(s)} ${off} (in a window exception handler)`);
        if (op2 === 4) return m("s32e", `${a(t)}, ${a(s)}, ${off}`, `store ${a(t)} at ${a(s)} ${off} (in a window exception handler)`);
      }
      return unknown();
    }
    case 1: {
      // L32R: a 32-bit constant from a literal pool before the code.
      const lit = (((addr + 3) & ~3) + ((((ins >> 8) & 0xffff) - 0x10000) << 2)) >>> 0;
      const v = ctx.word(lit);
      const vd = v !== undefined ? ctx.describe?.(v) ?? (ctx.name(v) ? `the address of ${ctx.name(v)}` : undefined) : undefined;
      return m("l32r", `${a(t)}, ${hex(lit)}`, `${a(t)} = ${v !== undefined ? `${hex(v)}${vd ? `, ${vd}` : v < 1e6 ? ` = ${v}` : ""}` : "a constant"} (read from the literal pool at ${hex(lit)})`, { literal: lit });
    }
    case 2: {
      const loads: Record<number, [string, number, string]> = {
        0: ["l8ui", 1, "byte"], 1: ["l16ui", 2, "16-bit value (unsigned)"], 2: ["l32i", 4, "32-bit word"], 9: ["l16si", 2, "16-bit value (signed)"], 11: ["l32ai", 4, "32-bit word (acquire: later accesses wait for it)"],
      };
      if (loads[r]) {
        const [k, sz, what] = loads[r];
        return m(k, `${a(t)}, ${a(s)}, ${imm8 * sz}`, `${a(t)} = the ${what} at ${a(s)} + ${imm8 * sz}${s === 1 ? " (a local variable on the stack)" : ""}`);
      }
      const stores: Record<number, [string, number, string]> = { 4: ["s8i", 1, "the low byte of"], 5: ["s16i", 2, "the low 16 bits of"], 6: ["s32i", 4, ""], 15: ["s32ri", 4, "(release: earlier accesses first)"] };
      if (stores[r]) {
        const [k, sz, what] = stores[r];
        return m(k, `${a(t)}, ${a(s)}, ${imm8 * sz}`, `store ${what ? what + " " : ""}${a(t)} at ${a(s)} + ${imm8 * sz}${s === 1 ? " (a local variable on the stack)" : ""}`);
      }
      if (r === 10) {
        const v = sext((s << 8) | imm8, 12);
        return m("movi", `${a(t)}, ${v}`, `${a(t)} = ${v}${v > 9 || v < -9 ? ` (${hex(v)})` : ""}`);
      }
      if (r === 12) {
        const v = sext(imm8, 8);
        return m("addi", `${a(t)}, ${a(s)}, ${v}`, `${a(t)} = ${a(s)} ${v < 0 ? "−" : "+"} ${Math.abs(v)}`);
      }
      if (r === 13) {
        const v = sext(imm8, 8) * 256;
        return m("addmi", `${a(t)}, ${a(s)}, ${v}`, `${a(t)} = ${a(s)} ${v < 0 ? "−" : "+"} ${Math.abs(v)}`);
      }
      if (r === 14) return m("s32c1i", `${a(t)}, ${a(s)}, ${imm8 * 4}`, `atomic compare-and-swap at ${a(s)} + ${imm8 * 4} (used by locks)`);
      if (r === 7) return m("cache", `${a(s)}, ${imm8 * 4}`, "a cache operation");
      return unknown();
    }
    case 3: {
      const k: Record<number, [string, boolean]> = { 0: ["lsi", true], 4: ["ssi", false], 8: ["lsiu", true], 12: ["ssiu", false] };
      if (k[r]) return m(k[r][0], `f${t}, ${a(s)}, ${imm8 * 4}`, k[r][1] ? `f${t} = the float at ${a(s)} + ${imm8 * 4}` : `store f${t} at ${a(s)} + ${imm8 * 4}`);
      return unknown();
    }
    case 4: return m(".byte", bs.map((x) => hex(x)).join(", "), "a MAC16 (multiply-accumulate) instruction");
    case 5: {
      const n = (ins >> 4) & 3;
      const target = (((addr & ~3) + (sext(ins >>> 6, 18) << 2) + 4) >>> 0);
      return m(`call${n * 4}`, label(target), `call ${where(target)}${n ? ` (a windowed call: the function gets fresh registers; a${n * 4} holds the return address)` : ""}`, { target });
    }
    case 6: {
      const n = (ins >> 4) & 3, mm = (ins >> 6) & 3;
      if (n === 0) {
        const target = (addr + 4 + sext(ins >>> 6, 18)) >>> 0;
        return m("j", label(target), `jump to ${where(target)}`, { target });
      }
      if (n === 1) {
        const target = (addr + 4 + sext(ins >>> 12, 12)) >>> 0;
        const k = [["beqz", "is 0"], ["bnez", "isn't 0"], ["bltz", "is negative"], ["bgez", "isn't negative"]][mm];
        return m(k[0], `${a(s)}, ${label(target)}`, `if ${a(s)} ${k[1]}, go to ${where(target)}`, { target });
      }
      const target8 = (addr + 4 + sext(imm8, 8)) >>> 0;
      if (n === 2) {
        const k = [["beqi", "=="], ["bnei", "!="], ["blti", "<"], ["bgei", ">="]][mm];
        return m(k[0], `${a(s)}, ${B4CONST[r]}, ${label(target8)}`, `if ${a(s)} ${k[1]} ${B4CONST[r]}, go to ${where(target8)}`, { target: target8 });
      }
      // n === 3
      if (mm === 0) {
        const frame = ((ins >>> 12) & 0xfff) * 8;
        return m("entry", `${a(s)}, ${frame}`, `start of a function: rotate to fresh registers and reserve ${frame} bytes of stack for its locals`);
      }
      if (mm === 1) {
        if (r === 0) return m("bf", `b${s}, ${label(target8)}`, `if boolean b${s} is false, go to ${where(target8)}`, { target: target8 });
        if (r === 1) return m("bt", `b${s}, ${label(target8)}`, `if boolean b${s} is true, go to ${where(target8)}`, { target: target8 });
        const loopEnd = (addr + 4 + imm8) >>> 0;
        const k: Record<number, string> = { 8: "loop", 9: "loopnez", 10: "loopgtz" };
        if (k[r]) return m(k[r], `${a(s)}, ${label(loopEnd)}`, `repeat the following instructions up to ${hex(loopEnd)} ${a(s)} times (a zero-overhead hardware loop)`, { target: loopEnd });
        return unknown();
      }
      const k = mm === 2 ? ["bltui", "<"] : ["bgeui", ">="];
      return m(k[0], `${a(s)}, ${B4CONSTU[r]}, ${label(target8)}`, `if ${a(s)} ${k[1]} ${B4CONSTU[r]} (unsigned), go to ${where(target8)}`, { target: target8 });
    }
    case 7: {
      const target = (addr + 4 + sext(imm8, 8)) >>> 0;
      const go = `go to ${where(target)}`;
      const bbi = ((r & 1) << 4) | t;
      const rr: Record<number, [string, string, string]> = {
        0: ["bnone", `${a(s)}, ${a(t)}`, `if ${a(s)} & ${a(t)} is 0, ${go}`], 1: ["beq", `${a(s)}, ${a(t)}`, `if ${a(s)} == ${a(t)}, ${go}`],
        2: ["blt", `${a(s)}, ${a(t)}`, `if ${a(s)} < ${a(t)}, ${go}`], 3: ["bltu", `${a(s)}, ${a(t)}`, `if ${a(s)} < ${a(t)} (unsigned), ${go}`],
        4: ["ball", `${a(s)}, ${a(t)}`, `if all bits of ${a(t)} are set in ${a(s)}, ${go}`], 5: ["bbc", `${a(s)}, ${a(t)}`, `if bit ${a(t)} of ${a(s)} is 0, ${go}`],
        8: ["bany", `${a(s)}, ${a(t)}`, `if ${a(s)} & ${a(t)} isn't 0, ${go}`], 9: ["bne", `${a(s)}, ${a(t)}`, `if ${a(s)} != ${a(t)}, ${go}`],
        10: ["bge", `${a(s)}, ${a(t)}`, `if ${a(s)} >= ${a(t)}, ${go}`], 11: ["bgeu", `${a(s)}, ${a(t)}`, `if ${a(s)} >= ${a(t)} (unsigned), ${go}`],
        12: ["bnall", `${a(s)}, ${a(t)}`, `if not all bits of ${a(t)} are set in ${a(s)}, ${go}`], 13: ["bbs", `${a(s)}, ${a(t)}`, `if bit ${a(t)} of ${a(s)} is 1, ${go}`],
      };
      if (rr[r]) return m(rr[r][0], `${rr[r][1]}, ${label(target)}`, rr[r][2], { target });
      if (r === 6 || r === 7) return m("bbci", `${a(s)}, ${bbi}, ${label(target)}`, `if bit ${bbi} of ${a(s)} is 0, ${go}`, { target });
      return m("bbsi", `${a(s)}, ${bbi}, ${label(target)}`, `if bit ${bbi} of ${a(s)} is 1, ${go}`, { target });
    }
    default:
      return unknown();
  }
}

/** Decode `count` instructions (or up to `end`) from `start`. */
export function disassemble(bytes: Uint8Array, base: number, start: number, end: number, ctx: Context, max = 4000): Insn[] {
  const out: Insn[] = [];
  for (let addr = start; addr < end && out.length < max;) {
    const at = addr - base;
    if (at < 0 || at >= bytes.length) break;
    const i = decode(bytes, at, addr, ctx);
    out.push(i);
    addr += i.size;
  }
  return out;
}
