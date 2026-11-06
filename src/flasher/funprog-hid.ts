/**
 * Flash a CH32V003 through a funprog programmer (ch32fun's programmer core) over
 * WebHID: the ESP32-S3 example funprog › CH32V003_Programmer, or cnlohr's ESP32-S2
 * programmer. It speaks to the chip's single-wire debug interface (SWIO on PD1),
 * so no bootloader is needed on the CH32V003.
 *
 * The protocol is minichlink's (minichlink/pgm-esp32s2-ch32xx.c): commands go out
 * in a HID feature report, padded with 0xff; the reply is read back with a
 * feature-report read whose first byte is the reply length (0xff: not ready yet).
 *  - fe fd 00              switch to RISC-V mode → version, mode, minor, capabilities
 *  - fe 03 / fe 02         target power on / off
 *  - fe 04 us16            delay
 *  - fe 0e                 initialise SWIO → status
 *  - fe 05                 forget the programmer's cached state (after a halt)
 *  - fe 10                 identify the chip → ce, 0x7f-id ×4, chip id ×2
 *  - fe 0b addr32 data×64  erase and write a 64-byte block → status
 *  - fe 09 addr32          read a word → status, word
 *  - (reg-1)<<1|1 value32  write a debug-module register
 */

// Minimal WebHID types (the API isn't in TypeScript's DOM library).
interface HIDDevice {
  opened: boolean;
  vendorId: number;
  productId: number;
  productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}
interface HID {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: { filters: { vendorId?: number; productId?: number; usagePage?: number }[] }): Promise<HIDDevice[]>;
  addEventListener(type: "disconnect", listener: (e: Event & { device: HIDDevice }) => void): void;
  removeEventListener(type: "disconnect", listener: (e: Event & { device: HIDDevice }) => void): void;
}
const hid = (): HID | undefined => (navigator as Navigator & { hid?: HID }).hid;

/** USB IDs minichlink looks for: cnlohr's ESP32-S2 programmer, used by the ESP32-S3 example too. */
const FILTERS = [
  { vendorId: 0x303a, productId: 0x4004 },
  { vendorId: 0x1206, productId: 0x5d10 }, // rv003usb programmer (a CH32V003 itself)
];
/** Feature report 0xae: the ID and 263 bytes, the largest funprog takes. */
const REPORT_ID = 0xae;
const REPORT_LEN = 263;
const FLASH_BASE = 0x08000000;
const BLOCK = 64;
export const FUNPROG_MAX_APP = 16 * 1024;

const DMCONTROL = 0x10;
const DMCFGR = 0x7d;
const DMSHDWCFGR = 0x7e;

export function webHidSupported(): boolean {
  return !!hid();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const hex = (v: number, n = 8) => `0x${(v >>> 0).toString(16).padStart(n, "0")}`;

/**
 * One exchange at a time per programmer, across every FunprogHid that uses it (the inspector's
 * session, the flasher, a session still closing while a new one opens): interleaved feature
 * reports would mix up their commands and replies.
 */
const exchanges = new WeakMap<HIDDevice, Promise<unknown>>();
/** How many FunprogHid objects have the device open: the last one to close it closes it. */
const users = new WeakMap<HIDDevice, number>();

export class FunprogHid {
  private constructor(private readonly dev: HIDDevice, private readonly log: (text: string) => void) {}

  /**
   * The programmer this site was allowed to use before, or ask for one (needs a user gesture).
   * `quiet`: only one allowed before; never the browser's picker.
   */
  static async pick(log: (text: string) => void, quiet = false): Promise<FunprogHid> {
    const api = hid();
    if (!api) throw new Error("This browser has no WebHID (use Chrome or Edge)");
    const known = (await api.getDevices()).filter((d) => FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    if (!known.length && quiet) throw new Error("No funprog programmer is plugged in (or this page wasn't allowed to use it yet)");
    const dev = known[0] ?? (await api.requestDevice({ filters: FILTERS }))[0];
    if (!dev) throw new Error("No programmer selected");
    return new FunprogHid(dev, log);
  }

  /** Call `lost` when this programmer is unplugged; returns a function that stops watching. */
  watchUnplug(lost: () => void): () => void {
    const api = hid();
    const listener = (e: Event & { device: HIDDevice }) => {
      if (e.device === this.dev) lost();
    };
    api?.addEventListener("disconnect", listener);
    return () => api?.removeEventListener("disconnect", listener);
  }

  get name(): string {
    return this.dev.productName || "funprog programmer";
  }

  /** Whether this FunprogHid holds the device open (it's shared: see `users`). */
  private holds = false;

  async open(): Promise<void> {
    if (!this.holds) {
      this.holds = true;
      users.set(this.dev, (users.get(this.dev) ?? 0) + 1);
    }
    if (!this.dev.opened) await this.dev.open();
  }

  /** Let go of the device; it's closed when nothing else uses it (after any exchange in progress). */
  async close(): Promise<void> {
    if (!this.holds) return;
    this.holds = false;
    const left = (users.get(this.dev) ?? 1) - 1;
    users.set(this.dev, left);
    if (left > 0) return;
    await (exchanges.get(this.dev) ?? Promise.resolve());
    if ((users.get(this.dev) ?? 0) === 0 && this.dev.opened) await this.dev.close().catch(() => {});
  }

  /**
   * Send commands in one report and read the reply: at least `replyLen` bytes, or as many as
   * the programmer says it has (commands with variable-length replies, like the terminal).
   */
  transact(cmds: number[], replyLen: number): Promise<Uint8Array> {
    const run = () => this.exchange(cmds, replyLen);
    const next = (exchanges.get(this.dev) ?? Promise.resolve()).then(run, run);
    exchanges.set(this.dev, next.catch(() => {}));
    return next;
  }

  private async exchange(cmds: number[], replyLen: number): Promise<Uint8Array> {
    if (cmds.length > REPORT_LEN - 1) throw new Error(`funprog: ${cmds.length} bytes of commands don't fit a report`);
    const report = new Uint8Array(REPORT_LEN).fill(0xff);
    report.set(cmds);
    const start = performance.now();
    await this.dev.sendFeatureReport(REPORT_ID, report);
    for (;;) {
      const view = await this.dev.receiveFeatureReport(REPORT_ID);
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const waited = performance.now() - start;
      // Byte 0 is the reply length; 0xff means the programmer is still busy.
      if (bytes[0] === 0xff && replyLen < 0xff) {
        if (waited > 3000) throw new Error(`funprog: the programmer doesn't answer (busy for ${Math.round(waited)} ms with commands ${hex(cmds[0], 2)} ${hex(cmds[1] ?? 0, 2)}…)`);
        await sleep(2);
        continue;
      }
      if (waited > 250) console.warn(`funprog: a reply took ${Math.round(waited)} ms (commands ${cmds.slice(0, 8).map((c) => c.toString(16)).join(" ")}…)`);
      const got = bytes.subarray(1, 1 + Math.max(replyLen, bytes[0]));
      if (got.length < replyLen) throw new Error(`funprog: short reply (${got.length} of ${replyLen} bytes)`);
      return got;
    }
  }

  /** Command: write a debug-module register. */
  static writeReg(reg: number, value: number): number[] {
    return [((reg - 1) << 1) | 1, ...le32(value)];
  }

  /** Command: read a debug-module register (5 bytes of reply: status, value). */
  static readReg(reg: number): number[] {
    return [(reg - 1) << 1];
  }

  /** Find the programmer and the chip, and halt the chip. */
  async connect(): Promise<void> {
    const v = await this.transact([0xfe, 0xfd, 0x00], 5);
    this.log(`${this.name}: funprog firmware ${v[0]}.${String(v[2]).padStart(2, "0")}, capabilities ${hex((v[3] << 8) | v[4], 4)}`);

    // Power up, give the target time to start, then find its debug interface.
    // A chip asleep in standby has its debug link off; one that wakes up now and then (an
    // auto-wakeup example) answers while it's awake: keep trying for a few seconds.
    let init = await this.transact([0xfe, 0x03, 0xfe, 0x04, ...le32(20000).slice(0, 2), 0xfe, 0x0e], 1);
    const until = performance.now() + 30000;
    if (init[0] !== 0) {
      this.log("The CH32V003 doesn't answer. If its program puts it in standby, its debug link is off: power the CH32V003 off and on now (unplug its 3V3 for a moment); trying for 30 s…");
    }
    while (init[0] !== 0 && performance.now() < until) {
      await sleep(50);
      init = await this.transact([0xfe, 0x0e], 1);
    }
    if (init[0] !== 0) {
      throw new Error(`No CH32V003 answers on SWIO (code ${(init[0] << 24) >> 24}). Check the wiring (programmer SWIO → PD1, 3V3 and GND), or power the CH32V003 off and on while Flash is trying: a program that puts the chip in standby turns its debug link off.`);
    }

    // Halt (minichlink's HALT_MODE_HALT_BUT_NO_RESET).
    await this.transact([
      ...FunprogHid.writeReg(DMSHDWCFGR, 0x5aa50000 | (1 << 10)),
      ...FunprogHid.writeReg(DMCFGR, 0x5aa50000 | (1 << 10)),
      ...FunprogHid.writeReg(DMCONTROL, 0x80000001),
      ...FunprogHid.writeReg(DMCONTROL, 0x80000001),
      ...FunprogHid.writeReg(DMCONTROL, 0x80000001),
      0xfe, 0x04, ...le32(10000).slice(0, 2),
      0xfe, 0x05,
    ], 0);

    const id = await this.transact([0xfe, 0x10], 7);
    if (id[0] !== 0xce) throw new Error(`funprog: unexpected reply to chip detection (${hex(id[0], 2)})`);
    const sevenf = (id[1] | (id[2] << 8) | (id[3] << 16) | (id[4] << 24)) >>> 0;
    const chip = id[5] | (id[6] << 8);
    if (!sevenf && !chip) throw new Error("funprog: couldn't identify the chip");
    if (chip & 0x8000) throw new Error("The chip's flash is read-protected (unprotect it with minichlink -u, which erases it)");
    this.log(`Target: debug id ${hex(sevenf)}, chip ${hex(chip & 0x7fff, 4)}`);
  }

  /** Erase and write the image from the start of flash (64-byte blocks), then verify it. */
  async flash(image: Uint8Array, progress: (pct: number, stage: string) => void): Promise<void> {
    if (image.length > FUNPROG_MAX_APP) throw new Error(`The program is ${image.length} bytes; the CH32V003 has 16384 bytes of flash`);
    const padded = new Uint8Array(Math.ceil(image.length / BLOCK) * BLOCK).fill(0xff);
    padded.set(image);
    const blocks = padded.length / BLOCK;

    // Three blocks per report (70 bytes of command each).
    const PER = 3;
    for (let b = 0; b < blocks; b += PER) {
      const cmds: number[] = [];
      const n = Math.min(PER, blocks - b);
      for (let i = 0; i < n; i++) {
        const off = (b + i) * BLOCK;
        cmds.push(0xfe, 0x0b, ...le32(FLASH_BASE + off), ...padded.subarray(off, off + BLOCK));
      }
      const r = await this.transact(cmds, n);
      const bad = [...r.subarray(0, n)].findIndex((s) => s !== 0);
      if (bad >= 0) throw new Error(`Writing the block at ${hex(FLASH_BASE + (b + bad) * BLOCK)} failed (code ${(r[bad] << 24) >> 24})`);
      progress(Math.round(((b + n) / blocks) * 100), "Writing");
    }

    // Read it back, 40 words per report (5 bytes of reply each).
    const words = padded.length / 4;
    const PER_READ = 40;
    for (let w = 0; w < words; w += PER_READ) {
      const n = Math.min(PER_READ, words - w);
      const cmds: number[] = [];
      for (let i = 0; i < n; i++) cmds.push(0xfe, 0x09, ...le32(FLASH_BASE + (w + i) * 4));
      const r = await this.transact(cmds, n * 5);
      for (let i = 0; i < n; i++) {
        const at = (w + i) * 4;
        const ok = r[i * 5] === 0 && [0, 1, 2, 3].every((k) => r[i * 5 + 1 + k] === padded[at + k]);
        if (!ok) throw new Error(`Verify failed at ${hex(FLASH_BASE + at)}`);
      }
      progress(Math.round(((w + n) / words) * 100), "Verifying");
    }
  }

  /** Reset the chip and let it run (minichlink's HALT_MODE_REBOOT). */
  async run(): Promise<void> {
    await this.transact([
      ...FunprogHid.writeReg(DMCONTROL, 0x80000001),
      ...FunprogHid.writeReg(DMCONTROL, 0x80000001),
      ...FunprogHid.writeReg(DMCONTROL, 0x80000003),
      ...FunprogHid.writeReg(DMCONTROL, 0x40000001),
      0xfe, 0x05,
    ], 0);
  }
}
