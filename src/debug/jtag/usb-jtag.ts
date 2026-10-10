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

export const isWebUsbSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

export class UsbJtag {
  private device?: USBDevice;
  private iface = 0;
  private epOut = 0;
  private epIn = 0;

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
      const out = await this.dev().transferOut(this.epOut, bytes);
      if (out.status !== "ok") throw new Error(`JTAG write failed (${out.status})`);
      const need = Math.ceil(captured / 8);
      const got = new Uint8Array(need);
      for (let have = 0; have < need;) {
        const r = await this.dev().transferIn(this.epIn, 64);
        if (r.status !== "ok") throw new Error(`JTAG read failed (${r.status})`);
        const chunk = new Uint8Array(r.data!.buffer, r.data!.byteOffset, r.data!.byteLength);
        got.set(chunk.subarray(0, need - have), have);
        have += chunk.length;
      }
      for (let i = 0; i < captured; i++) result.push((got[i >> 3] >> (i & 7)) & 1);
    }
    return result;
  }
}

/** The TAP state machine on top of the adapter. Starts and ends every scan in Run-Test/Idle. */
export class Tap {
  constructor(private readonly probe: UsbJtag, private readonly irLength: number) {}

  /** Five TMS=1 clocks reach Test-Logic-Reset from anywhere; then go to Run-Test/Idle. */
  async reset(): Promise<void> {
    await this.probe.clock([1, 1, 1, 1, 1, 0], [0, 0, 0, 0, 0, 0], new Array(6).fill(false));
  }

  async shiftIR(value: number): Promise<void> {
    await this.scan([1, 1, 0, 0], value, this.irLength);
  }

  /** Shift up to 32 bits through the selected data register; returns what came out. */
  shiftDR(value: number, length: number): Promise<number> {
    return this.scan([1, 0, 0], value, length);
  }

  private async scan(prefix: number[], value: number, length: number): Promise<number> {
    const tms = [...prefix], tdi = prefix.map(() => 0), cap = prefix.map(() => false);
    for (let i = 0; i < length; i++) {
      tms.push(i === length - 1 ? 1 : 0);
      tdi.push(i < 32 ? (value >>> i) & 1 : 0);
      cap.push(true);
    }
    tms.push(1, 0); // Update, then Run-Test/Idle
    tdi.push(0, 0);
    cap.push(false, false);
    const bits = await this.probe.clock(tms, tdi, cap);
    let out = 0;
    for (let i = 0; i < Math.min(length, 32); i++) out |= bits[i] << i;
    return out >>> 0;
  }
}
