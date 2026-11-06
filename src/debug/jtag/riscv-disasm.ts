/**
 * A RISC-V disassembler for the CH32V003's QingKe V2A core (RV32EC: the base integer set with
 * 16 registers, and the 16-bit compressed instructions), plus Zicsr and the M extension for
 * completeness, with a plain-English explanation of each instruction. Instructions are shown the
 * way GNU objdump shows them, with the usual pseudo-instructions (li, mv, ret, call, j, beqz…).
 *
 * Encodings follow The RISC-V Instruction Set Manual, Volume I (base formats, chapter 2; the
 * "C" extension, chapter 16).
 */
import type { DisasmContext, Insn } from "./chip";

export const ABI = ["zero", "ra", "sp", "gp", "tp", "t0", "t1", "t2", "s0", "s1", "a0", "a1", "a2", "a3", "a4", "a5",
  "a6", "a7", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10", "s11", "t3", "t4", "t5", "t6"];

const CSRS: Record<number, [string, string]> = {
  0x300: ["mstatus", "the machine status (interrupts on or off)"],
  0x301: ["misa", "which instruction-set extensions the CPU has"],
  0x304: ["mie", "which interrupts are enabled"],
  0x305: ["mtvec", "where interrupts and exceptions jump to (the vector table)"],
  0x340: ["mscratch", "a scratch register for interrupt handlers"],
  0x341: ["mepc", "the address an interrupt or exception will return to"],
  0x342: ["mcause", "why the last interrupt or exception happened"],
  0x343: ["mtval", "the bad address or instruction of the last exception"],
  0x344: ["mip", "which interrupts are pending"],
  0x7b0: ["dcsr", "the debug control and status (used by the debugger)"],
  0x7b1: ["dpc", "the debugger's program counter"],
  0x804: ["intsyscr", "WCH's interrupt system control (hardware stacking, nesting)"],
  0xbc0: ["corecfgr", "WCH's core configuration (pipelining, prediction)"],
  0xf11: ["mvendorid", "the CPU's vendor ID"],
  0xf12: ["marchid", "the CPU's architecture ID"],
  0xf13: ["mimpid", "the CPU's implementation ID"],
  0xf14: ["mhartid", "this CPU core's number"],
};

const sext = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);
const hex = (n: number) => "0x" + (n >>> 0).toString(16);
const r = (n: number) => ABI[n] ?? `x${n}`;
const rc = (n: number) => ABI[8 + (n & 7)];
const imm = (v: number) => (Math.abs(v) >= 0x1000 ? `${v < 0 ? "-" : ""}${hex(Math.abs(v))}` : String(v));

export function disassemble(data: Uint8Array, base: number, start: number, end: number, ctx: DisasmContext): Insn[] {
  const label = (target: number) => {
    const n = ctx.name(target);
    return n ? `${hex(target)} <${n}>` : hex(target);
  };
  const where = (target: number) => ctx.name(target) ?? hex(target);
  /** A value, and what it is when it's an address of something. */
  const value = (v: number) => {
    const d = ctx.describe?.(v >>> 0) ?? (ctx.name(v >>> 0) ? `the address of ${ctx.name(v >>> 0)}` : undefined);
    return `${imm(v | 0)}${d ? ` (${d})` : ""}`;
  };

  const LOADS: Record<number, [string, string]> = {
    0: ["lb", "one byte (−128–127)"], 1: ["lh", "a 16-bit number (signed)"], 2: ["lw", "a 32-bit word"],
    4: ["lbu", "one byte (0–255)"], 5: ["lhu", "a 16-bit number (0–65535)"],
  };
  const STORES: Record<number, [string, string]> = { 0: ["sb", "the low byte of"], 1: ["sh", "the low 16 bits of"], 2: ["sw", ""] };
  const load = (f3: number, rd: number, rs1: number, off: number): [string, string, string] => {
    const [m, what] = LOADS[f3] ?? ["l?", "?"];
    return [m, `${r(rd)}, ${off}(${r(rs1)})`, `${r(rd)} = ${what} read from memory at ${r(rs1)} + ${off}`];
  };
  const store = (f3: number, rs2: number, rs1: number, off: number): [string, string, string] => {
    const [m, what] = STORES[f3] ?? ["s?", ""];
    return [m, `${r(rs2)}, ${off}(${r(rs1)})`, `write ${what ? `${what} ` : ""}${r(rs2)} to memory at ${r(rs1)} + ${off}`];
  };

  /** One 32-bit instruction: mnemonic, operands, explanation, and a jump target. */
  const decode32 = (w: number, addr: number): [string, string, string, number?] => {
    const op = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
    const iImm = w >> 20;
    switch (op) {
      case 0x37: {
        const v = w & 0xfffff000;
        return ["lui", `${r(rd)}, ${hex(v >>> 12)}`, `${r(rd)} = ${hex(v)}: the top 20 bits of a 32-bit constant (the next instruction usually adds the low 12 bits)`];
      }
      case 0x17: {
        const v = (addr + (w & 0xfffff000)) >>> 0;
        return ["auipc", `${r(rd)}, ${hex((w & 0xfffff000) >>> 12)}`, `${r(rd)} = this instruction's address + ${hex(w & 0xfffff000)} = ${hex(v)} (for an address relative to the code)`];
      }
      case 0x6f: {
        const off = sext(((w >>> 31) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1), 21);
        const t = (addr + off) >>> 0;
        if (rd === 0) return ["j", label(t), `jump to ${where(t)}`, t];
        if (rd === 1) return ["jal", label(t), `call ${where(t)} (ra = the address of the next instruction, to return to)`, t];
        return ["jal", `${r(rd)}, ${label(t)}`, `jump to ${where(t)}, with ${r(rd)} = the address to return to`, t];
      }
      case 0x67:
        if (rd === 0 && rs1 === 1 && iImm === 0) return ["ret", "", "return to the caller (jump to the address in ra)"];
        if (rd === 0) return ["jr", iImm ? `${iImm}(${r(rs1)})` : r(rs1), `jump to the address in ${r(rs1)}${iImm ? ` + ${iImm}` : ""}`];
        if (rd === 1) return ["jalr", iImm ? `${iImm}(${r(rs1)})` : r(rs1), `call the function whose address is in ${r(rs1)}${iImm ? ` + ${iImm}` : ""} (ra = the return address)`];
        return ["jalr", `${r(rd)}, ${iImm}(${r(rs1)})`, `jump to ${r(rs1)} + ${iImm}, with ${r(rd)} = the return address`];
      case 0x63: {
        const off = sext(((w >>> 31) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1), 13);
        const t = (addr + off) >>> 0;
        const B: Record<number, [string, string, boolean]> = {
          0: ["beq", "==", false], 1: ["bne", "≠", false], 4: ["blt", "<", false], 5: ["bge", "≥", false], 6: ["bltu", "<", true], 7: ["bgeu", "≥", true],
        };
        const [m, cmp, u] = B[f3] ?? ["b?", "?", false];
        if (rs2 === 0 && (f3 === 0 || f3 === 1)) {
          return [`${m}z`, `${r(rs1)}, ${label(t)}`, `if ${r(rs1)} ${f3 ? "isn't" : "is"} 0, go to ${where(t)}`, t];
        }
        return [m, `${r(rs1)}, ${r(rs2)}, ${label(t)}`, `if ${r(rs1)} ${cmp} ${r(rs2)}${u ? " (unsigned)" : ""}, go to ${where(t)}`, t];
      }
      case 0x03: return load(f3, rd, rs1, iImm);
      case 0x23: return store(f3, rs2, rs1, sext(((w >>> 25) << 5) | ((w >>> 7) & 31), 12));
      case 0x13: {
        const sh = rs2;
        switch (f3) {
          case 0:
            if (rd === 0 && rs1 === 0 && iImm === 0) return ["nop", "", "do nothing (one cycle)"];
            if (rs1 === 0) return ["li", `${r(rd)}, ${imm(iImm)}`, `${r(rd)} = ${value(iImm)}`];
            if (iImm === 0) return ["mv", `${r(rd)}, ${r(rs1)}`, `${r(rd)} = ${r(rs1)} (copy)`];
            return ["addi", `${r(rd)}, ${r(rs1)}, ${imm(iImm)}`, `${r(rd)} = ${r(rs1)} ${iImm < 0 ? `− ${-iImm}` : `+ ${iImm}`}`];
          case 1: return ["slli", `${r(rd)}, ${r(rs1)}, ${sh}`, `${r(rd)} = ${r(rs1)} shifted left by ${sh} bits (× ${2 ** sh})`];
          case 2: return ["slti", `${r(rd)}, ${r(rs1)}, ${iImm}`, `${r(rd)} = 1 if ${r(rs1)} < ${iImm}, else 0`];
          case 3: return iImm === 1 ? ["seqz", `${r(rd)}, ${r(rs1)}`, `${r(rd)} = 1 if ${r(rs1)} is 0, else 0`] : ["sltiu", `${r(rd)}, ${r(rs1)}, ${iImm}`, `${r(rd)} = 1 if ${r(rs1)} < ${iImm} (unsigned), else 0`];
          case 4: return iImm === -1 ? ["not", `${r(rd)}, ${r(rs1)}`, `${r(rd)} = ${r(rs1)} with every bit flipped`] : ["xori", `${r(rd)}, ${r(rs1)}, ${imm(iImm)}`, `${r(rd)} = ${r(rs1)} XOR ${imm(iImm)} (flips those bits)`];
          case 5: return f7 & 0x20
            ? ["srai", `${r(rd)}, ${r(rs1)}, ${sh}`, `${r(rd)} = ${r(rs1)} shifted right by ${sh} bits, keeping the sign (÷ ${2 ** sh}, rounding down)`]
            : ["srli", `${r(rd)}, ${r(rs1)}, ${sh}`, `${r(rd)} = ${r(rs1)} shifted right by ${sh} bits (÷ ${2 ** sh}, unsigned)`];
          case 6: return ["ori", `${r(rd)}, ${r(rs1)}, ${imm(iImm)}`, `${r(rd)} = ${r(rs1)} OR ${imm(iImm)} (sets those bits)`];
          default: return ["andi", `${r(rd)}, ${r(rs1)}, ${imm(iImm)}`, `${r(rd)} = ${r(rs1)} AND ${imm(iImm)} (keeps only those bits)`];
        }
      }
      case 0x33: {
        const a = r(rs1), b = r(rs2), d = r(rd);
        if (f7 === 1) {
          const M = [["mul", "×"], ["mulh", "× (high 32 bits, signed)"], ["mulhsu", "× (high bits, signed × unsigned)"], ["mulhu", "× (high 32 bits, unsigned)"],
            ["div", "÷"], ["divu", "÷ (unsigned)"], ["rem", "remainder of ÷"], ["remu", "remainder of ÷ (unsigned)"]][f3];
          return [M[0], `${d}, ${a}, ${b}`, `${d} = ${a} ${M[1]} ${b}`];
        }
        const sub = f7 & 0x20;
        switch (f3) {
          case 0: return sub
            ? (rs1 === 0 ? ["neg", `${d}, ${b}`, `${d} = −${b}`] : ["sub", `${d}, ${a}, ${b}`, `${d} = ${a} − ${b}`])
            : ["add", `${d}, ${a}, ${b}`, `${d} = ${a} + ${b}`];
          case 1: return ["sll", `${d}, ${a}, ${b}`, `${d} = ${a} shifted left by ${b} bits`];
          case 2: return ["slt", `${d}, ${a}, ${b}`, `${d} = 1 if ${a} < ${b}, else 0`];
          case 3: return rs1 === 0 ? ["snez", `${d}, ${b}`, `${d} = 1 if ${b} isn't 0, else 0`] : ["sltu", `${d}, ${a}, ${b}`, `${d} = 1 if ${a} < ${b} (unsigned), else 0`];
          case 4: return ["xor", `${d}, ${a}, ${b}`, `${d} = ${a} XOR ${b}`];
          case 5: return sub ? ["sra", `${d}, ${a}, ${b}`, `${d} = ${a} shifted right by ${b} bits, keeping the sign`] : ["srl", `${d}, ${a}, ${b}`, `${d} = ${a} shifted right by ${b} bits`];
          case 6: return ["or", `${d}, ${a}, ${b}`, `${d} = ${a} OR ${b}`];
          default: return ["and", `${d}, ${a}, ${b}`, `${d} = ${a} AND ${b}`];
        }
      }
      case 0x0f: return f3 === 1 ? ["fence.i", "", "make the instruction fetch see earlier writes to memory"] : ["fence", "", "finish earlier memory accesses before later ones start"];
      case 0x73: {
        if (f3 === 0) {
          const k = w >>> 20;
          if (k === 0) return ["ecall", "", "call the environment (a system call): raises an exception"];
          if (k === 1) return ["ebreak", "", "breakpoint: stop and hand control to the debugger"];
          if (k === 0x302) return ["mret", "", "return from an interrupt or exception handler (to the address in mepc)"];
          if (k === 0x105) return ["wfi", "", "wait for an interrupt: the CPU sleeps until something happens"];
          return ["system", hex(w), "a system instruction"];
        }
        const csr = w >>> 20;
        const [name, about] = CSRS[csr] ?? [hex(csr), "a control and status register"];
        const src = f3 & 4 ? String(rs1) : r(rs1);
        const kind = f3 & 3;
        if (kind === 2 && rs1 === 0) return ["csrr", `${r(rd)}, ${name}`, `${r(rd)} = ${name}: ${about}`];
        const verbs = ["", "set it to", "set the bits", "clear the bits"];
        const m = `csrr${["", "w", "s", "c"][kind]}${f3 & 4 ? "i" : ""}`;
        return [m, `${r(rd)}, ${name}, ${src}`, `${rd ? `${r(rd)} = ${name} (${about}), then ` : `${name} (${about}): `}${verbs[kind]} ${f3 & 4 ? src : r(rs1)}${kind > 1 ? " in it" : ""}`];
      }
    }
    return [".word", hex(w), "not an instruction this disassembler knows (data, or an extension)"];
  };

  /** One 16-bit (compressed) instruction. */
  const decode16 = (h: number, addr: number): [string, string, string, number?] => {
    const q = h & 3, f3 = h >>> 13;
    const b = (hi: number, lo: number) => (h >>> lo) & ((1 << (hi - lo + 1)) - 1);
    if (h === 0) return ["c.unimp", "", "not an instruction (0x0000: erased or zeroed memory)"];
    if (q === 0) {
      const rdp = b(4, 2), rs1p = b(9, 7);
      const lwOff = (b(12, 10) << 3) | (b(6, 6) << 2) | (b(5, 5) << 6);
      if (f3 === 0) {
        const nz = (b(12, 11) << 4) | (b(10, 7) << 6) | (b(6, 6) << 2) | (b(5, 5) << 3);
        return ["addi", `${rc(rdp)}, sp, ${nz}`, `${rc(rdp)} = sp + ${nz}: the address of something on the stack`];
      }
      if (f3 === 2) return load(2, 8 + rdp, 8 + rs1p, lwOff);
      if (f3 === 6) return store(2, 8 + rdp, 8 + rs1p, lwOff);
    } else if (q === 1) {
      const rd = b(11, 7);
      const i6 = sext((b(12, 12) << 5) | b(6, 2), 6);
      const cj = () => sext((b(12, 12) << 11) | (b(11, 11) << 4) | (b(10, 9) << 8) | (b(8, 8) << 10) | (b(7, 7) << 6) | (b(6, 6) << 7) | (b(5, 3) << 1) | (b(2, 2) << 5), 12);
      switch (f3) {
        case 0: return rd === 0 ? ["nop", "", "do nothing (one cycle)"] : ["addi", `${r(rd)}, ${r(rd)}, ${i6}`, `${r(rd)} = ${r(rd)} ${i6 < 0 ? `− ${-i6}` : `+ ${i6}`}`];
        case 1: {
          const t = (addr + cj()) >>> 0;
          return ["jal", label(t), `call ${where(t)} (ra = the address of the next instruction, to return to)`, t];
        }
        case 2: return ["li", `${r(rd)}, ${i6}`, `${r(rd)} = ${value(i6)}`];
        case 3:
          if (rd === 2) {
            const v = sext((b(12, 12) << 9) | (b(6, 6) << 4) | (b(5, 5) << 6) | (b(4, 3) << 7) | (b(2, 2) << 5), 10);
            return ["addi", `sp, sp, ${v}`, v < 0 ? `make room for ${-v} bytes on the stack (sp = sp − ${-v}): this function's frame` : `free ${v} bytes of stack (sp = sp + ${v}): the function's frame is done`];
          } else {
            const v = sext((b(12, 12) << 17) | (b(6, 2) << 12), 18);
            return ["lui", `${r(rd)}, ${hex((v >>> 12) & 0xfffff)}`, `${r(rd)} = ${hex(v)}: the top bits of a constant`];
          }
        case 4: {
          const rdp = 8 + b(9, 7), f2 = b(11, 10), sh = (b(12, 12) << 5) | b(6, 2);
          if (f2 === 0) return ["srli", `${r(rdp)}, ${r(rdp)}, ${sh}`, `${r(rdp)} = ${r(rdp)} shifted right by ${sh} bits (÷ ${2 ** sh}, unsigned)`];
          if (f2 === 1) return ["srai", `${r(rdp)}, ${r(rdp)}, ${sh}`, `${r(rdp)} = ${r(rdp)} shifted right by ${sh} bits, keeping the sign`];
          if (f2 === 2) return ["andi", `${r(rdp)}, ${r(rdp)}, ${i6}`, `${r(rdp)} = ${r(rdp)} AND ${i6} (keeps only those bits)`];
          const rs2p = 8 + b(4, 2);
          const ops = [["sub", "−"], ["xor", "XOR"], ["or", "OR"], ["and", "AND"]][b(6, 5)];
          if (b(12, 12)) return [".half", hex(h), "not an RV32 instruction"];
          return [ops[0], `${r(rdp)}, ${r(rdp)}, ${r(rs2p)}`, `${r(rdp)} = ${r(rdp)} ${ops[1]} ${r(rs2p)}`];
        }
        case 5: {
          const t = (addr + cj()) >>> 0;
          return ["j", label(t), `jump to ${where(t)}`, t];
        }
        default: {
          const off = sext((b(12, 12) << 8) | (b(11, 10) << 3) | (b(6, 5) << 6) | (b(4, 3) << 1) | (b(2, 2) << 5), 9);
          const t = (addr + off) >>> 0;
          const rs = rc(b(9, 7));
          return [f3 === 6 ? "beqz" : "bnez", `${rs}, ${label(t)}`, `if ${rs} ${f3 === 6 ? "is" : "isn't"} 0, go to ${where(t)}`, t];
        }
      }
    } else if (q === 2) {
      const rd = b(11, 7), rs2 = b(6, 2);
      if (f3 === 0) {
        const sh = (b(12, 12) << 5) | rs2;
        return ["slli", `${r(rd)}, ${r(rd)}, ${sh}`, `${r(rd)} = ${r(rd)} shifted left by ${sh} bits (× ${2 ** sh})`];
      }
      if (f3 === 2) {
        const off = (b(12, 12) << 5) | (b(6, 4) << 2) | (b(3, 2) << 6);
        const [m, ops, ex] = load(2, rd, 2, off);
        return [m, ops, rd === 1 ? `${ex}: the saved return address` : ex];
      }
      if (f3 === 4) {
        if (!b(12, 12)) {
          if (rs2 === 0) return rd === 1 ? ["ret", "", "return to the caller (jump to the address in ra)"] : ["jr", r(rd), `jump to the address in ${r(rd)}`];
          return ["mv", `${r(rd)}, ${r(rs2)}`, `${r(rd)} = ${r(rs2)} (copy)`];
        }
        if (rd === 0 && rs2 === 0) return ["ebreak", "", "breakpoint: stop and hand control to the debugger (the inspector's breakpoints are these)"];
        if (rs2 === 0) return ["jalr", r(rd), `call the function whose address is in ${r(rd)} (ra = the return address)`];
        return ["add", `${r(rd)}, ${r(rd)}, ${r(rs2)}`, `${r(rd)} = ${r(rd)} + ${r(rs2)}`];
      }
      if (f3 === 6) {
        const off = (b(12, 9) << 2) | (b(8, 7) << 6);
        const [m, ops, ex] = store(2, rs2, 2, off);
        return [m, ops, rs2 === 1 ? `${ex}: save the return address, for calling other functions` : ex];
      }
    }
    return [".half", hex(h), "not an instruction this disassembler knows"];
  };

  const out: Insn[] = [];
  let addr = start;
  while (addr < end) {
    const at = addr - base;
    if (at < 0 || at + 2 > data.length) break;
    const h = data[at] | (data[at + 1] << 8);
    let size = 2, decoded: [string, string, string, number?];
    if ((h & 3) === 3) {
      if (at + 4 > data.length) break;
      size = 4;
      decoded = decode32((h | (data[at + 2] << 16) | (data[at + 3] << 24)) | 0, addr);
    } else decoded = decode16(h, addr);
    const [mnemonic, operands, explain, target] = decoded;
    out.push({ addr, size, bytes: [...data.subarray(at, at + size)], mnemonic, operands, explain, target });
    addr += size;
  }
  return out;
}

/**
 * Follow constants through straight-line code, to say which address a load or store touches
 * ("lw a5, 12(a4)" with a4 = 0x40011400: GPIOD's OUTDR): lui/li/addi/mv/auipc give a register a
 * known value, anything else that writes it (or a branch target, or a call) forgets it. `regs`
 * seeds registers that hold the same value everywhere (gp, for globals near it).
 */
export function constantAddresses(insns: Insn[], _word: (addr: number) => number | undefined, regs?: Map<string, number>): Map<number, number> {
  const targets = new Set(insns.filter((i) => i.target !== undefined).map((i) => i.target!));
  const fixed = new Map(regs ?? []);
  const known = new Map(fixed);
  const out = new Map<number, number>();
  const callerSaved = ["ra", "t0", "t1", "t2", "a0", "a1", "a2", "a3", "a4", "a5"];
  for (const i of insns) {
    if (targets.has(i.addr)) {
      known.clear();
      for (const [k, v] of fixed) known.set(k, v);
    }
    const m = i.mnemonic;
    const ops = i.operands.split(", ");
    const k = (reg: string) => known.get(reg);
    const mem = /^(-?\d+)\((\w+)\)$/.exec(ops[1] ?? "");
    if (/^(lb|lh|lw|lbu|lhu|sb|sh|sw)$/.test(m) && mem && k(mem[2]) !== undefined) out.set(i.addr, (k(mem[2])! + Number(mem[1])) >>> 0);
    const dst = ops[0];
    if (/^(sb|sh|sw|j|beqz|bnez|beq|bne|blt|bge|bltu|bgeu|ret|jr|ebreak|nop|fence|fence\.i|wfi|mret|ecall)$/.test(m)) {
      // No register written.
    } else if (m === "lui") known.set(dst, (Number(ops[1]) << 12) >>> 0);
    else if (m === "li") known.set(dst, Number(ops[1]) >>> 0);
    else if (m === "auipc") known.set(dst, (i.addr + (Number(ops[1]) << 12)) >>> 0);
    else if (m === "mv") {
      if (k(ops[1]) === undefined) known.delete(dst); else known.set(dst, k(ops[1])!);
    } else if (m === "addi" && ops.length === 3) {
      if (k(ops[1]) === undefined) known.delete(dst); else known.set(dst, (k(ops[1])! + Number(ops[2])) >>> 0);
    } else if (dst && /^[a-z]+\d*$/.test(dst)) known.delete(dst);
    if (m === "jal" || m === "jalr") for (const reg of callerSaved) known.delete(reg);
    if (m === "ret" || m === "j" || m === "jr") {
      known.clear();
      for (const [kk, v] of fixed) known.set(kk, v);
    }
  }
  return out;
}
