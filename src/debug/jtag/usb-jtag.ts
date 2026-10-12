/**
 * The ESP32-S3's built-in USB-JTAG adapter over WebUSB (VID 303a, PID 1001).
 * Protocol: Espressif's "esp_usb_jtag" (see OpenOCD's esp_usb_jtag.c): commands are
 * nibbles on a bulk OUT endpoint, captured TDO bits come back on the bulk IN endpoint,
 * and the clock divider is set with a vendor control request.
 */
const ESPRESSIF_VID = 0x303a;
const VEND_JTAG_SETDIV = 0;
const CMD_RST_SRST0 = 0x8;
const CMD_FLUSH = 0xa;
/** Clocks per USB round trip; keeps the device's small IN buffer from overflowing. */
const MAX_CLOCKS = 256;
/** The adapter answers a flush within a millisecond or two; anything this slow means it's stuck or gone. */
const TRANSFER_TIMEOUT_MS = 1000;
const DIVIDER = 20; // base clock 40 MHz → 2 MHz TCK

/** Receives one line per event on the wire; layers prefix their lines (USB, TAP, OCD). */
export type Trace = (line: string) => void;

const hexBytes = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

export const isWebUsbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`JTAG adapter didn't answer (${what} timed out)`)), TRANSFER_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class UsbJtag {
  private device?: USBDevice;
  private iface = 0;
  private epOut = 0;
  private epIn = 0;
  trace?: Trace;
  /**
   * Bumped whenever the USB link was re-opened after a failed transfer: the TAP's state is
   * unknown then, so the layers above must reset it before the next scan.
   */
  resets = 0;
  /** Called once when the device goes away (unplugged, or the chip reset and re-enumerated). */
  onLost?: (reason: string) => void;

  get connected(): boolean {
    return !!this.device?.opened;
  }

  get description(): string {
    return this.device ? `${this.device.productName ?? "USB JTAG"} (${this.device.serialNumber ?? "no serial"})` : "";
  }

  /**
   * Open the chip's USB-JTAG device: the one this page was allowed before, else ask the user
   * (unless `quiet`: then it fails instead of showing the picker).
   */
  async connect(quiet = false): Promise<void> {
    const known = (await navigator.usb.getDevices()).filter((d) => d.vendorId === ESPRESSIF_VID);
    if (quiet && known.length !== 1) throw new Error("No ESP32-S3 USB-JTAG device allowed yet");
    const device = known.length === 1 ? known[0] : await navigator.usb.requestDevice({ filters: [{ vendorId: ESPRESSIF_VID }] });
    try {
      await this.open(device);
    } catch (e) {
      await device.close().catch(() => {});
      throw e;
    }
    navigator.usb.addEventListener("disconnect", this.unplugged);
  }

  private async open(device: USBDevice): Promise<void> {
    if (!device.opened) await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    // The JTAG function is the vendor-specific interface (class 0xff) with a bulk IN and OUT endpoint.
    const alt = device.configuration!.interfaces
      .flatMap((i) => i.alternates.map((a) => ({ number: i.interfaceNumber, alt: a })))
      .find((x) => x.alt.interfaceClass === 0xff && x.alt.endpoints.some((e) => e.direction === "in") &&
        x.alt.endpoints.some((e) => e.direction === "out"));
    if (!alt) throw new Error("This USB device has no JTAG interface. Use the ESP32-S3's native USB port.");
    await device.claimInterface(alt.number);
    this.iface = alt.number;
    this.epOut = alt.alt.endpoints.find((e) => e.direction === "out")!.endpointNumber;
    this.epIn = alt.alt.endpoints.find((e) => e.direction === "in")!.endpointNumber;
    this.device = device;
    this.trace?.(`USB opened ${this.description}: vid ${device.vendorId.toString(16)} pid ${device.productId.toString(16)}, interface ${this.iface}, OUT ep ${this.epOut}, IN ep ${this.epIn}`);
    try {
      await this.setDivider(DIVIDER);
    } catch {
      // The adapter doesn't even answer a control request: reset the USB device (the chip's
      // USB Serial/JTAG controller; the program keeps running) and try once more.
      this.trace?.("USB adapter not answering: resetting the USB device");
      await withTimeout(device.reset(), "USB reset").catch(() => {});
      if (!device.opened) await device.open();
      await device.claimInterface(this.iface).catch(() => {});
      await this.setDivider(DIVIDER).catch(() => {
        throw new Error("The chip's USB JTAG adapter doesn't answer. Unplug the board, plug it back in, and connect again.");
      });
    }
    await this.drain();
  }

  /**
   * Throw away TDO bytes an earlier session left in the adapter (a page closed mid-exchange):
   * closing the device doesn't clear them, and they'd shift every read after. Reads until
   * nothing comes; the read left waiting is then cancelled by re-opening the device.
   */
  private async drain(): Promise<void> {
    const d = this.device!;
    let stale = 0;
    // One read stays outstanding throughout; it's cancelled by re-opening the device at the end.
    let pending = d.transferIn(this.epIn, 64);
    const untilQuiet = async () => {
      for (let reads = 0; stale < 4096 && reads < 200; reads++) {
        const r = await Promise.race([pending, new Promise<undefined>((ok) => setTimeout(ok, 30))]);
        if (!r) return;
        pending = d.transferIn(this.epIn, 64);
        // The adapter answers with empty packets when it has nothing: nothing stale, then.
        if (!r.data?.byteLength) return;
        stale += r.data.byteLength;
      }
    };
    // Read what's waiting first: an adapter whose replies weren't collected accepts no new
    // commands. Then flush captured bits it still holds, and collect those too.
    await untilQuiet();
    await withTimeout(d.transferOut(this.epOut, new Uint8Array([(CMD_FLUSH << 4) | CMD_FLUSH])), "flush").catch(() => {});
    await untilQuiet();
    pending.catch(() => {}); // rejected when the device is closed below
    if (stale) this.trace?.(`USB drained ${stale} stale bytes left by an earlier session`);
    // A read is still waiting: cancel it, or it would swallow the next answer.
    await d.releaseInterface(this.iface).catch(() => {});
    await d.close().catch(() => {});
    await d.open();
    await d.claimInterface(this.iface);
    await this.setDivider(DIVIDER);
  }

  async disconnect(): Promise<void> {
    navigator.usb?.removeEventListener("disconnect", this.unplugged);
    const d = this.device;
    this.device = undefined;
    if (d?.opened) {
      await d.releaseInterface(this.iface).catch(() => {});
      await d.close().catch(() => {});
    }
  }

  private readonly unplugged = (e: USBConnectionEvent) => {
    if (e.device !== this.device) return;
    this.trace?.("USB device disconnected");
    this.device = undefined;
    navigator.usb.removeEventListener("disconnect", this.unplugged);
    this.onLost?.("The ESP32-S3 disconnected from USB (it reset, was re-flashed or was unplugged)");
  };

  /**
   * After a failed or timed-out transfer, the adapter may still owe us IN data (which would
   * shift every later read) and a WebUSB transfer can't be cancelled on its own. Closing the
   * device aborts it and drops the buffers; then open it again.
   */
  async recover(): Promise<void> {
    const d = this.device;
    if (!d) return;
    this.trace?.("USB link out of sync: re-opening the device");
    this.resets++;
    await d.releaseInterface(this.iface).catch(() => {});
    await d.close().catch(() => {});
    try {
      await this.open(d);
    } catch (e) {
      this.device = undefined;
      navigator.usb.removeEventListener("disconnect", this.unplugged);
      this.onLost?.(`Lost the JTAG adapter: ${(e as Error).message}`);
      throw e;
    }
  }

  private async setDivider(div: number): Promise<void> {
    this.trace?.(`USB control OUT vendor SETDIV ${div}`);
    await withTimeout(this.dev().controlTransferOut(
      { requestType: "vendor", recipient: "interface", request: VEND_JTAG_SETDIV, value: div, index: this.iface },
    ), "clock setting");
  }

  private dev(): USBDevice {
    if (!this.device) throw new Error("JTAG adapter isn't connected");
    return this.device;
  }

  /**
   * Clock the TAP once per entry of `tms`, with TDI from `tdi` (same length), and
   * return the TDO bit of every clock where `capture` is set.
   */
  async clock(tms: number[], tdi: number[], capture: boolean[]): Promise<number[]> {
    const result: number[] = [];
    for (let start = 0; start < tms.length; start += MAX_CLOCKS) {
      const end = Math.min(tms.length, start + MAX_CLOCKS);
      const nibbles: number[] = [];
      let captured = 0;
      for (let i = start; i < end; i++) {
        nibbles.push((capture[i] ? 4 : 0) | (tms[i] ? 2 : 0) | (tdi[i] ? 1 : 0));
        if (capture[i]) captured++;
      }
      if (nibbles.length % 2 === 0) nibbles.push(CMD_RST_SRST0); // keep the flush on a byte boundary
      nibbles.push(CMD_FLUSH);
      const bytes = new Uint8Array(nibbles.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
      this.trace?.(`USB OUT ${bytes.length}B (${end - start} clocks, ${captured} captured): ${hexBytes(bytes)}`);
      let got: Uint8Array;
      try {
        got = await this.transfer(bytes, Math.ceil(captured / 8));
      } catch (e) {
        this.trace?.(`USB error: ${(e as Error).message}`);
        if (this.device) await this.recover().catch(() => {});
        throw e;
      }
      for (let i = 0; i < captured; i++) result.push((got[i >> 3] >> (i & 7)) & 1);
    }
    return result;
  }

  /** One OUT transfer and the `need` bytes of TDO it produces. */
  private async transfer(bytes: Uint8Array<ArrayBuffer>, need: number): Promise<Uint8Array> {
    const out = await withTimeout(this.dev().transferOut(this.epOut, bytes), "write");
    if (out.status !== "ok") throw new Error(`JTAG write failed (${out.status})`);
    const got = new Uint8Array(need);
    for (let have = 0; have < need;) {
      const r = await withTimeout(this.dev().transferIn(this.epIn, 64), "read");
      if (r.status !== "ok") throw new Error(`JTAG read failed (${r.status})`);
      const chunk = new Uint8Array(r.data!.buffer, r.data!.byteOffset, r.data!.byteLength);
      this.trace?.(`USB IN  ${chunk.length}B (want ${need - have}): ${hexBytes(chunk)}`);
      // More than we asked for means leftovers of an earlier exchange: every bit from here on is suspect.
      if (chunk.length > need - have) throw new Error(`JTAG adapter sent ${chunk.length - (need - have)} unexpected bytes`);
      got.set(chunk, have);
      have += chunk.length;
    }
    return got;
  }
}

/**
 * The TAP state machine on top of the adapter. Starts and ends every scan in Run-Test/Idle.
 * The chain may hold several TAPs (the ESP32-S3 has one per core): the others are put in BYPASS.
 * Bits shifted first end up in the TAP nearest TDO, which is index 0.
 */
export class Tap {
  private taps = 1;
  private index = 0;
  trace?: Trace;

  constructor(private readonly probe: UsbJtag, private readonly irLength: number) {}

  /** The chain has `taps` TAPs (all with this IR length); talk to the one at `index`. */
  configure(taps: number, index: number): void {
    this.taps = taps;
    this.index = index;
    this.trace?.(`TAP chain: ${taps} TAPs, using #${index}`);
  }

  /** Five TMS=1 clocks reach Test-Logic-Reset from anywhere; then go to Run-Test/Idle. */
  async reset(): Promise<void> {
    this.trace?.("TAP reset (TMS high x5, then idle)");
    await this.probe.clock([1, 1, 1, 1, 1, 0], [0, 0, 0, 0, 0, 0], new Array(6).fill(false));
  }

  /** After a reset every TAP's DR is its IDCODE (or a 1-bit bypass bit): read them all, nearest TDO first. */
  async readIdcodes(max = 4): Promise<number[]> {
    const n = max * 32;
    const tms = [1, 0, 0, ...new Array(n).fill(0), 1, 0];
    tms[2 + n] = 1; // last shift clock leaves Shift-DR
    const tdi = tms.map(() => 1);
    const cap = tms.map((_, i) => i >= 3 && i < 3 + n);
    const bits = await this.probe.clock(tms.slice(0, 3 + n).concat([1, 0]), tdi, cap);
    const ids: number[] = [];
    this.trace?.(`TAP IDCODE scan: raw bits ${bits.join("")}`);
    for (let i = 0; i < n;) {
      if (!bits[i]) { i++; continue; } // a bypass bit (0) of a TAP without IDCODE
      let id = 0;
      for (let b = 0; b < 32 && i + b < n; b++) id |= bits[i + b] << b;
      if ((id >>> 0) === 0xffffffff) break; // our TDI ones coming back: end of chain
      ids.push(id >>> 0);
      i += 32;
    }
    return ids;
  }

  async shiftIR(value: number): Promise<void> {
    this.trace?.(`TAP IR  <- 0x${value.toString(16)} (others BYPASS)`);
    const bits: number[] = [];
    for (let t = 0; t < this.taps; t++) {
      for (let i = 0; i < this.irLength; i++) bits.push(t === this.index ? (value >>> i) & 1 : 1); // 11111 = BYPASS
    }
    await this.scanBits([1, 1, 0, 0], bits, -1, 0);
  }

  /** Shift up to 32 bits through the selected data register; returns what came out. */
  async shiftDR(value: number, length: number): Promise<number> {
    const bits = [
      ...new Array(this.index).fill(0),
      ...Array.from({ length }, (_, i) => (i < 32 ? (value >>> i) & 1 : 0)),
      ...new Array(this.taps - 1 - this.index).fill(0),
    ];
    const out = await this.scanBits([1, 0, 0], bits, this.index, length);
    this.trace?.(`TAP DR${length} <- 0x${(value >>> 0).toString(16)}  -> 0x${out.toString(16)}`);
    return out;
  }

  /** Several data-register scans (each from and back to Run-Test/Idle) in one USB round trip. Returns what came out of each. */
  async shiftDRs(scans: { value: number; length: number }[]): Promise<number[]> {
    const tms: number[] = [], tdi: number[] = [], cap: boolean[] = [];
    for (const { value, length } of scans) {
      const bits = [
        ...new Array(this.index).fill(0),
        ...Array.from({ length }, (_, i) => (i < 32 ? (value >>> i) & 1 : 0)),
        ...new Array(this.taps - 1 - this.index).fill(0),
      ];
      [1, 0, 0].forEach((t) => { tms.push(t); tdi.push(0); cap.push(false); });
      bits.forEach((bit, i) => {
        tms.push(i === bits.length - 1 ? 1 : 0);
        tdi.push(bit);
        cap.push(i >= this.index && i < this.index + length);
      });
      tms.push(1, 0); tdi.push(0, 0); cap.push(false, false);
    }
    const bits = await this.probe.clock(tms, tdi, cap);
    let at = 0;
    return scans.map(({ value, length }) => {
      let out = 0;
      for (let i = 0; i < Math.min(length, 32); i++) out |= bits[at + i] << i;
      at += length;
      out >>>= 0;
      this.trace?.(`TAP DR${length} <- 0x${(value >>> 0).toString(16)}  -> 0x${out.toString(16)}`);
      return out;
    });
  }

  private async scanBits(prefix: number[], data: number[], captureFrom: number, captureLength: number): Promise<number> {
    const tms = [...prefix], tdi = prefix.map(() => 0), cap = prefix.map(() => false);
    data.forEach((bit, i) => {
      tms.push(i === data.length - 1 ? 1 : 0);
      tdi.push(bit);
      cap.push(captureFrom >= 0 && i >= captureFrom && i < captureFrom + captureLength);
    });
    tms.push(1, 0); // Update, then Run-Test/Idle
    tdi.push(0, 0);
    cap.push(false, false);
    const bits = await this.probe.clock(tms, tdi, cap);
    let out = 0;
    for (let i = 0; i < Math.min(captureLength, 32); i++) out |= bits[i] << i;
    return out >>> 0;
  }
}
