/**
 * Flashing a CH32X035 over its own USB port, through the ROM bootloader (WCH's "ISP" protocol over WebUSB;
 * the same one wchisp, github.com/ch32-rs/wchisp, speaks). The chip has to be in its bootloader: hold BOOT
 * while it is plugged in (or while it is reset); it then shows up as a WCH ISP device, VID 4348 or 1A86, PID 55E0.
 *
 * One bulk OUT (0x02) / IN (0x82) endpoint pair on interface 0, 64 bytes per transfer. A request is
 * [command][length, 16 bits LE][body]; the answer is [command][status][length, 16 bits LE][payload], status 0 (or 0x82)
 * meaning OK. The program data is XORed with an 8-byte key made from the chip's UID and ID.
 *
 * Order: identify, read the config (it holds the UID), erase, key, program in 56-byte chunks (and an empty
 * one at the end), key, verify, reset.
 */
export const WCH_ISP_FILTERS = [
  { vendorId: 0x4348, productId: 0x55e0 },
  { vendorId: 0x1a86, productId: 0x55e0 },
];

const EP_OUT = 2;
const EP_IN = 2;
const CMD = { identify: 0xa1, end: 0xa2, key: 0xa3, erase: 0xa4, program: 0xa5, verify: 0xa6, readConfig: 0xa7 };
const CHUNK = 56; // 8 bytes of header + 56 of data = one 64-byte packet
const SECTOR = 1024;
const MIN_ERASE_SECTORS = 8;
/** The CH32X03x family's device type, and the chips (chip IDs) of the family that have a USB port and 62 KB of flash. */
const DEVICE_TYPE_X03X = 0x23;
const CHIPS: Record<number, string> = {
  0x50: "CH32X035R8T6", 0x51: "CH32X035C8T6", 0x5e: "CH32X035F8U6", 0x56: "CH32X035G8U6", 0x5b: "CH32X035G8R6", 0x57: "CH32X035F7P6",
};
const UID_LEN = 8;

export const isWchIspSupported = () => typeof navigator !== "undefined" && "usb" in navigator;

const sum8 = (b: ArrayLike<number>) => Array.from(b as ArrayLike<number>).reduce((a, x) => (a + x) & 0xff, 0);
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

export class WchIsp {
  private constructor(private readonly dev: USBDevice, private readonly log: (text: string) => void) {}

  /**
   * A bootloader device this page was allowed to use before, or ask for one (needs a user gesture).
   * `quiet`: only one allowed before; never the browser's picker.
   */
  static async pick(log: (text: string) => void, quiet = false): Promise<WchIsp> {
    if (!isWchIspSupported()) throw new Error("This browser has no WebUSB (use Chrome or Edge)");
    const known = (await navigator.usb.getDevices()).filter((d) => WCH_ISP_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId));
    if (!known.length && quiet) throw new Error("No CH32X035 in its USB bootloader is connected (or this page wasn't allowed to use it yet)");
    const dev = known[0] ?? (await navigator.usb.requestDevice({ filters: WCH_ISP_FILTERS }));
    return new WchIsp(dev, log);
  }

  async open(): Promise<void> {
    if (!this.dev.opened) await this.dev.open();
    if (this.dev.configuration?.configurationValue !== 1) await this.dev.selectConfiguration(1);
    await this.dev.claimInterface(0);
  }

  async close(): Promise<void> {
    try {
      await this.dev.releaseInterface(0).catch(() => {});
      await this.dev.close();
    } catch {
      // gone already (it resets when the program starts)
    }
  }

  /** One request and its answer. */
  private async exchange(request: number[], timeoutMs = 3000): Promise<{ status: number; payload: Uint8Array }> {
    await this.dev.transferOut(EP_OUT, new Uint8Array(request));
    const reply = await Promise.race([
      this.dev.transferIn(EP_IN, 64),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the bootloader didn't answer")), timeoutMs)),
    ]);
    const raw = reply.data ? new Uint8Array(reply.data.buffer, reply.data.byteOffset, reply.data.byteLength) : new Uint8Array();
    if (raw.length < 4) throw new Error("the bootloader's answer is too short");
    const status = raw[1], len = raw[2] | (raw[3] << 8);
    if (raw.length - 4 < len) throw new Error("the bootloader's answer is cut short");
    if (status !== 0x00 && status !== 0x82) throw new Error(`the bootloader refused it (status 0x${status.toString(16)})`);
    return { status, payload: raw.slice(4, 4 + len) };
  }

  /** Check what chip this is, and read its UID (the key for the program data comes from it). */
  private async identify(): Promise<{ chipId: number; uid: number[] }> {
    const magic = Array.from(new TextEncoder().encode("MCU ISP & WCH.CN"));
    const id = (await this.exchange([CMD.identify, 0x12, 0x00, 0x00, 0x00, ...magic])).payload;
    const chipId = id[0], deviceType = id[1];
    if (deviceType !== DEVICE_TYPE_X03X) throw new Error(`This isn't a CH32X03x (device type 0x${deviceType.toString(16)}, chip 0x${chipId.toString(16)})`);
    this.log(`USB bootloader: ${CHIPS[chipId] ?? `CH32X03x (chip 0x${chipId.toString(16)})`}`);
    const cfg = (await this.exchange([CMD.readConfig, 0x02, 0x00, 0x1f, 0x00])).payload;
    if (cfg.length < 18 + UID_LEN) throw new Error("the bootloader sent no chip ID (UID)");
    const uid = Array.from(cfg.slice(18, 18 + UID_LEN));
    const w = (i: number) => uid[i] | (uid[i + 1] << 8);
    if (((w(0) + w(2) + w(4)) & 0xffff) !== w(6)) this.log("USB bootloader: the UID's checksum doesn't match (continuing; verify will tell)");
    return { chipId, uid };
  }

  /** The 8-byte key the data is XORed with: from the UID's sum and the chip ID (for an all-zero seed). */
  private async setKey(chipId: number, uid: number[]): Promise<number[]> {
    const checksum = sum8(uid);
    const key = new Array<number>(8).fill(checksum);
    key[7] = (key[7] + chipId) & 0xff;
    const reply = await this.exchange([CMD.key, 0x1e, 0x00, ...new Array<number>(0x1e).fill(0)]);
    if (reply.payload[0] !== sum8(key)) throw new Error("the bootloader's key check failed");
    return key;
  }

  private async sendData(cmd: number, address: number, data: number[], key: number[], timeoutMs: number): Promise<void> {
    const padding = Math.floor(Math.random() * 256);
    const body = data.map((b, i) => b ^ key[i % 8]);
    const len = 5 + body.length;
    const reply = await this.exchange([cmd, len & 0xff, len >> 8, ...le32(address), padding, ...body], timeoutMs);
    if (reply.payload.length && reply.payload[0] !== 0) {
      throw new Error(`${cmd === CMD.verify ? "verify failed: the flash differs" : "programming failed"} at 0x${address.toString(16)}`);
    }
  }

  /** Erase, program and verify `image` (it starts at flash address 0), then start it. */
  async flash(image: Uint8Array, progress: (pct: number, stage: string) => void): Promise<void> {
    progress(0, "Identifying");
    const { chipId, uid } = await this.identify();
    const sectors = Math.max(MIN_ERASE_SECTORS, Math.ceil(image.length / SECTOR));
    progress(0, "Erasing");
    await this.exchange([CMD.erase, 0x04, 0x00, ...le32(sectors)], 8000);

    for (const [stage, cmd, wait] of [["Writing", CMD.program, 1000], ["Verifying", CMD.verify, 3000]] as const) {
      const key = await this.setKey(chipId, uid);
      for (let at = 0; at < image.length; at += CHUNK) {
        await this.sendData(cmd, at, Array.from(image.subarray(at, at + CHUNK)), key, wait);
        progress(Math.round((Math.min(at + CHUNK, image.length) / image.length) * 100), stage);
      }
      // The bootloader wants an empty write at the end to finish programming.
      if (cmd === CMD.program) await this.sendData(cmd, image.length, [], key, wait);
    }
  }

  /** Leave the bootloader: the chip resets and runs the program. */
  async run(): Promise<void> {
    try {
      await this.exchange([CMD.end, 0x01, 0x00, 0x01], 1500);
    } catch {
      // it resets before (or while) answering
    }
  }
}
