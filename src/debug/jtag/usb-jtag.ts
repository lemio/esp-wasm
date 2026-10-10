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

/** Receives one line per event on the wire; layers prefix their lines (USB, TAP, OCD). */
export type Trace = (line: string) => void;

const hexBytes = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join(" ");

export const isWebUsbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

export class UsbJtag {
  private device?: USBDevice;
  private iface = 0;
  private epOut = 0;
  private epIn = 0;
  trace?: Trace;

  get connected(): boolean {
    return !!this.device?.opened;
  }

  get description(): string {
    return this.device ? `${this.device.productName ?? "USB JTAG"} (${this.device.serialNumber ?? "no serial"})` : "";
  }

  /** Ask the user for the chip's USB-JTAG device and open it. */
  async connect(): Promise<void> {
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: ESPRESSIF_VID }] });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    // The JTAG function is the vendor-specific interface (class 0xff) with a bulk IN and OUT endpoint.
    const alt = device.configuration!.interfaces
      .flatMap((i) => i.alternates.map((a) => ({ number: i.interfaceNumber, alt: a })))
      .find((x) => x.alt.interfaceClass === 0xff && x.alt.endpoints.some((e) => e.direction === "in") &&
        x.alt.endpoints.some((e) => e.direction === "out"));
    if (!alt) {
      await device.close();
      throw new Error("This USB device has no JTAG interface. Use the ESP32-S3's native USB port.");
    }
    await device.claimInterface(alt.number);
    this.iface = alt.number;
    this.epOut = alt.alt.endpoints.find((e) => e.direction === "out")!.endpointNumber;
    this.epIn = alt.alt.endpoints.find((e) => e.direction === "in")!.endpointNumber;
    this.device = device;
    this.trace?.(`USB opened ${this.description}: vid ${device.vendorId.toString(16)} pid ${device.productId.toString(16)}, interface ${this.iface}, OUT ep ${this.epOut}, IN ep ${this.epIn}`);
    await this.setDivider(20); // base clock 40 MHz → 2 MHz TCK
  }

  async disconnect(): Promise<void> {
    const d = this.device;
    this.device = undefined;
    if (d?.opened) {
      await d.releaseInterface(this.iface).catch(() => {});
      await d.close().catch(() => {});
    }
  }

  private async setDivider(div: number): Promise<void> {
    this.trace?.(`USB control OUT vendor SETDIV ${div}`);
    await this.dev().controlTransferOut(
      { requestType: "vendor", recipient: "interface", request: VEND_JTAG_SETDIV, value: div, index: this.iface },
    );
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
      const out = await this.dev().transferOut(this.epOut, bytes);
      if (out.status !== "ok") throw new Error(`JTAG write failed (${out.status})`);
      const need = Math.ceil(captured / 8);
      const got = new Uint8Array(need);
      for (let have = 0; have < need;) {
        const r = await this.dev().transferIn(this.epIn, 64);
        if (r.status !== "ok") throw new Error(`JTAG read failed (${r.status})`);
        const chunk = new Uint8Array(r.data!.buffer, r.data!.byteOffset, r.data!.byteLength);
        this.trace?.(`USB IN  ${chunk.length}B (want ${need - have}): ${hexBytes(chunk)}`);
        got.set(chunk.subarray(0, need - have), have);
        have += chunk.length;
      }
      for (let i = 0; i < captured; i++) result.push((got[i >> 3] >> (i & 7)) & 1);
    }
    return result;
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
