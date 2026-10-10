/**
 * Xtensa On-Chip Debug over the JTAG TAP (ESP32-S3, PRO_CPU). The debug module is
 * reached through two TAP registers: NAR selects a debug register, NDR reads or
 * writes it. Registers and memory are accessed by injecting instructions into the
 * halted core (DIR0EXEC) and moving data through DDR, as OpenOCD does.
 *
 * Not verified on hardware: the constants below follow the Xtensa OCD documentation
 * and OpenOCD's xtensa driver; the ones most likely to need adjusting are named.
 */
import { Tap, UsbJtag } from "./usb-jtag";
import type { DebugTarget, Registers } from "./target";

// One TAP instruction, NARSEL, serves both steps: an 8-bit scan selects the register (address << 1 | write),
// then a 32-bit scan reads or writes it (OpenOCD's xtensa_debug_module.c).
const IR_NARSEL = 0x1c;
const IR_PWRCTL = 0x08;
// PWRCTL bits (8-bit register, own TAP instruction).
const PWRCTL_COREWAKEUP = 1 << 0;
const PWRCTL_MEMWAKEUP = 1 << 1;
const PWRCTL_DEBUGWAKEUP = 1 << 2;
const PWRCTL_JTAGDEBUGUSE = 1 << 7;
const IR_LENGTH = 5;

// NAR addresses of the debug registers.
const NAR_DCRCLR = 0x42;
const NAR_DCRSET = 0x43;
const NAR_DSR = 0x44;
const NAR_DDR = 0x45;
const NAR_DIR0EXEC = 0x47;

const DCR_ENABLEOCD = 1 << 0;
const DCR_DEBUGINTERRUPT = 1 << 1;
const DSR_EXECDONE = 1 << 0;
const DSR_EXECEXCEPTION = 1 << 1;
const DSR_EXECBUSY = 1 << 2;
const DSR_EXECOVERRUN = 1 << 3;
const DSR_STOPPED = 1 << 4;

// Special registers (SR numbers).
const SR_DDR = 104;
const SR_IBREAKENABLE = 96;
const SR_IBREAKA0 = 128;
const SR_ICOUNT = 236;
const SR_ICOUNTLEVEL = 237;
/** Interrupt level the debug exception runs at; its EPC holds the PC of a halted core. */
const DEBUG_LEVEL = 6;
const SR_EPC_DEBUG = 176 + DEBUG_LEVEL;

const RFDO_0 = 0xf1e000;
const SCRATCH_ADDR = 3; // a3 holds the address, a4 the data, while reading memory
const SCRATCH_DATA = 4;

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
const rsr = (sr: number, t: number) => 0x030000 | (sr << 8) | (t << 4);
const wsr = (sr: number, t: number) => 0x130000 | (sr << 8) | (t << 4);
const rri8 = (op: number, imm8: number, s: number, t: number) => (imm8 << 16) | (op << 12) | (s << 8) | (t << 4) | 2;
const l32i = (t: number, s: number, offsetWords: number) => rri8(2, offsetWords, s, t);
const s32i = (t: number, s: number, offsetWords: number) => rri8(6, offsetWords, s, t);
const addi4 = (t: number, s: number) => rri8(0xc, 4, s, t);

export class XtensaOcd implements DebugTarget {
  readonly name = "ESP32-S3 (Xtensa OCD over USB-JTAG)";
  idcode = 0;
  private tapCount = 1;
  private readonly probe = new UsbJtag();
  private readonly tap = new Tap(this.probe, IR_LENGTH);
  private breakpoints: number[] = [];
  private saved?: { a3: number; a4: number };
  private irSelected = -1;

  async connect(): Promise<void> {
    await this.probe.connect();
    await this.tap.reset();
    this.irSelected = -1;
    const ids = await this.tap.readIdcodes();
    if (!ids.length) {
      await this.probe.disconnect();
      throw new Error("No TAP answered on the JTAG chain. Is the chip running, and is this its native USB port?");
    }
    // The ESP32-S3 has one TAP per core (both with IDCODE 0x120034e5); the first is the PRO_CPU.
    this.idcode = ids[0];
    this.tapCount = ids.length;
    this.tap.configure(ids.length, 0);
    // Power up the debug module and tell it JTAG is in use; the debug registers don't work before this.
    const wake = PWRCTL_COREWAKEUP | PWRCTL_MEMWAKEUP | PWRCTL_DEBUGWAKEUP;
    await this.select(IR_PWRCTL);
    await this.tap.shiftDR(wake, 8);
    await this.tap.shiftDR(wake | PWRCTL_JTAGDEBUGUSE, 8);
    this.irSelected = IR_PWRCTL;
    await this.dbg(NAR_DCRSET, DCR_ENABLEOCD);
    const id = await this.dbgRead(0x40); // OCDID
    if (id === 0 || id === 0xffffffff) {
      await this.probe.disconnect();
      throw new Error(`The debug module didn't answer (OCDID ${hex(id)}).`);
    }
  }

  async disconnect(): Promise<void> {
    if (this.probe.connected) {
      if (await this.isHalted().catch(() => false)) await this.resume().catch(() => {});
      await this.probe.disconnect();
    }
  }

  get description(): string {
    return this.probe.description;
  }

  // ---- debug registers (NAR/NDR) ----

  private async select(ir: number): Promise<void> {
    if (this.irSelected !== ir) await this.tap.shiftIR(ir);
    this.irSelected = ir;
  }

  private async dbg(reg: number, value: number): Promise<void> {
    await this.select(IR_NARSEL);
    await this.tap.shiftDR((reg << 1) | 1, 8);
    await this.tap.shiftDR(value >>> 0, 32);
  }

  private async dbgRead(reg: number): Promise<number> {
    await this.select(IR_NARSEL);
    await this.tap.shiftDR(reg << 1, 8);
    return this.tap.shiftDR(0, 32);
  }

  /** Run one instruction on the halted core and wait for it to finish. */
  private async exec(insn: number): Promise<void> {
    await this.dbg(NAR_DIR0EXEC, insn);
    for (let i = 0; i < 100; i++) {
      const dsr = await this.dbgRead(NAR_DSR);
      if (dsr & (DSR_EXECEXCEPTION | DSR_EXECOVERRUN)) {
        await this.dbg(NAR_DSR, DSR_EXECEXCEPTION | DSR_EXECOVERRUN | DSR_EXECDONE);
        throw new Error("The core raised an exception while the debugger ran an instruction");
      }
      if (!(dsr & DSR_EXECBUSY) && dsr & DSR_EXECDONE) {
        await this.dbg(NAR_DSR, DSR_EXECDONE);
        return;
      }
    }
    throw new Error("Timed out waiting for the core to execute an instruction");
  }

  private async readAr(n: number): Promise<number> {
    await this.exec(wsr(SR_DDR, n)); // DDR = an
    return this.dbgRead(NAR_DDR);
  }

  private async writeAr(n: number, value: number): Promise<void> {
    await this.dbg(NAR_DDR, value);
    await this.exec(rsr(SR_DDR, n)); // an = DDR
  }

  private async readSr(sr: number): Promise<number> {
    await this.writeArScratchSave();
    await this.exec(rsr(sr, SCRATCH_ADDR));
    return this.readAr(SCRATCH_ADDR);
  }

  private async writeSr(sr: number, value: number): Promise<void> {
    await this.writeArScratchSave();
    await this.writeAr(SCRATCH_ADDR, value);
    await this.exec(wsr(sr, SCRATCH_ADDR));
  }

  /** Remember a3 and a4 before using them, so the program sees them unchanged on resume. */
  private async writeArScratchSave(): Promise<void> {
    if (this.saved) return;
    this.saved = { a3: await this.readAr(SCRATCH_ADDR), a4: await this.readAr(SCRATCH_DATA) };
  }

  private async restoreScratch(): Promise<void> {
    if (!this.saved) return;
    const { a3, a4 } = this.saved;
    this.saved = undefined;
    await this.writeAr(SCRATCH_ADDR, a3);
    await this.writeAr(SCRATCH_DATA, a4);
  }

  // ---- DebugTarget ----

  async isHalted(): Promise<boolean> {
    return !!((await this.dbgRead(NAR_DSR)) & DSR_STOPPED);
  }

  async halt(): Promise<void> {
    if (await this.isHalted()) return;
    await this.dbg(NAR_DCRSET, DCR_ENABLEOCD | DCR_DEBUGINTERRUPT);
    if (await this.waitHalted()) {
      await this.dbg(NAR_DCRCLR, DCR_DEBUGINTERRUPT);
      return;
    }
    throw new Error(`The core didn't stop (DSR ${hex(await this.dbgRead(NAR_DSR))}, ${this.tapCount} TAPs on the chain, IDCODE ${hex(this.idcode)})`);
  }

  /** Poll until the core stops (up to ~1 s). */
  private async waitHalted(): Promise<boolean> {
    for (const deadline = Date.now() + 1000; Date.now() < deadline;) {
      if (await this.isHalted()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  setBreakpoints(addrs: number[]): void {
    this.breakpoints = addrs.slice(0, 2);
  }

  private async applyBreakpoints(): Promise<void> {
    let enable = 0;
    for (let i = 0; i < this.breakpoints.length; i++) {
      await this.writeSr(SR_IBREAKA0 + i, this.breakpoints[i]);
      enable |= 1 << i;
    }
    await this.writeSr(SR_IBREAKENABLE, enable);
  }

  async resume(): Promise<void> {
    await this.applyBreakpoints();
    await this.leaveDebug();
  }

  async stepInstruction(): Promise<void> {
    await this.applyBreakpoints();
    await this.writeSr(SR_ICOUNTLEVEL, DEBUG_LEVEL);
    await this.writeSr(SR_ICOUNT, 0xfffffffe); // halts after one instruction
    await this.leaveDebug();
    if (await this.waitHalted()) return;
    throw new Error("The core didn't stop after a step");
  }

  private async leaveDebug(): Promise<void> {
    await this.restoreScratch();
    await this.dbg(NAR_DCRCLR, DCR_DEBUGINTERRUPT);
    await this.dbg(NAR_DSR, 0xffffffff);
    await this.dbg(NAR_DIR0EXEC, RFDO_0);
  }

  readPc(): Promise<number> {
    return this.readSr(SR_EPC_DEBUG);
  }

  async readRegisters(): Promise<Registers> {
    await this.writeArScratchSave(); // a3/a4 may be in use as scratch; their program values are in `saved`
    const ar: number[] = [];
    for (let i = 0; i < 16; i++) {
      ar.push(i === SCRATCH_ADDR ? this.saved!.a3 : i === SCRATCH_DATA ? this.saved!.a4 : await this.readAr(i));
    }
    return { pc: await this.readPc(), ar };
  }

  async readMemory(addr: number, length: number): Promise<Uint8Array> {
    const start = addr & ~3;
    const words = Math.ceil((addr + length - start) / 4);
    await this.writeArScratchSave();
    await this.writeAr(SCRATCH_ADDR, start);
    const out = new Uint8Array(words * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < words; i++) {
      await this.exec(l32i(SCRATCH_DATA, SCRATCH_ADDR, 0));
      await this.exec(addi4(SCRATCH_ADDR, SCRATCH_ADDR));
      dv.setUint32(i * 4, await this.readAr(SCRATCH_DATA), true);
    }
    return out.subarray(addr - start, addr - start + length);
  }

  async writeMemory(addr: number, data: Uint8Array): Promise<void> {
    const start = addr & ~3;
    const words = Math.ceil((addr + data.length - start) / 4);
    const merged = await this.readMemory(start, words * 4);
    const copy = new Uint8Array(merged);
    copy.set(data, addr - start);
    const dv = new DataView(copy.buffer);
    await this.writeAr(SCRATCH_ADDR, start);
    for (let i = 0; i < words; i++) {
      await this.writeAr(SCRATCH_DATA, dv.getUint32(i * 4, true));
      await this.exec(s32i(SCRATCH_DATA, SCRATCH_ADDR, 0));
      await this.exec(addi4(SCRATCH_ADDR, SCRATCH_ADDR));
    }
  }
}
