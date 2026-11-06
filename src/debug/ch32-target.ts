/**
 * The CH32V003 as a DebugTarget for the inspector (jtag/inspector.ts), reached over SWIO through
 * a funprog programmer (src/flasher/funprog-hid.ts, WebHID), with the chip's RISC-V debug
 * module, the way minichlink's GDB server does it (minichlink/minichgdb.c):
 *
 *  - Halt and resume with DMCONTROL; DMSTATUS says when the hart has halted.
 *  - CPU registers through abstract commands (DMCOMMAND/DATA0). funprog's memory and flash
 *    commands run small programs on the halted CPU that use x8–x13, so the registers are
 *    saved when it stops and written back before it runs again.
 *  - Single steps with DCSR.step.
 *  - The QingKe V2A core has no hardware breakpoints: breakpoints are c.ebreak patched into
 *    flash (with DCSR.ebreakm, ebreak enters debug mode), 64-byte pages rewritten from the image
 *    that was flashed. They stay in flash while the CPU is paused (so Live values, which pause
 *    it twice a second, don't wear the flash out) and come out for single steps; reads of the
 *    flash show the original code. The image is checked against the flash when connecting:
 *    breakpoints are only used when the chip holds exactly that program.
 *  - ch32fun's debug printf (FUNCONF_USE_DEBUGPRINTF, its default) talks through DATA0/DATA1;
 *    funprog's terminal command polls it while the program runs, as minichlink -T does.
 */
import { FunprogHid } from "../flasher/funprog-hid";
import type { DebugTarget, Registers, StopCause } from "./jtag/target";

const DMDATA0 = 0x04;
const DMCONTROL = 0x10;
const DMSTATUS = 0x11;
const DMABSTRACTCS = 0x16;
const DMCOMMAND = 0x17;
const DMABSTRACTAUTO = 0x18;
const DMPROGBUF0 = 0x20;
const DMPROGBUF1 = 0x21;
const DMCFGR = 0x7d;
const DMSHDWCFGR = 0x7e;
const CSR_DCSR = 0x7b0;
const CSR_DPC = 0x7b1;
const CSR_MEPC = 0x341;
const CSR_MCAUSE = 0x342;
const CSR_MTVAL = 0x343;
/** mcause's exception codes, in words. */
const EXCEPTIONS: Record<number, string> = {
  0: "it jumped to an address that isn't a whole instruction (misaligned)",
  1: "it jumped to an address with no code; usually a function pointer that was never set",
  2: "it ran something that isn't a valid instruction; often a jump into data, or a corrupted stack",
  3: "it ran an ebreak that wasn't the debugger's",
  4: "it read a number from an address that isn't a multiple of its size (misaligned); usually a bad pointer",
  5: "it read from an address where there's nothing; usually a pointer that is NULL or was never set",
  6: "it wrote a number to an address that isn't a multiple of its size (misaligned); usually a bad pointer",
  7: "it wrote to an address where there's nothing (or that can't be written, like flash); usually a bad pointer",
  8: "it ran ecall (a system call), which ch32fun doesn't handle",
  11: "it ran ecall (a system call), which ch32fun doesn't handle",
};
const FLASH_BASE = 0x08000000;
const FLASH_SIZE = 16384;
const STK_CNT = 0xe000f008;
const RAM_BASE = 0x20000000;
const RAM_END = 0x20000800;
const PAGE = 64;
const C_EBREAK = [0x02, 0x90];
/** DCSR: ebreakm/ebreaks/ebreaku and stop the counters and timer while halted (as minichlink sets it). */
const DCSR_DEBUG = 0xb600;
const DCSR_STEP = 1 << 2;
const ALLHALTED = 1 << 9;
const ALLHAVERESET = 1 << 19;
const POLL_MS = 30;
/** Stop autoexec, clear cmderr, void funprog's cached state. */
const CLEAR_CMDERR = [...FunprogHid.writeReg(0x18, 0), ...FunprogHid.writeReg(0x16, 0x700), 0xfe, 0x05];

const W = FunprogHid.writeReg;
const R = FunprogHid.readReg;
const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const bytes32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, "0")}`;
/** An address in the flash, in either of its two places (0 and 0x0800_0000), as an offset into it. */
/** A breakpoint address in RAM (code copied there, like ch32fun's function-in-RAM example). */
const inRam = (a: number) => a >= 0x20000000 && a + 2 <= 0x20000800;
const flashOffset = (a: number) => (a < FLASH_SIZE ? a : a >= FLASH_BASE && a < FLASH_BASE + FLASH_SIZE ? a - FLASH_BASE : -1);

export interface Ch32Program {
  /** The image as flashed (from the start of flash). */
  image: Uint8Array;
  /** Every function (ELF symbol table), for walking the call stack. */
  funcs: { addr: number; size: number; name: string }[];
}

export interface Ch32TargetHost {
  /** What the program printed with ch32fun's printf. */
  print(text: string): void;
  log(text: string): void;
  /** The program last flashed to the chip, if known. */
  program(): Ch32Program | undefined;
}

export class Ch32Target implements DebugTarget {
  readonly name = "CH32V003 over SWIO (funprog)";
  readonly coreCount = 1;
  readonly core = 0;
  onLost?: (reason: string) => void;
  onReset?: () => void;
  private prog?: FunprogHid;
  private trace?: (line: string) => void;
  private regs = { pc: 0, x: new Array<number>(16).fill(0) };
  private halted = false;
  private cause: StopCause = "unknown";
  /** The saved registers are out of date (single steps only read pc and sp). */
  private stale = false;
  /** funprog commands changed CPU registers since they were saved: write them back before running. */
  private dirty = false;
  /** funprog's cached state was voided (fe 05) last thing: memory commands can go straight ahead. */
  private voided = false;
  /** DATA0 when the CPU stopped: the printf channel's state, put back when it runs again. */
  private data0 = 0;
  /** The program in flash, when it was checked to be the one flashed; breakpoints need it. */
  private flashed?: Ch32Program;
  /** Breakpoints wanted (code addresses), and the ones now patched into flash. */
  private wanted: number[] = [];
  /** RAM breakpoints in place: address → the two bytes the ebreak replaced. */
  private ramOrig = new Map<number, [number, number]>();
  /** After a restart: a hidden breakpoint at main(), where RAM breakpoints go back in (the start-up code copied the RAM code over them). */
  private rearm?: number;
  /** RAM breakpoints held back until main() starts (or the next Continue). */
  private ramHeld = false;
  /** Why it crashed, when it stopped in ch32fun's handler for faults and unhandled interrupts. */
  private crash?: { mcause: number; mepc: number; mtval: number };
  private inserted: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private poller?: number;
  private lastPoll = 0;
  private closed = false;
  private readonly decoder = new TextDecoder();
  private unwatch?: () => void;

  constructor(private readonly host: Ch32TargetHost) {}

  setTrace(trace: ((line: string) => void) | undefined): void {
    this.trace = trace;
  }

  get haltedCores(): number[] {
    return this.halted ? [0] : [];
  }

  get stoppedCore(): number | undefined {
    return this.halted && this.cause === "breakpoint" ? 0 : undefined;
  }

  selectCore(): void {}

  private run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => {});
    return next;
  }

  private x(cmds: number[], replyLen: number): Promise<Uint8Array> {
    if (this.closed || !this.prog) return Promise.reject(new Error("Not connected to the CH32V003"));
    // Anything sent can leave the debug module other than funprog's own commands expect.
    this.voided = false;
    return this.prog.transact(cmds, replyLen);
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.poller);
    this.unwatch?.();
    this.onLost?.(e.message);
  }

  // ---- connecting ----

  async connect(quiet = false): Promise<void> {
    const prog = await FunprogHid.pick((t) => this.host.log(t), quiet);
    await prog.open();
    this.prog = prog;
    this.closed = false;
    this.unwatch = prog.watchUnplug(() => this.fail(new Error("The programmer was unplugged")));
    try {
      await this.run(async () => {
        const v = await this.x([0xfe, 0xfd, 0x00], 5);
        this.trace?.(`funprog firmware ${v[0]}.${v[2]}`);
        // Find the chip's debug interface (it doesn't disturb a running program).
        let init = await this.x([0xfe, 0x0e], 1);
        // Asleep in standby (an auto-wakeup program wakes up now and then): keep trying a while.
        for (const until = performance.now() + 6000; init[0] !== 0 && performance.now() < until;) {
          await new Promise((res) => setTimeout(res, 50));
          init = await this.x([0xfe, 0x0e], 1);
        }
        if (init[0] !== 0) throw new Error(`No CH32V003 answers on SWIO (code ${(init[0] << 24) >> 24}). Check the wiring: programmer SWIO → PD1, 3V3 and GND.`);
        // One terminal poll first: whatever the program printed is shown, and the debug module is
        // in the state the register reads expect (right after a reset they can fail otherwise).
        const term = await this.x([0xfe, 0x0d, 0, 0, 0, 0, 0, 0, 0, 0, ...R(DMSTATUS)], 6);
        if (term.length > 6) this.print(term.subarray(1, term.length - 5));
        const status = le32(term, term.length - 4);
        // A reset before now (the flasher's) isn't news.
        if (status & ALLHAVERESET) await this.x(W(DMCONTROL, 0x10000001), 0);
        const wasHalted = !!(status & ALLHALTED);
        if (!wasHalted) await this.haltNow();
        await this.onHalted(wasHalted ? undefined : "pause", false);
        await this.checkFlash();
        if (!wasHalted) await this.resumeNow();
        else {
          // Why it's paused, now that the program is known (stopped in the fault handler: a crash).
          await this.settle();
          await this.onHalted(undefined, false);
          this.trace?.("the CPU was already halted");
        }
      });
    } catch (e) {
      this.closed = true;
      this.unwatch?.();
      await prog.close();
      this.prog = undefined;
      throw e;
    }
    this.schedulePoll();
  }

  /**
   * Whether the flash holds the program that was flashed from this page (breakpoints are
   * written from that image). Breakpoints left in it by an earlier session (a page closed
   * while they were in) are taken out.
   */
  private async checkFlash(): Promise<void> {
    const p = this.host.program();
    this.flashed = undefined;
    if (!p) {
      this.host.log("SWIO: breakpoints need the program to be flashed from this page first (the inspector writes them into flash from it)");
      return;
    }
    await this.beforeMemoryOps();
    const flash = await this.readWords(FLASH_BASE, Math.ceil(p.image.length / 4));
    const stray: number[] = [];
    for (let i = 0; i < p.image.length; i++) {
      if (flash[i] === p.image[i]) continue;
      const a = i & ~1;
      if (flash[a] === C_EBREAK[0] && flash[a + 1] === C_EBREAK[1]) {
        if (!stray.includes(a)) stray.push(a);
        continue;
      }
      this.host.log("SWIO: the chip holds a different program than the one last flashed from here; flash it again to use breakpoints");
      return;
    }
    this.flashed = p;
    this.inserted = stray;
    // Left-over breakpoints out (the one on the crash handler can stay), and the crash handler's in.
    const handler = this.crashHandler();
    const left = stray.filter((a) => a !== handler).length;
    if (left) this.host.log(`SWIO: took ${left} breakpoint${left > 1 ? "s" : ""} left in flash by an earlier session out again`);
    await this.sync(this.validBreakpoints());
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.poller);
    if (!this.closed && this.prog) {
      await this.run(async () => {
        try {
          if (this.inserted.length && !this.halted) {
            await this.haltNow();
            await this.onHalted("pause", false);
          }
          if (this.halted) {
            await this.sync([]);
            await this.resumeNow();
          }
        } catch (e) {
          this.host.log(`SWIO: couldn't leave the chip running cleanly: ${(e as Error).message}`);
        }
      });
    }
    this.closed = true;
    this.unwatch?.();
    await this.prog?.close();
    this.prog = undefined;
  }

  // ---- watching the running program ----

  private schedulePoll(): void {
    if (this.closed || this.poller !== undefined) return;
    this.poller = window.setTimeout(() => {
      this.poller = undefined;
      if (this.closed) return;
      if (this.halted) return; // resuming starts it again
      void this.run(() => this.poll()).then(() => this.schedulePoll(), (e) => {
        // The programmer gone (unplugged, USB error): the session is over. The chip not doing
        // what was asked (it just woke up, say): keep watching.
        if (isLinkError(e)) return this.fail(e as Error);
        this.trace?.(`poll: ${(e as Error).message}`);
        this.halted = false;
        this.schedulePoll();
      });
    }, this.asleep === undefined ? POLL_MS : 200);
  }

  /** Since when the chip doesn't answer on SWIO (asleep in standby, held in reset, unpowered). */
  private asleep?: number;
  private toldAsleep = false;
  private lastInit = 0;

  /** No answer from the chip: wait for it (its debug link is off in standby), trying to reach it again now and then. */
  private async noAnswer(): Promise<void> {
    const now = performance.now();
    this.asleep ??= now;
    if (!this.toldAsleep && now - this.asleep > 1500) {
      this.toldAsleep = true;
      this.host.log("SWIO: the CH32V003 doesn't answer (asleep in standby, held in reset, or unpowered?); waiting for it");
    }
    if (now - this.lastInit > 500) {
      this.lastInit = now;
      await this.x([0xfe, 0x0e], 1);
    }
  }

  /** One terminal poll and a DMSTATUS read, in one report. */
  private async poll(): Promise<void> {
    if (this.halted || this.closed) return;
    this.lastPoll = performance.now();
    const r = await this.x([0xfe, 0x0d, 0, 0, 0, 0, 0, 0, 0, 0, ...R(DMSTATUS)], 6);
    if (r[r.length - 5] !== 0) return this.noAnswer();
    const text = r.subarray(1, r.length - 5);
    if (text.length) this.print(text);
    const status = le32(r, r.length - 4);
    if (this.asleep !== undefined) {
      // Back: a chip that slept in standby wakes up through a reset.
      if (this.toldAsleep) this.host.log("SWIO: the CH32V003 answers again");
      this.asleep = undefined;
      this.toldAsleep = false;
    }
    if (status & ALLHAVERESET) {
      // Reset by something else (its reset pin, a watchdog): DCSR is back to its defaults, so
      // breakpoints in flash would raise exceptions instead of stopping. The inspector puts
      // them back (halt, resume), which sets DCSR again.
      await this.x(W(DMCONTROL, 0x10000001), 0);
      this.ramOrig.clear();
      this.inserted = this.inserted.filter((a) => !inRam(a));
      this.trace?.("the chip was reset");
      setTimeout(() => this.onReset?.(), 0);
    }
    if (status & ALLHALTED) {
      await this.onHalted(undefined, true);
      const at = flashOffset(this.regs.pc);
      if (this.rearm !== undefined && at === this.rearm && this.cause === "breakpoint") {
        // main() started after a restart: RAM breakpoints back in, and on it goes (unless the
        // user has a breakpoint right there too).
        this.rearm = undefined;
        this.ramHeld = false;
        if (!this.wanted.includes(at)) {
          await this.stepPast();
          await this.sync(this.validBreakpoints());
          await this.resumeNow();
        }
      }
    }
  }

  /** Text from the program's printf; control characters (other than line breaks and tabs) are left out. */
  private print(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes.filter((c) => c >= 0x20 || c === 10 || c === 13 || c === 9));
    if (text) this.host.print(text);
  }

  // ---- registers ----

  /**
   * Read x1–x15, dpc and dcsr. `fromRun`: it just stopped, so DATA0 is the program's (save it first).
   * An abstract command that fails (the first ones after a reset can) sets cmderr, and the debug
   * module then ignores every later command until it's cleared: so it's cleared before, checked
   * after, and the read is tried again once. Writing back registers read wrongly would crash the program.
   */
  private async readAll(fromRun: boolean): Promise<number> {
    // All in one report: DATA0 first (before the abstract commands use it), then the registers,
    // then funprog's cached state voided (the abstract commands changed what it assumes).
    const cmds = [...(fromRun ? R(DMDATA0) : []), ...W(DMABSTRACTCS, 0x700), ...W(DMABSTRACTAUTO, 0)];
    for (let i = 1; i < 16; i++) cmds.push(...W(DMCOMMAND, 0x00221000 | i), ...R(DMDATA0));
    cmds.push(...W(DMCOMMAND, 0x00220000 | CSR_DPC), ...R(DMDATA0));
    cmds.push(...W(DMCOMMAND, 0x00220000 | CSR_DCSR), ...R(DMDATA0));
    cmds.push(...R(DMABSTRACTCS), 0xfe, 0x05);
    const head = fromRun ? 5 : 0;
    let r = await this.x(cmds, head + 18 * 5);
    if (fromRun) this.data0 = le32(r, 1);
    r = r.subarray(head);
    if ((le32(r, 17 * 5 + 1) >> 8) & 7) {
      this.trace?.(`register read failed (abstractcs ${hex(le32(r, 17 * 5 + 1))}); again`);
      r = (await this.x(cmds.slice(fromRun ? 1 : 0), 18 * 5));
      if ((le32(r, 17 * 5 + 1) >> 8) & 7) {
        // The debug module itself was reset (the chip woke from standby): set the link up again.
        this.trace?.("register read failed again; setting up the debug link again");
        await this.x([0xfe, 0x0e, ...W(DMCONTROL, 0x80000001), 0xfe, 0x05], 1);
        r = (await this.x(cmds.slice(fromRun ? 1 : 0), 18 * 5));
        if ((le32(r, 17 * 5 + 1) >> 8) & 7) throw new Error(`Reading the CPU registers failed (abstract command error ${(le32(r, 17 * 5 + 1) >> 8) & 7})`);
      }
    }
    this.voided = true;
    for (let i = 0; i < 17; i++) if (r[i * 5] !== 0) throw new Error(`Reading the CPU registers failed (code ${(r[i * 5] << 24) >> 24})`);
    const x = [0];
    for (let i = 0; i < 15; i++) x.push(le32(r, i * 5 + 1));
    this.regs = { pc: le32(r, 15 * 5 + 1), x };
    this.stale = false;
    return le32(r, 16 * 5 + 1);
  }

  /** Commands that write the saved registers back (when funprog's commands changed them). */
  private restoreCmds(): number[] {
    if (!this.dirty) return [];
    const cmds = [...W(DMABSTRACTCS, 0x700), ...W(DMABSTRACTAUTO, 0)];
    for (let i = 1; i < 16; i++) cmds.push(...W(DMDATA0, this.regs.x[i]), ...W(DMCOMMAND, 0x00231000 | i));
    this.dirty = false;
    return cmds;
  }

  /** Commands that set dpc and dcsr, then resume. */
  private resumeCmds(pc: number, step: boolean): number[] {
    return [
      ...W(DMABSTRACTCS, 0x700), ...W(DMABSTRACTAUTO, 0),
      ...W(DMDATA0, pc), ...W(DMCOMMAND, 0x00230000 | CSR_DPC),
      ...W(DMDATA0, DCSR_DEBUG | (step ? DCSR_STEP : 0)), ...W(DMCOMMAND, 0x00230000 | CSR_DCSR),
      ...W(DMDATA0, this.data0), // the printf channel as the program left it
      ...W(DMSHDWCFGR, 0x5aa50000 | (1 << 10)), ...W(DMCFGR, 0x5aa50000 | (1 << 10)),
      ...W(DMCONTROL, 0x40000001), // resumereq
    ];
  }

  /**
   * After funprog memory/flash commands, while paused: the program's registers back in the CPU right
   * away (not only when it runs again), so a session that ends abruptly (the page closed) leaves the
   * CPU as the program left it, for the next session to read.
   */
  private async settle(): Promise<void> {
    if (this.dirty && this.halted && !this.closed) await this.x(this.restoreCmds(), 0);
  }

  /** Before funprog memory/flash commands: registers saved, and funprog's cached state voided. */
  private async beforeMemoryOps(): Promise<void> {
    if (this.stale) await this.readAll(false);
    if (!this.voided) await this.x([0xfe, 0x05], 0);
    this.voided = false;
    this.dirty = true;
  }

  // ---- run control ----

  private async waitHalted(timeoutMs = 2000): Promise<boolean> {
    const end = performance.now() + timeoutMs;
    for (;;) {
      if (le32(await this.x(R(DMSTATUS), 5), 1) & ALLHALTED) return true;
      if (performance.now() > end) return false;
    }
  }

  /**
   * Halt, and in the same report: save DATA0 (the printf channel, before the next commands use
   * it) and set DCSR, whose stoptime stops SysTick while halted. A reset clears DCSR, so on the
   * first halt after one SysTick would otherwise keep counting while the debugger reads the
   * chip: a program that sets its next SysTick interrupt 1 ms ahead (millis()) misses it, and
   * its interrupt then never fires again.
   */
  private async haltNow(): Promise<void> {
    const setDcsr = [...W(DMABSTRACTCS, 0x700), ...W(DMDATA0, DCSR_DEBUG), ...W(DMCOMMAND, 0x00230000 | CSR_DCSR), ...R(DMABSTRACTCS)];
    const r = await this.x([
      ...W(DMSHDWCFGR, 0x5aa50000 | (1 << 10)), ...W(DMCFGR, 0x5aa50000 | (1 << 10)),
      ...W(DMCONTROL, 0x80000001), ...W(DMCONTROL, 0x80000001),
      ...R(DMSTATUS), ...R(DMDATA0), ...setDcsr,
    ], 15);
    this.data0 = le32(r, 6);
    const ok = le32(r, 1) & ALLHALTED && !((le32(r, 11) >> 8) & 7);
    if (ok) return;
    if (!(le32(r, 1) & ALLHALTED) && !(await this.waitHalted())) throw new Error("The CH32V003 doesn't stop (is it in a low-power sleep?)");
    // It wasn't halted yet when DCSR was written: again, now that it is.
    await this.x(setDcsr, 5);
  }

  /** The hart is halted (we asked, or it hit an ebreak): save its state. */
  private async onHalted(cause: StopCause | undefined, fromRun: boolean): Promise<void> {
    this.halted = true;
    clearTimeout(this.poller);
    this.poller = undefined;
    const dcsr = await this.readAll(fromRun); // (it voids funprog's cached state too)
    const why = (dcsr >> 6) & 7; // 1 ebreak, 2 trigger, 3 haltreq, 4 step, 5 resethaltreq
    this.cause = cause ?? (why === 1 ? "breakpoint" : why === 4 ? "step" : why === 3 ? "pause" : "unknown");
    this.crash = undefined;
    const handler = this.crashHandler();
    if (handler !== undefined && flashOffset(this.regs.pc) === handler && (why === 1 || !cause)) {
      // The breakpoint on ch32fun's fault handler: the program crashed (or an interrupt has no handler).
      const r = await this.x([
        ...W(DMABSTRACTCS, 0x700),
        ...W(DMCOMMAND, 0x00220000 | CSR_MCAUSE), ...R(DMDATA0),
        ...W(DMCOMMAND, 0x00220000 | CSR_MEPC), ...R(DMDATA0),
        ...W(DMCOMMAND, 0x00220000 | CSR_MTVAL), ...R(DMDATA0),
      ], 15);
      this.crash = { mcause: le32(r, 1), mepc: le32(r, 6), mtval: le32(r, 11) };
      this.cause = "crash";
    }
    // An ebreak that isn't one of ours, in flash where the program has none: left behind by an
    // earlier session. Put the code back (the inspector says so, and Continue then runs on).
    const pc = this.regs.pc, at = flashOffset(pc);
    if (why === 1 && this.flashed && at >= 0 && !this.inserted.includes(at) && this.flashed.image[at] !== C_EBREAK[0]) {
      this.inserted.push(at);
      await this.sync(this.inserted.filter((a) => a !== at));
      await this.settle();
    }
    this.trace?.(`halted at ${hex(pc)} (${this.cause})`);
  }

  /** After any exchange in progress (a poll that just saw a stop is still reading the registers). */
  isHalted(): Promise<boolean> {
    return this.run(async () => {
      if (!this.halted && performance.now() - this.lastPoll > POLL_MS) await this.poll();
      return this.halted;
    });
  }

  halt(): Promise<void> {
    return this.run(async () => {
      if (this.halted) return;
      await this.haltNow();
      await this.onHalted("pause", false);
    });
  }

  private async resumeNow(): Promise<void> {
    await this.x([...this.restoreCmds(), ...this.resumeCmds(this.regs.pc, false)], 0);
    this.halted = false;
    this.schedulePoll();
  }

  resume(): Promise<void> {
    return this.run(async () => {
      if (!this.halted) return;
      this.ramHeld = this.rearm !== undefined; // (a Continue puts RAM breakpoints back, unless main() is still to come)
      const want = this.validBreakpoints();
      // On a breakpoint: run its instruction first, then let it run with the breakpoint in.
      if (want.includes(this.regs.pc) || this.inserted.includes(this.regs.pc)) await this.stepPast();
      await this.sync(want);
      await this.resumeNow();
    });
  }

  async checkRestarted(): Promise<boolean> {
    return this.run(async () => {
      if (!this.halted) return false;
      const status = le32(await this.x(R(DMSTATUS), 5), 1);
      if (status & ALLHALTED) return false;
      // Running again: something reset it (its reset pin). Its registers are gone; so is DCSR.
      if (status & ALLHAVERESET) await this.x(W(DMCONTROL, 0x10000001), 0);
      this.halted = false;
      this.schedulePoll();
      return true;
    });
  }

  restartChip(): Promise<void> {
    return this.run(async () => {
      if (!this.halted) {
        await this.haltNow();
        await this.onHalted("pause", false);
      }
      // Reset while halted: it stops again at the reset vector, so DCSR (which the reset clears)
      // is set up before the program runs into a breakpoint.
      await this.x([...W(DMCONTROL, 0x80000001), ...W(DMCONTROL, 0x80000003), ...W(DMCONTROL, 0x80000001)], 0);
      if (!(await this.waitHalted())) throw new Error("The CH32V003 didn't stop after the reset");
      await this.x(W(DMCONTROL, 0x90000001), 0); // our own reset: acknowledged (still halted)
      await this.onHalted("pause", true);
      this.data0 = 0;
      this.dirty = false;
      // The start-up code will copy the RAM code from flash, over any RAM breakpoints: forget them,
      // and put them back when main() starts.
      this.ramOrig.clear();
      this.inserted = this.inserted.filter((a) => !inRam(a));
      const main = this.flashed?.funcs.find((f) => f.name === "main");
      this.ramHeld = this.wanted.some(inRam);
      if (this.ramHeld && main && flashOffset(main.addr) >= 0) this.rearm = flashOffset(main.addr);
      await this.sync(this.validBreakpoints());
      await this.resumeNow();
    });
  }

  /**
   * Do a jump, branch, call, return or auipc without running it: its effect is worked out from the
   * registers (the new pc, and the return address or auipc's result), so a breakpoint on one
   * needn't come out of flash. Whether it could (ebreak, ecall, mret, wfi can't).
   */
  private async emulate(insn: number, size: number): Promise<boolean> {
    if (this.stale) await this.readAll(false);
    const pc = this.regs.pc, x = this.regs.x;
    const reg = (n: number) => (n ? x[n] ?? 0 : 0);
    let next: number | undefined, rd = 0, value = 0;
    if (size === 2) {
      const q = insn & 3, f3 = insn >>> 13, b = (hi: number, lo: number) => (insn >>> lo) & ((1 << (hi - lo + 1)) - 1);
      const cj = () => (((b(12, 12) << 11) | (b(11, 11) << 4) | (b(10, 9) << 8) | (b(8, 8) << 10) | (b(7, 7) << 6) | (b(6, 6) << 7) | (b(5, 3) << 1) | (b(2, 2) << 5)) << 20) >> 20;
      if (q === 1 && (f3 === 1 || f3 === 5)) { // c.jal, c.j
        next = pc + cj();
        if (f3 === 1) [rd, value] = [1, pc + 2];
      } else if (q === 1 && (f3 === 6 || f3 === 7)) { // c.beqz, c.bnez
        const off = (((b(12, 12) << 8) | (b(11, 10) << 3) | (b(6, 5) << 6) | (b(4, 3) << 1) | (b(2, 2) << 5)) << 23) >> 23;
        const zero = reg(8 + b(9, 7)) === 0;
        next = zero === (f3 === 6) ? pc + off : pc + 2;
      } else if (q === 2 && f3 === 4 && b(6, 2) === 0 && b(11, 7) !== 0) { // c.jr, c.jalr
        next = reg(b(11, 7)) & ~1;
        if (b(12, 12)) [rd, value] = [1, pc + 2];
      } else return false;
    } else {
      const op = insn & 0x7f, d = (insn >>> 7) & 31, f3 = (insn >>> 12) & 7, s1 = (insn >>> 15) & 31, s2 = (insn >>> 20) & 31;
      if (op === 0x6f) { // jal
        next = pc + (((((insn >>> 31) << 20) | (((insn >>> 12) & 0xff) << 12) | (((insn >>> 20) & 1) << 11) | (((insn >>> 21) & 0x3ff) << 1)) << 11) >> 11);
        [rd, value] = [d, pc + 4];
      } else if (op === 0x67) { // jalr
        next = (reg(s1) + ((insn | 0) >> 20)) & ~1;
        [rd, value] = [d, pc + 4];
      } else if (op === 0x63) { // branches
        const off = (((((insn >>> 31) << 12) | (((insn >>> 7) & 1) << 11) | (((insn >>> 25) & 0x3f) << 5) | (((insn >>> 8) & 0xf) << 1))) << 19) >> 19;
        const a = reg(s1), c = reg(s2);
        const taken = [a === c, a !== c, false, false, (a | 0) < (c | 0), (a | 0) >= (c | 0), a >>> 0 < c >>> 0, a >>> 0 >= c >>> 0][f3];
        next = taken ? pc + off : pc + 4;
      } else if (op === 0x17) { // auipc
        next = pc + 4;
        [rd, value] = [d, pc + (insn & 0xfffff000)];
      } else return false;
    }
    const cmds = [...this.restoreCmds(), ...W(DMABSTRACTCS, 0x700), ...W(DMABSTRACTAUTO, 0)];
    if (rd) cmds.push(...W(DMDATA0, value >>> 0), ...W(DMCOMMAND, 0x00231000 | rd));
    cmds.push(...W(DMDATA0, next >>> 0), ...W(DMCOMMAND, 0x00230000 | CSR_DPC), ...R(DMABSTRACTCS));
    const r = await this.x(cmds, 5);
    if ((le32(r, 1) >> 8) & 7) {
      await this.x(W(DMABSTRACTCS, 0x700), 0);
      return false;
    }
    if (rd) x[rd] = value >>> 0;
    this.regs.pc = next >>> 0;
    this.cause = "step";
    this.trace?.(`emulated the jump at ${hex(pc)} → ${hex(next)}`);
    return true;
  }

  /** Execute one instruction (with the real code at pc). */
  private async stepOne(): Promise<void> {
    const r = await this.x([
      ...this.restoreCmds(),
      ...this.resumeCmds(this.regs.pc, true),
      ...R(DMSTATUS),
      ...W(DMCOMMAND, 0x00220000 | CSR_DPC), ...R(DMDATA0),
      ...W(DMCOMMAND, 0x00221002), ...R(DMDATA0), // sp
    ], 15);
    if (!(le32(r, 1) & ALLHALTED) && !(await this.waitHalted())) throw new Error("A single step didn't stop");
    this.regs.pc = le32(r, 6);
    this.regs.x[2] = le32(r, 11);
    this.stale = true;
    this.cause = "step";
  }

  stepInstruction(): Promise<void> {
    return this.run(async () => {
      if (!this.halted) throw new Error("The CPU is running");
      // A step runs only the instruction at pc: breakpoints elsewhere can stay in flash.
      if (this.inserted.includes(this.regs.pc)) await this.stepPast();
      else await this.stepOne();
    });
  }

  /**
   * Run the instruction at pc, where a breakpoint's ebreak is in flash. Most instructions run just
   * as well from the debug module's program buffer ("displaced", as GDB calls it): no flash is
   * rewritten. Jumps, branches and auipc depend on where they are: for those the breakpoint
   * comes out of flash (one page rewrite) for a real step.
   */
  private async stepPast(): Promise<void> {
    const pc = this.regs.pc, img = this.flashed?.image;
    const at = inRam(pc) ? pc : flashOffset(pc);
    let bytes: number[];
    if (inRam(pc)) {
      const orig = this.ramOrig.get(pc);
      if (!orig) return this.stepOne();
      await this.beforeMemoryOps();
      const next = await this.readWords((pc + 2) & ~3, 1);
      const hi = next.subarray((pc + 2) & 3, ((pc + 2) & 3) + 2);
      bytes = [...orig, hi[0], hi[1]];
    } else {
      if (!img || at < 0) return this.stepOne();
      bytes = [...img.subarray(at, at + 4)];
    }
    const h = bytes[0] | (bytes[1] << 8);
    const size = (h & 3) === 3 ? 4 : 2;
    const insn = size === 4 ? (h | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0 : h;
    if (!displaceable(insn, size)) {
      if (await this.emulate(insn, size)) return;
      await this.sync(this.inserted.filter((a) => a !== at));
      return this.stepOne();
    }
    if (this.stale) await this.readAll(false);
    const r = await this.x([
      ...this.restoreCmds(),
      ...W(DMABSTRACTCS, 0x700), ...W(DMABSTRACTAUTO, 0),
      // A 2-byte instruction is followed by c.ebreak in the same word; either way, ebreak after it.
      ...W(DMPROGBUF0, size === 4 ? insn : (insn | (0x9002 << 16)) >>> 0), ...W(DMPROGBUF1, 0x00100073),
      ...W(DMCOMMAND, 0x00240000), // postexec only: run the program buffer
      ...R(DMABSTRACTCS),
      0xfe, 0x05, // funprog's own program-buffer code is gone
    ], 5);
    const cmderr = (le32(r, 1) >> 8) & 7;
    if (cmderr) {
      await this.x(W(DMABSTRACTCS, 0x700), 0);
      this.trace?.(`displaced step at ${hex(pc)} failed (cmderr ${cmderr}); stepping in flash`);
      await this.sync(this.inserted.filter((a) => a !== at));
      return this.stepOne();
    }
    // dpc too: the next register read takes pc from it.
    await this.x([...W(DMDATA0, (pc + size) >>> 0), ...W(DMCOMMAND, 0x00230000 | CSR_DPC), ...R(DMABSTRACTCS)], 5);
    this.regs.pc = (pc + size) >>> 0;
    this.stale = true; // the instruction may have changed a register
    this.cause = "step";
    this.trace?.(`displaced step at ${hex(pc)}`);
  }

  stopCause(): Promise<StopCause> {
    return this.run(async () => this.cause);
  }

  readRegisters(): Promise<Registers> {
    return this.run(async () => {
      if (this.stale) await this.readAll(false);
      return { pc: this.regs.pc, ar: [...this.regs.x] };
    });
  }

  readPc(): Promise<number> {
    return this.run(async () => this.regs.pc);
  }

  async readCycleCount(): Promise<number> {
    const b = await this.readMemory(STK_CNT, 4);
    return le32(b, 0);
  }

  /**
   * The call stack, from each function's prologue: how far it moved sp down (addi sp, sp, -N)
   * and where it saved ra (sw ra, off(sp)), in the instructions it ran before pc. The innermost
   * function may not have saved ra yet (or be a leaf that never does): ra is still in the register.
   */
  async readFrames(max: number): Promise<{ pc: number; sp: number; cfa?: number }[]> {
    const regs = await this.readRegisters();
    const p = this.host.program();
    const frames: { pc: number; sp: number; cfa?: number }[] = [{ pc: regs.pc, sp: regs.ar[2] }];
    if (!p) return frames;
    let pc = regs.pc, sp = regs.ar[2];
    if (this.crash && !(this.crash.mcause >>> 31)) {
      // Stopped at the fault handler's first instruction: the registers are still those of the
      // instruction that failed (mepc), which is where the call stack really starts.
      pc = this.crash.mepc;
      frames.push({ pc: (pc + 2) >>> 0, sp });
    }
    const inRam = (a: number) => a >= RAM_BASE && a <= RAM_END;
    for (let n = 0; n < max - 1; n++) {
      const fn = p.funcs.find((f) => pc >= f.addr && pc < f.addr + f.size);
      if (!fn) break;
      const f = this.frameOf(p.image, fn.addr, pc, n === 0);
      const cfa = (sp + f.size) >>> 0;
      if (!inRam(cfa)) break;
      frames[frames.length - 1].cfa = cfa;
      // main() is where the program starts, as far as anyone stepping through it cares.
      if (fn.name === "main") break;
      let ra: number;
      if (f.raAt !== undefined) {
        if (!inRam(sp + f.raAt + 4)) break;
        ra = le32(await this.readMemory(sp + f.raAt, 4), 0);
      } else if (n === 0) ra = regs.ar[1];
      else break;
      if (!ra || ra & 1 || flashOffset(ra) < 0 || ra === pc) break;
      frames.push({ pc: ra, sp: cfa });
      pc = ra;
      sp = cfa;
    }
    return frames;
  }

  /** A function's frame at `pc`: its size (bytes below the caller's sp) and where ra is saved (from sp). */
  private frameOf(image: Uint8Array, start: number, pc: number, innermost: boolean): { size: number; raAt?: number } {
    const h16 = (a: number) => image[a] | (image[a + 1] << 8);
    // At the end of the function (innermost frame only): `addi sp, sp, N` then `ret`, ra already loaded.
    if (innermost && pc + 2 <= image.length) {
      const h = h16(pc);
      if (h === 0x8082) return { size: 0 }; // ret
      if ((h & 0xef83) === 0x6101) { // c.addi16sp with a positive amount
        const v = ((h >> 12) & 1) << 9 | ((h >> 6) & 1) << 4 | ((h >> 5) & 1) << 6 | ((h >> 3) & 3) << 7 | ((h >> 2) & 1) << 5;
        if (!((h >> 12) & 1)) return { size: v };
      }
    }
    let size = 0;
    let raAt: number | undefined;
    for (let a = start, n = 0; a < pc && n < 24; n++) {
      const h = h16(a);
      if ((h & 3) !== 3) {
        if ((h & 0xef83) === 0x6101) { // c.addi16sp
          const v = ((h >> 12) & 1) << 9 | ((h >> 6) & 1) << 4 | ((h >> 5) & 1) << 6 | ((h >> 3) & 3) << 7 | ((h >> 2) & 1) << 5;
          const s = (v << 22) >> 22;
          if (s < 0) size -= s;
        } else if ((h & 0xef83) === 0x0101 && ((h >> 7) & 31) === 2) { // c.addi sp, imm
          const s = ((((h >> 12) & 1) << 5 | ((h >> 2) & 31)) << 26) >> 26;
          if (s < 0) size -= s;
        } else if ((h & 0xe003) === 0xc002 && ((h >> 2) & 31) === 1) { // c.swsp ra, off
          raAt = ((h >> 9) & 15) << 2 | ((h >> 7) & 3) << 6;
        } else if ((h & 0xe003) === 0xa001 || (h & 0xc003) === 0xc001 || (h & 0xe003) === 0x2001 || (h & 0xf07f) === 0x8002 || (h & 0xf07f) === 0x9002) {
          break; // a jump, branch or call: the prologue is over
        }
        a += 2;
        continue;
      }
      const w = (h | (h16(a + 2) << 16)) >>> 0;
      const op = w & 0x7f, rd = (w >> 7) & 31, rs1 = (w >> 15) & 31, f3 = (w >> 12) & 7;
      if (op === 0x13 && f3 === 0 && rd === 2 && rs1 === 2) {
        const s = (w | 0) >> 20;
        if (s < 0) size -= s;
      } else if (op === 0x23 && f3 === 2 && rs1 === 2 && ((w >> 20) & 31) === 1) {
        raAt = (((w | 0) >> 25) << 5) | ((w >> 7) & 31);
      } else if (op === 0x6f || op === 0x67 || op === 0x63) break;
      a += 4;
    }
    return { size, raAt };
  }

  // ---- memory ----

  /** Read words with funprog (the CPU must be halted, registers saved). */
  private async readWords(addr: number, count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count * 4);
    const PER = 40; // 5 bytes of reply each
    for (let w = 0; w < count; w += PER) {
      const n = Math.min(PER, count - w);
      const cmds: number[] = [];
      for (let i = 0; i < n; i++) cmds.push(0xfe, 0x09, ...bytes32((addr + (w + i) * 4) >>> 0));
      const last = w + n >= count;
      // After the last read, in the same report: the cleanup (see clearCmdErr).
      if (last) cmds.push(...CLEAR_CMDERR);
      const r = await this.x(cmds, n * 5);
      for (let i = 0; i < n; i++) {
        if (r[i * 5] !== 0) {
          if (!last) await this.clearCmdErr();
          throw new Error(`Reading ${hex(addr + (w + i) * 4)} failed (code ${(r[i * 5] << 24) >> 24})`);
        }
        out.set(r.subarray(i * 5 + 1, i * 5 + 5), (w + i) * 4);
      }
      if (last) this.voided = true;
    }
    return out;
  }

  /**
   * funprog reads with autoexec, which already fetches the word after the last one: at the end of
   * RAM or a peripheral that faults and leaves cmderr set, failing the next command. Stop
   * autoexec, clear cmderr, and void funprog's cached state.
   */
  private async clearCmdErr(): Promise<void> {
    await this.x(CLEAR_CMDERR, 0);
    this.voided = true;
  }

  /** Read memory (RAM, flash, peripherals). While running, it stops for the moment of the read. */
  readMemory(addr: number, length: number): Promise<Uint8Array> {
    return this.run(async () => {
      const start = (addr & ~3) >>> 0;
      const words = Math.ceil((addr + length - start) / 4);
      const wasRunning = !this.halted;
      if (wasRunning) {
        await this.haltNow();
        await this.onHalted("pause", false);
      }
      await this.beforeMemoryOps();
      try {
        const data = (await this.readWords(start, words)).slice(addr - start, addr - start + length);
        // Breakpoints read as the code they stand in for.
        for (const [a, orig] of this.ramOrig) {
          for (let k = 0; k < 2; k++) if (a + k - addr >= 0 && a + k - addr < data.length) data[a + k - addr] = orig[k];
        }
        for (const a of this.inserted.filter((x) => !inRam(x))) {
          const img = this.flashed?.image;
          for (const base of [0, FLASH_BASE]) {
            for (let k = 0; k < 2; k++) {
              const at = base + a + k - addr;
              if (img && at >= 0 && at < data.length) data[at] = img[a + k];
            }
          }
        }
        return data;
      } finally {
        if (wasRunning && this.cause === "pause") await this.resumeNow();
        else await this.settle();
      }
    });
  }

  writeMemory(addr: number, data: Uint8Array): Promise<void> {
    return this.run(async () => {
      if (!this.halted) throw new Error("Pause the program to change memory");
      if (flashOffset(addr) >= 0) throw new Error("The flash can't be changed from here (flash the program again)");
      await this.beforeMemoryOps();
      const start = (addr & ~3) >>> 0;
      const words = Math.ceil((addr + data.length - start) / 4);
      const buf = start === addr && data.length % 4 === 0 ? new Uint8Array(data) : await this.readWords(start, words);
      buf.set(data, addr - start);
      for (let w = 0; w < words; w += 20) {
        const cmds: number[] = [];
        const n = Math.min(20, words - w);
        for (let i = 0; i < n; i++) cmds.push(0xfe, 0x08, ...bytes32(start + (w + i) * 4), ...bytes32(le32(buf, (w + i) * 4)));
        const r = await this.x(cmds, n);
        const bad = [...r.subarray(0, n)].findIndex((s) => s !== 0);
        if (bad >= 0) {
          await this.clearCmdErr();
          throw new Error(`Writing ${hex(start + (w + bad) * 4)} failed`);
        }
      }
      await this.clearCmdErr();
      await this.settle();
    });
  }

  // ---- breakpoints in flash ----

  setBreakpoints(addrs: number[]): void {
    this.wanted = [...new Set(addrs.map((a) => (flashOffset(a) >= 0 ? flashOffset(a) : inRam(a) ? a >>> 0 : -1)).filter((a) => a >= 0 && !(a & 1)))].sort((a, b) => a - b);
  }

  private validBreakpoints(): number[] {
    const img = this.flashed?.image;
    // In RAM: always (they don't need the image). In flash: only with the image that's in it.
    // RAM ones wait while the start-up code is still to copy the RAM code (after a restart).
    const list = this.wanted.filter((a) => (inRam(a) ? !this.ramHeld : !!img && a + 2 <= img.length));
    if (this.rearm !== undefined && !list.includes(this.rearm)) list.push(this.rearm);
    // Always one on ch32fun's handler for faults and unhandled interrupts: a crash stops right
    // there (and says why), instead of the program spinning in it.
    const handler = this.crashHandler();
    if (handler !== undefined && !list.includes(handler)) list.push(handler);
    return list;
  }

  /** Where ch32fun's DefaultIRQHandler is (every fault and unhandled interrupt ends up there). */
  private crashHandler(): number | undefined {
    const f = this.flashed?.funcs.find((fn) => fn.name === "DefaultIRQHandler");
    return f && flashOffset(f.addr) >= 0 ? flashOffset(f.addr) : undefined;
  }

  /** Why the program crashed, in words, when it did. */
  crashReason(): string | undefined {
    const c = this.crash;
    if (!c) return undefined;
    if (c.mcause >>> 31) {
      return `interrupt ${c.mcause & 0xff} fired, but the program has no handler for it (it was enabled, but no function with that interrupt's name was written), at 0x${c.mepc.toString(16)}`;
    }
    const code = c.mcause & 0xff;
    const what = EXCEPTIONS[code] ?? `exception ${code}`;
    // (The QingKe V2 leaves mtval at 0, where other RISC-V cores put the bad address.)
    const addr = [4, 5, 6, 7].includes(code) && c.mtval ? ` (the address was 0x${c.mtval.toString(16)})` : "";
    return `${what}${addr}, at 0x${c.mepc.toString(16)}`;
  }

  /**
   * Make flash and RAM hold exactly these breakpoints. In flash only the pages that change are
   * written; in RAM the ebreak goes straight into the code (and its bytes are kept to put back).
   */
  private async sync(want: number[]): Promise<void> {
    const img = this.flashed?.image;
    const flashWant = img ? want.filter((a) => !inRam(a)) : [];
    const flashHave = this.inserted.filter((a) => !inRam(a));
    const pageOf = (list: number[]) => {
      const m = new Map<number, string>();
      for (const a of list) m.set(a & ~(PAGE - 1), `${m.get(a & ~(PAGE - 1)) ?? ""},${a}`);
      return m;
    };
    const before = pageOf(flashHave), after = pageOf(flashWant);
    const pages = img ? [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)) : [];
    if (pages.length) {
      await this.beforeMemoryOps();
      for (let i = 0; i < pages.length; i += 3) {
        const cmds: number[] = [];
        const n = Math.min(3, pages.length - i);
        for (const page of pages.slice(i, i + n)) {
          const data = new Uint8Array(PAGE).fill(0xff);
          data.set(img!.subarray(page, page + PAGE));
          for (const a of flashWant) if ((a & ~(PAGE - 1)) === page) data.set(C_EBREAK, a - page);
          cmds.push(0xfe, 0x0b, ...bytes32(FLASH_BASE + page), ...data);
        }
        const r = await this.x(cmds, n);
        const bad = [...r.subarray(0, n)].findIndex((s) => s !== 0);
        if (bad >= 0) throw new Error(`Writing a breakpoint into flash at ${hex(FLASH_BASE + pages[i + bad])} failed`);
      }
      this.trace?.(`flash pages rewritten for breakpoints: ${pages.map((p) => hex(p)).join(", ")}`);
    }
    // RAM: out the ones no longer wanted, in the new ones.
    const ramWant = want.filter(inRam);
    for (const a of [...this.ramOrig.keys()]) if (!ramWant.includes(a)) await this.patchRam(a, this.ramOrig.get(a)!);
    for (const a of ramWant) if (!this.ramOrig.has(a)) await this.patchRam(a);
    this.inserted = [...flashWant, ...ramWant.filter((a) => this.ramOrig.has(a))];
  }

  /** Put an ebreak at a RAM address (keeping what was there), or the original bytes back. */
  private async patchRam(a: number, original?: [number, number]): Promise<void> {
    await this.beforeMemoryOps();
    const w = (a & ~3) >>> 0, o = a - w;
    const word = await this.readWords(w, 1);
    if (original) {
      word.set(original, o);
      this.ramOrig.delete(a);
    } else {
      this.ramOrig.set(a, [word[o], word[o + 1]]);
      word.set(C_EBREAK, o);
    }
    this.dirty = true;
    const r = await this.x([0xfe, 0x08, ...bytes32(w), ...bytes32(le32(word, 0))], 1);
    await this.clearCmdErr();
    if (r[0] !== 0) {
      if (!original) this.ramOrig.delete(a);
      throw new Error(`Writing a breakpoint into RAM at ${hex(a)} failed`);
    }
    this.trace?.(`RAM breakpoint ${original ? "out" : "in"} at ${hex(a)}`);
  }

}

/**
 * Whether an instruction does the same wherever it runs: not a jump, branch, call or return, not
 * auipc (pc-relative), not ebreak/ecall/mret/wfi.
 */
function displaceable(insn: number, size: number): boolean {
  if (size === 2) {
    const q = insn & 3, f3 = insn >>> 13;
    if (q === 1 && (f3 === 1 || f3 === 5 || f3 === 6 || f3 === 7)) return false; // c.jal, c.j, c.beqz, c.bnez
    if (q === 2 && f3 === 4 && ((insn >> 2) & 31) === 0) return false; // c.jr, c.jalr, c.ebreak
    return insn !== 0;
  }
  const op = insn & 0x7f;
  if (op === 0x6f || op === 0x67 || op === 0x63 || op === 0x17) return false; // jal, jalr, branches, auipc
  if (op === 0x73 && ((insn >> 12) & 7) === 0) return false; // ecall, ebreak, mret, wfi
  return true;
}

/** An error of the link to the programmer (USB), rather than of the chip behind it. */
function isLinkError(e: unknown): boolean {
  return e instanceof DOMException || /^funprog:|^Not connected/.test((e as Error)?.message ?? "");
}
