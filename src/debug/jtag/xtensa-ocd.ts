/**
 * Xtensa On-Chip Debug over the JTAG TAP (ESP32-S3, PRO_CPU). The debug module is
 * reached through two TAP registers: NAR selects a debug register, NDR reads or
 * writes it. Registers and memory are accessed by injecting instructions into the
 * halted core (DIR0EXEC) and moving data through DDR, as OpenOCD does.
 *
 * Not verified on hardware: the constants below follow the Xtensa OCD documentation
 * and OpenOCD's xtensa driver; the ones most likely to need adjusting are named.
 */
import { Tap, type Trace, UsbJtag } from "./usb-jtag";
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

// ESP32-S3 timer group 1 watchdog (the interrupt watchdog's timer).
const TIMG1_BASE = 0x60020000;
const TIMG1_WDTCONFIG0 = TIMG1_BASE + 0x48;
const TIMG1_WDTFEED = TIMG1_BASE + 0x60;
const TIMG1_WDTWPROTECT = TIMG1_BASE + 0x64;
const WDT_UNLOCK = 0x50d83aa1;
const WDT_EN = 0x80000000;

const RFDO_0 = 0xf1e000;
const SCRATCH_ADDR = 3; // a3 holds the address, a4 the data, while reading memory
const SCRATCH_DATA = 4;

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
const regName = (nar: number) =>
  ({ 0x40: "OCDID", 0x42: "DCRCLR", 0x43: "DCRSET", 0x44: "DSR", 0x45: "DDR", 0x47: "DIR0EXEC" } as Record<number, string>)[nar] ?? `NAR ${nar.toString(16)}`;
const dsrFlags = (v: number) =>
  [[DSR_EXECDONE, "ExecDone"], [DSR_EXECEXCEPTION, "ExecException"], [DSR_EXECBUSY, "ExecBusy"],
    [DSR_EXECOVERRUN, "ExecOverrun"], [DSR_STOPPED, "Stopped"]].filter(([m]) => v & (m as number)).map(([, n]) => n).join(" ") || "none";
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

  /** Log every layer of the conversation (OCD register access, TAP scans, raw USB transfers). */
  setTrace(trace: Trace | undefined): void {
    this.trace = trace;
    this.probe.trace = trace && ((l) => trace(`    ${l}`));
    this.tap.trace = trace && ((l) => trace(`  ${l}`));
  }

  private trace?: Trace;

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
    this.trace?.(`OCD IDCODEs on chain: ${ids.map(hex).join(", ")}`);
    this.tapCount = ids.length;
    this.tap.configure(ids.length, 0);
    // Power up the debug module and tell it JTAG is in use; the debug registers don't work before this.
    const wake = PWRCTL_COREWAKEUP | PWRCTL_MEMWAKEUP | PWRCTL_DEBUGWAKEUP;
    this.trace?.(`OCD PWRCTL <- ${hex(wake)} then ${hex(wake | PWRCTL_JTAGDEBUGUSE)}`);
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

  /** Debug-register accesses (NARSEL address scan + data scan each) sent in a single USB round trip. */
  private async nar(ops: { reg: number; write?: number }[]): Promise<number[]> {
    await this.select(IR_NARSEL);
    const scans = ops.flatMap((o) => [
      { value: (o.reg << 1) | (o.write === undefined ? 0 : 1), length: 8 },
      { value: (o.write ?? 0) >>> 0, length: 32 },
    ]);
    const out = await this.tap.shiftDRs(scans);
    return ops.map((o, i) => {
      const v = out[i * 2 + 1];
      this.trace?.(o.write === undefined
        ? `OCD read  ${regName(o.reg)} = ${hex(v)}${o.reg === NAR_DSR ? ` (${dsrFlags(v)})` : ""}`
        : `OCD write ${regName(o.reg)} = ${hex(o.write)}`);
      return v;
    });
  }

  private async dbg(reg: number, value: number): Promise<void> {
    await this.nar([{ reg, write: value }]);
  }

  private async dbgRead(reg: number): Promise<number> {
    return (await this.nar([{ reg }]))[0];
  }

  /**
   * Run one instruction on the halted core and wait for it to finish. Optionally the
   * DDR value to load first and a DDR read-back are part of the same USB transfer
   * (the core finishes far sooner than the next scan arrives); DSR is polled again
   * only if it still says busy.
   */
  private async exec(insn: number, ddr?: { write?: number; read?: boolean }): Promise<number> {
    this.trace?.(`OCD exec instruction ${hex(insn)}`);
    const ops: { reg: number; write?: number }[] = [];
    if (ddr?.write !== undefined) ops.push({ reg: NAR_DDR, write: ddr.write });
    ops.push({ reg: NAR_DIR0EXEC, write: insn }, { reg: NAR_DSR });
    if (ddr?.read) ops.push({ reg: NAR_DDR });
    const out = await this.nar(ops);
    let dsr = out[ddr?.write !== undefined ? 2 : 1];
    let value = ddr?.read ? out[out.length - 1] : 0;
    for (let i = 0; i < 100; i++) {
      if (dsr & (DSR_EXECEXCEPTION | DSR_EXECOVERRUN)) {
        await this.dbg(NAR_DSR, DSR_EXECEXCEPTION | DSR_EXECOVERRUN | DSR_EXECDONE);
        throw new Error(`The core raised an exception while the debugger ran instruction ${hex(insn)} (DSR ${hex(dsr)})`);
      }
      // As in OpenOCD, only ExecBusy is waited for; ExecDone stays set and isn't needed.
      if (!(dsr & DSR_EXECBUSY)) return value;
      [dsr, value] = ddr?.read ? await this.nar([{ reg: NAR_DSR }, { reg: NAR_DDR }]) : [await this.dbgRead(NAR_DSR), 0];
    }
    throw new Error(`Timed out waiting for the core to execute instruction ${hex(insn)} (DSR ${hex(dsr)})`);
  }

  private async readAr(n: number): Promise<number> {
    return this.exec(wsr(SR_DDR, n), { read: true }); // DDR = an
  }

  private async writeAr(n: number, value: number): Promise<void> {
    await this.exec(rsr(SR_DDR, n), { write: value }); // an = DDR
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

  // ---- the interrupt watchdog ----
  //
  // The core's halted, but the watchdog timers keep counting; a pause of ~300 ms would
  // reset the chip ("Interrupt wdt timeout"). So while halted we switch TIMG1's watchdog
  // (the one the interrupt watchdog uses) off, and put it back, fed, before resuming.

  private wdtHandled = false;
  private wdtSaved?: number;

  private async rawRead32(addr: number): Promise<number> {
    await this.writeAr(SCRATCH_ADDR, addr);
    await this.exec(l32i(SCRATCH_DATA, SCRATCH_ADDR, 0));
    return this.readAr(SCRATCH_DATA);
  }

  private async rawWrite32(addr: number, value: number): Promise<void> {
    await this.writeAr(SCRATCH_ADDR, addr);
    await this.writeAr(SCRATCH_DATA, value);
    await this.exec(s32i(SCRATCH_DATA, SCRATCH_ADDR, 0));
  }

  private async wdtSuspend(): Promise<void> {
    if (this.wdtHandled) return;
    this.wdtHandled = true;
    try {
      await this.writeArScratchSave();
      const cfg = await this.rawRead32(TIMG1_WDTCONFIG0);
      this.trace?.(`OCD TIMG1 WDTCONFIG0 = ${hex(cfg)}`);
      if (!(cfg & WDT_EN)) return;
      await this.rawWrite32(TIMG1_WDTWPROTECT, WDT_UNLOCK);
      await this.rawWrite32(TIMG1_WDTCONFIG0, cfg & ~WDT_EN);
      await this.rawWrite32(TIMG1_WDTWPROTECT, 0);
      this.wdtSaved = cfg;
    } catch (e) {
      this.trace?.(`OCD couldn't suspend the watchdog: ${(e as Error).message}`);
    }
  }

  private async wdtRestore(): Promise<void> {
    const cfg = this.wdtSaved;
    this.wdtSaved = undefined;
    this.wdtHandled = false;
    if (cfg === undefined) return;
    try {
      await this.writeArScratchSave();
      await this.rawWrite32(TIMG1_WDTWPROTECT, WDT_UNLOCK);
      await this.rawWrite32(TIMG1_WDTFEED, 1);
      await this.rawWrite32(TIMG1_WDTCONFIG0, cfg);
      await this.rawWrite32(TIMG1_WDTWPROTECT, 0);
    } catch (e) {
      this.trace?.(`OCD couldn't restore the watchdog: ${(e as Error).message}`);
    }
  }

  // ---- DebugTarget ----

  async isHalted(): Promise<boolean> {
    const stopped = !!((await this.dbgRead(NAR_DSR)) & DSR_STOPPED);
    if (stopped) await this.wdtSuspend(); // also when it stopped by itself (a breakpoint)
    return stopped;
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

  /** Breakpoints currently programmed in the core (IBREAKENABLE is 0 after a reset). */
  private applied: number[] = [];

  private async applyBreakpoints(): Promise<void> {
    if (this.breakpoints.length === this.applied.length && this.breakpoints.every((a, i) => a === this.applied[i])) return;
    let enable = 0;
    for (let i = 0; i < this.breakpoints.length; i++) {
      await this.writeSr(SR_IBREAKA0 + i, this.breakpoints[i]);
      enable |= 1 << i;
    }
    await this.writeSr(SR_IBREAKENABLE, enable);
    this.applied = [...this.breakpoints];
  }

  async resume(): Promise<void> {
    await this.applyBreakpoints();
    await this.leaveDebug();
  }

  async stepInstruction(): Promise<void> {
    await this.applyBreakpoints();
    await this.writeSr(SR_ICOUNTLEVEL, DEBUG_LEVEL);
    await this.writeSr(SR_ICOUNT, 0xfffffffe); // halts after one instruction
    await this.leaveDebug(false); // it halts again at once: keep the watchdog suspended
    if (await this.waitHalted()) return;
    throw new Error("The core didn't stop after a step");
  }

  private async leaveDebug(restoreWdt = true): Promise<void> {
    if (restoreWdt) await this.wdtRestore();
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
    const out = new Uint8Array(words * 4);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < words; i++) {
      if (i % 128 === 0) await this.writeAr(SCRATCH_ADDR, start + i * 4); // l32i's offset is at most 255 words
      await this.exec(l32i(SCRATCH_DATA, SCRATCH_ADDR, i % 128));
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
