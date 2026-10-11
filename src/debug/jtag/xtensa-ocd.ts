/**
 * Xtensa On-Chip Debug over the JTAG TAP (ESP32-S3, both cores). The debug module is
 * reached through two TAP registers: NAR selects a debug register, NDR reads or
 * writes it. Registers and memory are accessed by injecting instructions into the
 * halted core (DIR0EXEC) and moving data through DDR, as OpenOCD does.
 *
 * Like OpenOCD's SMP mode, both cores stop and start together: Arduino runs loop() on
 * core 1 while Wi-Fi, Bluetooth and the RTOS timers run on core 0, and a core left
 * running while the other is halted can spin on a lock the halted one holds.
 *
 * Not verified on hardware: the constants below follow the Xtensa OCD documentation
 * and OpenOCD's xtensa and esp32s3 drivers.
 */
import { Tap, type Trace, UsbJtag } from "./usb-jtag";
import type { DebugTarget, Registers, StopCause } from "./target";

// One TAP instruction, NARSEL, serves both steps: an 8-bit scan selects the register (address << 1 | write),
// then a 32-bit scan reads or writes it (OpenOCD's xtensa_debug_module.c).
const IR_NARSEL = 0x1c;
const IR_PWRCTL = 0x08;
const IR_PWRSTAT = 0x09;
// PWRSTAT bits (8-bit, sticky; writing a 1 clears them). OpenOCD's PWRSTAT_*WASRESET_V0.
const PWRSTAT_COREWASRESET = 1 << 4;
const PWRSTAT_DEBUGWASRESET = 1 << 6;
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
/**
 * The ESP32-S3 links its cores (both set at reset): a core in debug mode raises DebugModeOut,
 * which stalls the other through its RunStallIn. That keeps the program frozen as a whole
 * when one core stops, but a single step of one core needs its RunStallIn off while the other
 * stays halted (OpenOCD's esp_xtensa_smp_smpbreak_disable does the same).
 */
const DCR_RUNSTALLINEN = 1 << 21;
const DSR_EXECDONE = 1 << 0;
const DSR_EXECEXCEPTION = 1 << 1;
const DSR_EXECBUSY = 1 << 2;
const DSR_EXECOVERRUN = 1 << 3;
const DSR_STOPPED = 1 << 4;

// Special registers (SR numbers).
const SR_DDR = 104;
const SR_IBREAKENABLE = 96;
const SR_IBREAKA0 = 128;
const SR_DEBUGCAUSE = 233;
const SR_CCOUNT = 234;
const SR_ICOUNT = 236;
const SR_ICOUNTLEVEL = 237;
// DEBUGCAUSE bits.
const CAUSE_ICOUNT = 1 << 0;
const CAUSE_IBREAK = 1 << 1;
const CAUSE_DBREAK = 1 << 2;
const CAUSE_BREAK = 1 << 3;
const CAUSE_BREAKN = 1 << 4;
const CAUSE_DEBUGINT = 1 << 5;
/** Interrupt level the debug exception runs at; its EPC holds the PC of a halted core. */
const DEBUG_LEVEL = 6;
const SR_EPC_DEBUG = 176 + DEBUG_LEVEL;
/** The program's PS while halted; RFDO restores it. */
const SR_EPS_DEBUG = 192 + DEBUG_LEVEL;
const PS_INTLEVEL = 0xf;
/** Interrupt level used while stepping: masks every interrupt the step could land in, but ICOUNT still counts. */
const STEP_INTLEVEL = DEBUG_LEVEL - 1;

// ---- watchdogs (as OpenOCD's esp32s3_disable_wdts) ----
// A halted core can't feed or service any of them, and two reset the whole chip outright
// (the task watchdog's second stage, and the RTC watchdog). While halted they're switched
// off; on resume they're fed and put back as the program had them.
const WDT_KEY = 0x50d83aa1;
const WDT_EN = 0x80000000;
/** TIMG WDTCONFIG0: latch the new configuration (the S3's timer groups need it). */
const TIMG_WDT_CONF_UPDATE = 1 << 22;
interface Watchdog { name: string; config: number; protect: number; feed: number; feedValue: number; update: number }
const timg = (base: number, name: string): Watchdog =>
  ({ name, config: base + 0x48, protect: base + 0x64, feed: base + 0x60, feedValue: 1, update: TIMG_WDT_CONF_UPDATE });
const WATCHDOGS: Watchdog[] = [
  timg(0x6001f000, "task watchdog (TIMG0)"),
  timg(0x60020000, "interrupt watchdog (TIMG1)"),
  { name: "RTC watchdog", config: 0x60008098, protect: 0x600080b0, feed: 0x600080ac, feedValue: 1 << 31, update: 0 },
];
/** The super watchdog can't be switched off, only fed automatically. */
const SWD_CONF = 0x600080b4;
const SWD_PROTECT = 0x600080b8;
const SWD_KEY = 0x8f1d312a;
const SWD_AUTO_FEED = 1 << 31;

const SR_WINDOWBASE = 72;
const SR_WINDOWSTART = 73;
/** ROTW n: rotate the register window by n * 4 registers (OpenOCD's XT_INS_ROTW). */
const rotw = (n: number) => 0x408000 | ((n & 15) << 4);

const RFDO_0 = 0xf1e000;
const SCRATCH_ADDR = 3; // a3 holds the address, a4 the data, while reading memory
const SCRATCH_DATA = 4;

const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");

/**
 * Address ranges a data load can reach on the ESP32-S3. Anything else would make the debugger's
 * l32i raise an exception inside the halted core, so it's refused before touching the chip.
 */
const READABLE: [number, number][] = [
  [0x3c000000, 0x3e000000], // external flash/PSRAM, data cache
  [0x3fc88000, 0x3fd00000], // internal SRAM (data bus)
  [0x3ff00000, 0x3ff20000], // ROM (data bus)
  [0x40000000, 0x40060000], // ROM
  [0x40370000, 0x403e0000], // internal SRAM (instruction bus)
  [0x42000000, 0x44000000], // external flash, instruction cache
  [0x50000000, 0x50002000], // RTC slow memory
  [0x60000000, 0x60100000], // peripherals and RTC fast memory
];
const readable = (addr: number, length: number) =>
  READABLE.some(([lo, hi]) => addr >= lo && addr + length <= hi);
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

/** One step of a batch run by `run()`: load DDR, execute an instruction, or read DDR. */
type Step = { ddr: number } | { insn: number } | { read: true };
const ddrToAr = (n: number): Step => ({ insn: rsr(SR_DDR, n) });
const arToDdr = (n: number): Step => ({ insn: wsr(SR_DDR, n) });
const READ: Step = { read: true };

interface Core {
  /** Position on the JTAG chain. */
  tap: number;
  /** As of the last check. */
  halted: boolean;
  /** The program's a3/a4, while the debugger uses them as scratch. */
  saved?: { a3: number; a4: number };
  /** Breakpoints currently programmed in this core (IBREAKENABLE is 0 after a reset). */
  applied: number[];
  /**
   * Whether ICOUNTLEVEL is set for single-stepping (undefined: unknown, an earlier session may
   * have left it). It must be cleared before the core runs freely, or it stops at once again.
   */
  stepping?: boolean;
  /** DCR as found at connect. */
  dcr: number;
  /** RunStallIn is switched off for single-stepping; switched back on at resume. */
  unstalled?: boolean;
}

export class XtensaOcd implements DebugTarget {
  readonly name = "ESP32-S3 (Xtensa OCD over USB-JTAG)";
  idcode = 0;
  private readonly probe = new UsbJtag();
  private readonly tap = new Tap(this.probe, IR_LENGTH);
  private breakpoints: number[] = [];
  private cores: Core[] = [];
  private cur = 0;
  private irSelected = -1;
  /** The adapter's `resets` count the TAP was last set up for. */
  private linkGeneration = 0;
  /** Consecutive polls that saw a reset flag; a flag that won't clear isn't trusted. */
  private resetFlagStreak = 0;
  /** The core that stopped first on its own (breakpoint, crash), for the latest stop. */
  stoppedCore?: number;
  onLost?: (reason: string) => void;
  onReset?: () => void;

  /** Log every layer of the conversation (OCD register access, TAP scans, raw USB transfers). */
  setTrace(trace: Trace | undefined): void {
    this.trace = trace;
    this.probe.trace = trace && ((l) => trace(`    ${l}`));
    this.tap.trace = trace && ((l) => trace(`  ${l}`));
  }

  private trace?: Trace;

  get coreCount(): number {
    return this.cores.length;
  }

  get core(): number {
    return this.cur;
  }

  /** Point register, memory and step operations at this core. */
  selectCore(i: number): void {
    if (i === this.cur || !this.cores[i]) return;
    this.cur = i;
    this.tap.configure(this.tapCount, this.cores[i].tap);
    this.irSelected = -1;
  }

  private tapCount = 1;
  private get c(): Core {
    return this.cores[this.cur];
  }

  async connect(quiet = false): Promise<void> {
    this.probe.onLost = (reason) => this.onLost?.(reason);
    await this.probe.connect(quiet);
    try {
      try {
        await this.init();
      } catch (e) {
        // Leftovers of an earlier session in the adapter's buffers are the usual cause: start clean once.
        this.trace?.(`OCD first attempt failed (${(e as Error).message}); retrying on a fresh link`);
        await this.probe.recover();
        await this.init();
      }
    } catch (e) {
      await this.probe.disconnect();
      throw e;
    }
  }

  /** Find the TAPs (one per core) and switch their debug modules on. */
  private async init(): Promise<void> {
    this.linkGeneration = this.probe.resets;
    await this.tap.reset();
    this.irSelected = -1;
    const ids = await this.tap.readIdcodes();
    if (!ids.length) throw new Error("No TAP answered on the JTAG chain. Is the chip running, and is this its native USB port?");
    // The ESP32-S3 has one TAP per core (both with IDCODE 0x120034e5); the first is the PRO_CPU (core 0).
    this.idcode = ids[0];
    this.trace?.(`OCD IDCODEs on chain: ${ids.map(hex).join(", ")}`);
    this.tapCount = ids.length;
    this.cores = [];
    for (let i = 0; i < ids.length; i++) {
      this.cores.push({ tap: i, halted: false, applied: [], dcr: 0 });
      this.cur = -1;
      this.selectCore(i);
      await this.powerUp();
      await this.readResetFlags(); // the chip did reset at boot; that one isn't news
      const id = await this.dbgRead(0x40); // OCDID
      const [dcr] = await this.nar([{ reg: NAR_DCRSET }]);
      this.cores[i].dcr = dcr;
      this.trace?.(`OCD core ${i} DCR = ${hex(dcr)}`);
      if (id === 0 || id === 0xffffffff) {
        if (i === 0) throw new Error(`The debug module didn't answer (OCDID ${hex(id)}).`);
        this.trace?.(`OCD core ${i} didn't answer (OCDID ${hex(id)}); debugging core 0 only`);
        this.cores.pop();
        break;
      }
    }
    this.cur = -1;
    this.selectCore(0);
  }

  /**
   * Power up this core's debug module and tell it JTAG is in use; the debug registers don't work
   * before this. ENABLEOCD also tells ESP-IDF a debugger is attached: a crash (panic, watchdog)
   * then stops the core for us to look at instead of rebooting.
   */
  private async powerUp(): Promise<void> {
    const wake = PWRCTL_COREWAKEUP | PWRCTL_MEMWAKEUP | PWRCTL_DEBUGWAKEUP;
    this.trace?.(`OCD core ${this.cur} PWRCTL <- ${hex(wake)} then ${hex(wake | PWRCTL_JTAGDEBUGUSE)}`);
    await this.select(IR_PWRCTL);
    await this.tap.shiftDR(wake, 8);
    await this.tap.shiftDR(wake | PWRCTL_JTAGDEBUGUSE, 8);
    await this.dbg(NAR_DCRSET, DCR_ENABLEOCD);
  }

  /** Read and clear PWRSTAT's sticky reset flags (one scan does both). */
  private async readResetFlags(): Promise<number> {
    await this.select(IR_PWRSTAT);
    const stat = await this.tap.shiftDR(PWRSTAT_COREWASRESET | PWRSTAT_DEBUGWASRESET, 8);
    return stat & (PWRSTAT_COREWASRESET | PWRSTAT_DEBUGWASRESET);
  }

  /**
   * Whether the chip reset since the last check. A reset clears the debug modules and the
   * cores' breakpoints, and whatever this class remembers about halted cores is stale.
   */
  private async checkReset(): Promise<boolean> {
    if (this.resetFlagStreak >= 3) return false;
    const flags = await this.onCore(0, () => this.readResetFlags());
    if (!flags) {
      this.resetFlagStreak = 0;
      return false;
    }
    if (++this.resetFlagStreak === 3) this.trace?.("OCD PWRSTAT reset flags won't clear; not watching for resets any more");
    this.trace?.(`OCD the chip reset (PWRSTAT ${flags & PWRSTAT_COREWASRESET ? "CoreWasReset " : ""}${flags & PWRSTAT_DEBUGWASRESET ? "DebugWasReset" : ""})`);
    for (const [i, core] of this.cores.entries()) {
      core.saved = undefined;
      core.applied = [];
      core.halted = false;
      core.stepping = undefined;
      core.unstalled = false;
      await this.onCore(i, async () => {
        await this.powerUp();
        // A core that was halted when the reset came is held at the reset vector: a reset
        // means "start over", so let it run.
        if ((await this.dbgRead(NAR_DSR)) & DSR_STOPPED) {
          this.trace?.(`OCD core ${i} came out of the reset halted; letting it run`);
          core.halted = true;
          await this.leaveDebug();
        }
      });
    }
    this.wdtSaved = undefined;
    this.swdSaved = undefined;
    this.stoppedCore = undefined;
    this.onReset?.();
    return true;
  }

  /** While paused: whether the chip was reset meanwhile (it then runs again, from the start). */
  async checkRestarted(): Promise<boolean> {
    return this.checkReset();
  }

  /**
   * A core whose debug module didn't answer at connect (core 1 is held in reset until the app
   * starts it, e.g. while the chip was booting) is taken on once it does: until then ESP-IDF on
   * it wouldn't know a debugger is attached, and a crash there would reboot instead of stopping.
   */
  private async addLateCores(): Promise<void> {
    if (this.cores.length >= this.tapCount || Date.now() < this.lateCoreCheck) return;
    this.lateCoreCheck = Date.now() + 500;
    const i = this.cores.length;
    this.cores.push({ tap: i, halted: false, applied: [], dcr: 0 });
    const ok = await this.onCore(i, async () => {
      await this.powerUp();
      const id = await this.dbgRead(0x40);
      if (id === 0 || id === 0xffffffff) return false;
      this.cores[i].dcr = (await this.nar([{ reg: NAR_DCRSET }]))[0];
      return true;
    }).catch(() => false);
    if (ok) this.trace?.(`OCD core ${i} answers now; debugging it too`);
    else this.cores.pop();
  }

  private lateCoreCheck = 0;

  /** Run `action` against core `i`, then go back to the current one. */
  private async onCore<T>(i: number, action: () => Promise<T>): Promise<T> {
    const prev = this.cur;
    this.selectCore(i);
    try {
      return await action();
    } finally {
      this.selectCore(prev);
    }
  }

  async disconnect(): Promise<void> {
    this.probe.onLost = undefined;
    if (this.probe.connected) {
      if (await this.isHalted().catch(() => false)) {
        // After a crash, the other core is stalled: the next reset (a re-flash, say) would loop.
        await this.clearCpuStalls().catch(() => {});
        await this.resume().catch(() => {});
      }
      await this.probe.disconnect();
    }
  }

  get description(): string {
    return this.probe.description;
  }

  // ---- debug registers (NAR/NDR) ----

  private async select(ir: number): Promise<void> {
    if (this.linkGeneration !== this.probe.resets) {
      // The USB link was re-opened mid-conversation: the TAPs may be in any state.
      this.linkGeneration = this.probe.resets;
      this.trace?.("OCD re-synchronising the TAPs after a USB error");
      await this.tap.reset();
      const cur = this.cur;
      for (let i = 0; i < this.cores.length; i++) {
        this.cur = -1;
        this.selectCore(i);
        await this.powerUp();
      }
      this.cur = -1;
      this.selectCore(cur);
    }
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
   * Run one instruction on the halted core and wait for it to finish, polling DSR while it
   * says busy. The careful path; `run()` batches and falls back to this.
   */
  private async exec(insn: number): Promise<void> {
    this.trace?.(`OCD exec instruction ${hex(insn)}`);
    let dsr = (await this.nar([{ reg: NAR_DIR0EXEC, write: insn }, { reg: NAR_DSR }]))[1];
    for (let i = 0; i < 100; i++) {
      if (dsr & (DSR_EXECEXCEPTION | DSR_EXECOVERRUN)) {
        await this.dbg(NAR_DSR, DSR_EXECEXCEPTION | DSR_EXECOVERRUN | DSR_EXECDONE);
        throw new Error(`The core raised an exception while the debugger ran instruction ${hex(insn)} (DSR ${hex(dsr)})`);
      }
      // As in OpenOCD, only ExecBusy is waited for; ExecDone stays set and isn't needed.
      if (!(dsr & DSR_EXECBUSY)) return;
      dsr = await this.dbgRead(NAR_DSR);
    }
    throw new Error(`Timed out waiting for the core to execute instruction ${hex(insn)} (DSR ${hex(dsr)})`);
  }

  /**
   * Run a sequence of DDR loads, instructions and DDR reads in one go, returning what was read.
   * The core finishes each instruction long before the next scan reaches it (a scan takes
   * ~25 µs at 2 MHz), so DSR is checked once at the end: if an instruction was still busy
   * (ExecOverrun), the sequence is replayed one careful step at a time. Every sequence used
   * here only loads, stores and moves registers, so replaying it is harmless.
   */
  private async run(steps: Step[]): Promise<number[]> {
    const ops = steps.map((s) => ("ddr" in s ? { reg: NAR_DDR, write: s.ddr } : "insn" in s ? { reg: NAR_DIR0EXEC, write: s.insn } : { reg: NAR_DDR }));
    ops.push({ reg: NAR_DSR });
    const out = await this.nar(ops);
    const dsr = out[out.length - 1];
    if (dsr & DSR_EXECEXCEPTION) {
      await this.dbg(NAR_DSR, DSR_EXECEXCEPTION | DSR_EXECOVERRUN | DSR_EXECDONE);
      throw new Error(`The core raised an exception while the debugger ran instructions (DSR ${hex(dsr)})`);
    }
    if (!(dsr & (DSR_EXECBUSY | DSR_EXECOVERRUN))) return out.filter((_, i) => i < steps.length && "read" in steps[i]);
    this.trace?.(`OCD batch not finished in time (DSR ${dsrFlags(dsr)}); replaying step by step`);
    if (dsr & DSR_EXECOVERRUN) await this.dbg(NAR_DSR, DSR_EXECOVERRUN | DSR_EXECDONE);
    const reads: number[] = [];
    for (const s of steps) {
      if ("ddr" in s) await this.dbg(NAR_DDR, s.ddr);
      else if ("insn" in s) await this.exec(s.insn);
      else reads.push(await this.dbgRead(NAR_DDR));
    }
    return reads;
  }

  private async readAr(n: number): Promise<number> {
    return (await this.run([arToDdr(n), READ]))[0];
  }

  private async writeAr(n: number, value: number): Promise<void> {
    await this.run([{ ddr: value }, ddrToAr(n)]);
  }

  private async readSr(sr: number): Promise<number> {
    await this.saveScratch();
    return (await this.run([{ insn: rsr(sr, SCRATCH_ADDR) }, arToDdr(SCRATCH_ADDR), READ]))[0];
  }

  private async writeSr(sr: number, value: number): Promise<void> {
    await this.saveScratch();
    await this.run([{ ddr: value }, ddrToAr(SCRATCH_ADDR), { insn: wsr(sr, SCRATCH_ADDR) }]);
  }

  /** Remember a3 and a4 before using them, so the program sees them unchanged on resume. */
  private async saveScratch(): Promise<void> {
    if (this.c.saved) return;
    const [a3, a4] = await this.run([arToDdr(SCRATCH_ADDR), READ, arToDdr(SCRATCH_DATA), READ]);
    this.c.saved = { a3, a4 };
  }

  private async restoreScratch(): Promise<void> {
    const saved = this.c.saved;
    if (!saved) return;
    this.c.saved = undefined;
    await this.run([{ ddr: saved.a3 }, ddrToAr(SCRATCH_ADDR), { ddr: saved.a4 }, ddrToAr(SCRATCH_DATA)]);
  }

  // ---- the watchdogs ----

  /** The configuration of each watchdog that was switched off, to put back on resume. */
  private wdtSaved?: { wdt: Watchdog; cfg: number }[];
  private swdSaved?: number;

  private async rawRead32(addr: number): Promise<number> {
    await this.saveScratch();
    return (await this.run([{ ddr: addr }, ddrToAr(SCRATCH_ADDR), { insn: l32i(SCRATCH_DATA, SCRATCH_ADDR, 0) }, arToDdr(SCRATCH_DATA), READ]))[0];
  }

  private async rawWrite32(addr: number, value: number): Promise<void> {
    await this.saveScratch();
    await this.run([{ ddr: addr }, ddrToAr(SCRATCH_ADDR), { ddr: value }, ddrToAr(SCRATCH_DATA), { insn: s32i(SCRATCH_DATA, SCRATCH_ADDR, 0) }]);
  }

  private async wdtSuspend(): Promise<void> {
    if (this.wdtSaved) return;
    this.wdtSaved = [];
    for (const wdt of WATCHDOGS) {
      try {
        const cfg = await this.rawRead32(wdt.config);
        this.trace?.(`OCD ${wdt.name} config = ${hex(cfg)}`);
        if (!(cfg & WDT_EN)) continue;
        await this.rawWrite32(wdt.protect, WDT_KEY);
        await this.rawWrite32(wdt.config, wdt.update);
        await this.rawWrite32(wdt.protect, 0);
        this.wdtSaved.push({ wdt, cfg });
      } catch (e) {
        this.trace?.(`OCD couldn't switch off the ${wdt.name}: ${(e as Error).message}`);
      }
    }
    try {
      const swd = await this.rawRead32(SWD_CONF);
      if (!(swd & SWD_AUTO_FEED)) {
        await this.rawWrite32(SWD_PROTECT, SWD_KEY);
        await this.rawWrite32(SWD_CONF, swd | SWD_AUTO_FEED);
        await this.rawWrite32(SWD_PROTECT, 0);
        this.swdSaved = swd;
      }
    } catch (e) {
      this.trace?.(`OCD couldn't set the super watchdog to feed itself: ${(e as Error).message}`);
    }
  }

  private async wdtRestore(): Promise<void> {
    const saved = this.wdtSaved;
    this.wdtSaved = undefined;
    for (const { wdt, cfg } of saved ?? []) {
      try {
        await this.rawWrite32(wdt.protect, WDT_KEY);
        await this.rawWrite32(wdt.feed, wdt.feedValue);
        await this.rawWrite32(wdt.config, cfg | wdt.update);
        await this.rawWrite32(wdt.protect, 0);
      } catch (e) {
        this.trace?.(`OCD couldn't restore the ${wdt.name}: ${(e as Error).message}`);
      }
    }
    const swd = this.swdSaved;
    this.swdSaved = undefined;
    if (swd !== undefined) {
      try {
        await this.rawWrite32(SWD_PROTECT, SWD_KEY);
        await this.rawWrite32(SWD_CONF, swd);
        await this.rawWrite32(SWD_PROTECT, 0);
      } catch (e) {
        this.trace?.(`OCD couldn't restore the super watchdog: ${(e as Error).message}`);
      }
    }
  }

  // ---- run control ----

  /**
   * Whether the program is stopped. When a core stops by itself (a breakpoint, a crash), the
   * others are stopped too, and that core becomes the current one.
   */
  async isHalted(): Promise<boolean> {
    const anyBefore = this.cores.some((c) => c.halted);
    const newly: number[] = [];
    for (const [i, core] of this.cores.entries()) {
      if (core.halted) continue;
      const dsr = await this.onCore(i, () => this.dbgRead(NAR_DSR));
      if (dsr & DSR_STOPPED) {
        core.halted = true;
        newly.push(i);
      }
    }
    if (!this.cores.some((c) => c.halted)) {
      // A running chip can reset (watchdog, panic, reset button); a halted one can't.
      if (await this.checkReset()) return this.isHalted();
      return false;
    }
    if (!this.cores.some((c) => c.halted)) await this.addLateCores();
    // Every core already stopped (say, left paused by an earlier session): nobody stopped "first".
    if (!anyBefore && newly.length === this.cores.length) this.stoppedCore = undefined;
    else if (!anyBefore && newly.length) {
      this.stoppedCore = newly[0];
      this.trace?.(`OCD core ${newly[0]} stopped by itself; stopping the others`);
      await this.haltCores(this.cores.map((c, i) => (c.halted ? -1 : i)).filter((i) => i >= 0));
      this.selectCore(newly[0]);
    }
    if (this.c.halted) await this.wdtSuspend();
    return true;
  }

  async halt(): Promise<void> {
    if (await this.isHalted()) return;
    this.stoppedCore = undefined;
    await this.haltCores(this.cores.map((_, i) => i));
    await this.wdtSuspend();
  }

  /** Raise the debug interrupt on these cores and wait (up to ~1 s) for all of them to stop. */
  private async haltCores(which: number[]): Promise<void> {
    for (const i of which) await this.onCore(i, () => this.dbg(NAR_DCRSET, DCR_ENABLEOCD | DCR_DEBUGINTERRUPT));
    for (const deadline = Date.now() + 1000; ;) {
      let all = true;
      for (const i of which) {
        if (this.cores[i].halted) continue;
        const dsr = await this.onCore(i, () => this.dbgRead(NAR_DSR));
        if (dsr & DSR_STOPPED) {
          this.cores[i].halted = true;
          await this.onCore(i, () => this.dbg(NAR_DCRCLR, DCR_DEBUGINTERRUPT));
        } else all = false;
      }
      if (all) return;
      if (Date.now() > deadline) {
        const stuck = which.filter((i) => !this.cores[i].halted);
        throw new Error(`Core ${stuck.join(" and ")} didn't stop (${this.cores.length} cores on the chain, IDCODE ${hex(this.idcode)})`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Poll until the current core stops (up to ~1 s). */
  private async waitHalted(): Promise<boolean> {
    for (const deadline = Date.now() + 1000; Date.now() < deadline;) {
      if (await this.isHalted() && this.c.halted) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return false;
  }

  async stopCause(): Promise<StopCause> {
    const cause = await this.readSr(SR_DEBUGCAUSE);
    if (cause & (CAUSE_BREAK | CAUSE_BREAKN)) return "crash"; // ESP-IDF's panic handler breaks into an attached debugger
    if (cause & CAUSE_IBREAK) return "breakpoint";
    if (cause & CAUSE_DBREAK) return "watchpoint";
    if (cause & CAUSE_ICOUNT) return "step";
    if (cause & CAUSE_DEBUGINT) return "pause";
    return "unknown";
  }

  setBreakpoints(addrs: number[]): void {
    this.breakpoints = addrs.slice(0, 2);
  }

  /** Program the breakpoints into every (halted) core: either may run the code. */
  /** `except`: leave this address out (the one the core is about to step off). */
  private async applyBreakpoints(except?: number): Promise<void> {
    const want = this.breakpoints.filter((a) => a !== except);
    for (const [i, core] of this.cores.entries()) {
      if (!core.halted) continue;
      if (want.length === core.applied.length && want.every((a, j) => a === core.applied[j])) continue;
      await this.onCore(i, async () => {
        let enable = 0;
        for (let j = 0; j < want.length; j++) {
          await this.writeSr(SR_IBREAKA0 + j, want[j]);
          enable |= 1 << j;
        }
        await this.writeSr(SR_IBREAKENABLE, enable);
      });
      core.applied = want;
    }
  }

  /**
   * Stopped by a breakpoint this class didn't set (ESP-IDF's crash handler puts one on the
   * failing instruction when a debugger is attached): the breakpoint registers no longer hold
   * what `applied` says, so have them written again, which drops it.
   */
  private async forgetForeignBreakpoint(pc: number): Promise<void> {
    if (this.breakpoints.includes(pc) || !((await this.readSr(SR_DEBUGCAUSE)) & CAUSE_IBREAK)) return;
    this.trace?.(`OCD core ${this.cur} stopped on a breakpoint someone else set at ${hex(pc)}; clearing it`);
    this.c.applied = [-1];
  }

  async resume(): Promise<void> {
    if (this.c.halted) {
      const pc = await this.readPc();
      await this.forgetForeignBreakpoint(pc);
      // Sitting on a breakpoint, the core would stop there again before running anything:
      // step off it first (with that breakpoint left out), as OpenOCD does.
      if (this.breakpoints.includes(pc)) await this.stepInstruction();
    }
    await this.applyBreakpoints();
    // Memory writes need a halted core to run them on.
    const halted = this.c.halted ? this.cur : this.cores.findIndex((c) => c.halted);
    if (halted >= 0) await this.onCore(halted, () => this.wdtRestore());
    // The other cores first, so the current one (the one the user follows) isn't held up by a lock.
    const order = this.cores.map((_, i) => i).filter((i) => i !== this.cur).concat(this.cur);
    for (const i of order) {
      const core = this.cores[i];
      if (!core.halted) continue;
      await this.onCore(i, async () => {
        // Still set up for stepping, the core would stop again at its very next instruction
        // (usually the interrupt that was held back during the step). OpenOCD clears it too.
        if (core.stepping !== false) await this.writeSr(SR_ICOUNTLEVEL, 0);
        core.stepping = false;
        if (core.unstalled && core.dcr & DCR_RUNSTALLINEN) await this.dbg(NAR_DCRSET, DCR_RUNSTALLINEN);
        core.unstalled = false;
        await this.skipBreak();
        await this.leaveDebug();
      });
    }
    this.stoppedCore = undefined;
  }

  /**
   * Restart the chip with a system software reset (RTC_CNTL_SW_SYS_RST), which keeps the
   * USB-Serial/JTAG link up. A core that was halted when the reset came can come back held at
   * the reset vector, so any core found stopped afterwards is let go.
   */
  /**
   * Clear the RTC "software CPU stall" of both cores. ESP-IDF's crash handler stalls the other core
   * through them, and they live in the RTC domain: they survive a system reset (and esptool's),
   * leaving core 0 stalled at boot, so the chip resets over and over. ESP-IDF's own restart clears
   * them first; so does this, before any reset or hand-over. Needs a halted core to run the stores.
   */
  private async clearCpuStalls(): Promise<void> {
    const RTC_CNTL_OPTIONS0 = 0x60008000;
    const RTC_CNTL_SW_CPU_STALL = 0x600080bc;
    const C0_MASK = 0xf; // SW_STALL_APPCPU_C0 (1:0), SW_STALL_PROCPU_C0 (3:2)
    const C1_MASK = 0xfff00000; // SW_STALL_APPCPU_C1 (25:20), SW_STALL_PROCPU_C1 (31:26)
    const halted = this.c.halted ? this.cur : this.cores.findIndex((c) => c.halted);
    if (halted < 0) return;
    await this.onCore(halted, async () => {
      const c1 = await this.rawRead32(RTC_CNTL_SW_CPU_STALL);
      const c0 = await this.rawRead32(RTC_CNTL_OPTIONS0);
      if (!(c1 & C1_MASK) && !(c0 & C0_MASK)) return;
      this.trace?.(`OCD clearing the RTC CPU stall (SW_CPU_STALL ${hex(c1)}, OPTIONS0 ${hex(c0)})`);
      await this.rawWrite32(RTC_CNTL_SW_CPU_STALL, c1 & ~C1_MASK);
      await this.rawWrite32(RTC_CNTL_OPTIONS0, c0 & ~C0_MASK);
    });
  }

  async restartChip(): Promise<void> {
    const RTC_CNTL_OPTIONS0 = 0x60008000;
    const SW_SYS_RST = 1 << 31;
    if (!this.cores.some((c) => c.halted)) await this.halt();
    await this.clearCpuStalls().catch((e) => this.trace?.(`OCD couldn't clear the CPU stall: ${(e as Error).message}`));
    if (!this.c.halted) this.selectCore(this.cores.findIndex((c) => c.halted));
    try {
      await this.saveScratch();
      await this.run([{ ddr: RTC_CNTL_OPTIONS0 }, ddrToAr(SCRATCH_ADDR), { ddr: SW_SYS_RST }, ddrToAr(SCRATCH_DATA), { insn: s32i(SCRATCH_DATA, SCRATCH_ADDR, 0) }]);
    } catch (e) {
      this.trace?.(`OCD reset write ended with: ${(e as Error).message}`); // the reset can cut it short
    }
    this.trace?.("OCD chip restarting");
    for (const core of this.cores) Object.assign(core, { halted: false, saved: undefined, applied: [], stepping: undefined, unstalled: false });
    this.wdtSaved = undefined;
    this.swdSaved = undefined;
    this.stoppedCore = undefined;
    await new Promise((r) => setTimeout(r, 50));
    await this.tap.reset();
    this.irSelected = -1;
    for (let i = 0; i < this.cores.length; i++) {
      await this.onCore(i, async () => {
        await this.powerUp();
        await this.readResetFlags();
        if ((await this.dbgRead(NAR_DSR)) & DSR_STOPPED) {
          this.trace?.(`OCD core ${i} came out of the reset halted; letting it run`);
          this.c.halted = true;
          await this.leaveDebug();
        }
      });
    }
  }

  /** Execute one instruction on the current core; the others stay stopped. */
  async stepInstruction(): Promise<void> {
    // A breakpoint on this very instruction would fire again instead of letting it run.
    const pc = await this.readPc();
    await this.forgetForeignBreakpoint(pc);
    await this.applyBreakpoints(pc);
    // Without this, a pending interrupt (the RTOS tick, mostly) is taken during the step and it
    // stops in the interrupt vector instead of at the next instruction (OpenOCD masks them too).
    // A WAITI lowers INTLEVEL itself, so stepping one still returns.
    const ps = await this.readSr(SR_EPS_DEBUG);
    const masked = (ps & PS_INTLEVEL) < STEP_INTLEVEL;
    if (masked) await this.writeSr(SR_EPS_DEBUG, (ps & ~PS_INTLEVEL) | STEP_INTLEVEL);
    if (this.c.stepping !== true) await this.writeSr(SR_ICOUNTLEVEL, DEBUG_LEVEL);
    this.c.stepping = true;
    await this.writeSr(SR_ICOUNT, 0xfffffffe); // halts after one instruction
    if (!this.c.unstalled && this.cores.some((c, i) => i !== this.cur && c.halted)) {
      await this.dbg(NAR_DCRCLR, DCR_RUNSTALLINEN); // the other cores stay halted: don't let them stall this one
      this.c.unstalled = true;
    }
    await this.skipBreak();
    await this.leaveDebug(); // it halts again at once: the watchdogs stay off
    if (!(await this.waitHalted())) {
      // Never leave it running with its interrupts masked: the interrupt watchdog would panic.
      await this.haltCores([this.cur]);
      if (masked) await this.writeSr(SR_EPS_DEBUG, ps);
      throw new Error("The core didn't stop after a step; it was paused again");
    }
    if (masked) {
      // Put the program's level back, unless the instruction set one of its own.
      const now = await this.readSr(SR_EPS_DEBUG);
      if ((now & PS_INTLEVEL) === STEP_INTLEVEL) await this.writeSr(SR_EPS_DEBUG, (now & ~PS_INTLEVEL) | (ps & PS_INTLEVEL));
    }
  }

  /**
   * Stopped on a BREAK instruction (ESP-IDF's crash handler uses one to hand over to the
   * debugger), the core would just stop on it again: move past it first, as OpenOCD does.
   */
  private async skipBreak(): Promise<void> {
    const cause = await this.readSr(SR_DEBUGCAUSE);
    const size = cause & CAUSE_BREAK ? 3 : cause & CAUSE_BREAKN ? 2 : 0;
    if (!size) return;
    const pc = await this.readSr(SR_EPC_DEBUG);
    this.trace?.(`OCD core ${this.cur} is on a BREAK at ${hex(pc)}; resuming after it`);
    await this.writeSr(SR_EPC_DEBUG, pc + size);
  }

  private async leaveDebug(): Promise<void> {
    await this.restoreScratch();
    await this.nar([
      { reg: NAR_DCRCLR, write: DCR_DEBUGINTERRUPT },
      { reg: NAR_DSR, write: 0xffffffff },
      { reg: NAR_DIR0EXEC, write: RFDO_0 },
    ]);
    this.c.halted = false;
  }

  // ---- reading the halted core ----

  readPc(): Promise<number> {
    return this.readSr(SR_EPC_DEBUG);
  }

  readCycleCount(): Promise<number> {
    return this.readSr(SR_CCOUNT);
  }

  async readRegisters(): Promise<Registers> {
    await this.saveScratch(); // a3/a4 may be in use as scratch; their program values are in `saved`
    const others = [...Array(16).keys()].filter((i) => i !== SCRATCH_ADDR && i !== SCRATCH_DATA);
    const values = await this.run(others.flatMap((i) => [arToDdr(i), READ]));
    const ar = new Array<number>(16);
    others.forEach((r, i) => (ar[r] = values[i]));
    ar[SCRATCH_ADDR] = this.c.saved!.a3;
    ar[SCRATCH_DATA] = this.c.saved!.a4;
    return { pc: await this.readPc(), ar };
  }

  /**
   * Walk the windowed-ABI call chain. A function's a0 holds its return address (the caller's PC)
   * with the call size (CALL4/8/12) in the top two bits. The caller's own a0 and a1 are one ROTW
   * away while its register window is live (its WindowStart bit is set); once a window has been
   * spilled (by an overflow, or ESP-IDF's crash handler), it and every older one are in memory:
   * the caller's a0..a3 are saved in the 16 bytes below the callee's stack pointer. Windows are
   * rotated back after; memory reads happen only in the original window (they use a3/a4).
   */
  async readFrames(max: number): Promise<{ pc: number; sp: number }[]> {
    await this.saveScratch();
    const pc = await this.readPc();
    const top = pc & 0xc0000000;
    const fix = (a: number) => ((a & 0x3fffffff) | top) >>> 0;
    const sp0 = await this.readAr(1);
    const frames = [{ pc, sp: sp0 }];
    let rotated = 0;
    try {
      const wb = await this.readSr(SR_WINDOWBASE);
      const ws = await this.readSr(SR_WINDOWSTART);
      let window = wb;
      // The return address and stack pointer of the frame whose window is visible.
      let ra = await this.readAr(0), sp = sp0;
      // Stopped on a function's ENTRY (its first instruction, after a step into it): the window
      // hasn't rotated yet, so the registers are still the caller's and the new function's return
      // address is in a4/a8/a12 as PS.CALLINC says.
      if (readable(pc, 3) && ((await this.readMemory(pc, 1))[0] & 0xff) === 0x36) {
        const callinc = ((await this.readSr(SR_EPS_DEBUG)) >>> 16) & 3;
        // a4 is the debugger's scratch register: the program's value is the saved one.
        if (callinc) frames.push({ pc: fix(callinc === 1 ? this.c.saved!.a4 : await this.readAr(callinc * 4)), sp: sp0 });
      }
      let live = true;
      while (frames.length < max) {
        const inc = ra >>> 30;
        if (!inc) break; // not called through a windowed call: the bottom of the chain
        let callerRa: number, callerSp: number;
        const callerWindow = (window - inc + 16) & 15;
        if (live && (ws >>> callerWindow) & 1) {
          await this.exec(rotw(-inc));
          rotated += inc;
          window = callerWindow;
          [callerRa, callerSp] = [await this.readAr(0), await this.readAr(1)];
        } else {
          if (rotated) await this.exec(rotw(rotated));
          rotated = 0;
          live = false;
          const save = await this.readMemory(sp - 16, 8);
          const dv = new DataView(save.buffer, save.byteOffset, save.byteLength);
          [callerRa, callerSp] = [dv.getUint32(0, true), dv.getUint32(4, true)];
        }
        frames.push({ pc: fix(ra), sp: callerSp });
        if (!callerSp || callerSp <= sp) break; // stacks grow down: a caller's frame is above
        [ra, sp] = [callerRa, callerSp];
      }
    } catch (e) {
      this.trace?.(`OCD frame walk stopped: ${e instanceof Error ? e.message : e}`);
    } finally {
      if (rotated) await this.exec(rotw(rotated));
    }
    return frames;
  }

  async readMemory(addr: number, length: number): Promise<Uint8Array> {
    if (!readable(addr >>> 0, length)) throw new Error(`0x${hex(addr)}–0x${hex(addr + length)} isn't readable memory`);
    const start = addr & ~3;
    const words = Math.ceil((addr + length - start) / 4);
    await this.saveScratch();
    const out = new Uint8Array(words * 4);
    const dv = new DataView(out.buffer);
    // Up to 64 words per batch (l32i's offset reaches 255 words; batches stay short so a replay is cheap).
    for (let at = 0; at < words; at += 64) {
      const n = Math.min(64, words - at);
      const steps: Step[] = [{ ddr: start + at * 4 }, ddrToAr(SCRATCH_ADDR)];
      for (let i = 0; i < n; i++) steps.push({ insn: l32i(SCRATCH_DATA, SCRATCH_ADDR, i) }, arToDdr(SCRATCH_DATA), READ);
      (await this.run(steps)).forEach((v, i) => dv.setUint32((at + i) * 4, v, true));
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
