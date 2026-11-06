/**
 * Flash a CH32V003 over its UART (e.g. a board's CH340 USB-serial chip) with WCH's
 * USART IAP bootloader. The CH32V003 has no factory UART/USB bootloader: this one
 * has to be installed once with a WCH-LinkE (WCH's EVT/EXAM/USART_IAP example).
 *
 * Two versions of its protocol are in use; both run at 460800 baud on PD5/PD6:
 *  - WCH's current one: AA 55 cmd len [addr×4 for erase/verify] data… sumLo sumHi 55 AA,
 *    answered with AA 55 00 status 55 AA. Programming writes sequentially from
 *    0x08000000 (64-byte blocks); the first verify flushes the last partial block;
 *    "end" marks the app valid (0x5AA55AA5 at 0x08003FFC) and starts it.
 *  - an older one (e.g. github.com/74th/ch32v003-uart-programmer): 57 AB cmd len
 *    addrLo addrHi data… sum8, answered with 2 bytes, the first 0 on success.
 */

export const IAP_BAUD = 460800;
const CMD_PROGRAM = 0x80;
const CMD_ERASE = 0x81;
const CMD_VERIFY = 0x82;
const CMD_END = 0x83;
/** Does nothing in WCH's bootloader except answer: a safe way to find it. */
const CMD_PING = 0x84;
const CHUNK = 60;
/** "end" erases the last 64-byte page for its app-valid word, so the app must stop before it. */
export const IAP_MAX_APP = 0x4000 - 64;

type Protocol = "wch" | "legacy";

export class Ch32Iap {
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private rx: number[] = [];
  private reading?: Promise<void>;
  private protocol?: Protocol;

  constructor(private readonly port: SerialPort, private readonly log: (text: string) => void) {}

  async open(): Promise<void> {
    await this.port.open({ baudRate: IAP_BAUD });
    // Don't hold the chip in reset on boards that wire DTR/RTS to NRST.
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    this.reader = this.port.readable!.getReader();
    this.reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          this.rx.push(...value);
        }
      } catch { /* port closed */ }
    })();
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => {});
    await this.reading;
    this.reader?.releaseLock();
    await this.port.close().catch(() => {});
  }

  private async send(bytes: number[]): Promise<void> {
    const w = this.port.writable!.getWriter();
    try { await w.write(new Uint8Array(bytes)); } finally { w.releaseLock(); }
  }

  /** Wait for `n` received bytes (after the ones already consumed). */
  private async receive(n: number, timeoutMs: number): Promise<number[] | undefined> {
    const end = performance.now() + timeoutMs;
    while (this.rx.length < n) {
      if (performance.now() > end) return undefined;
      await new Promise((r) => setTimeout(r, 2));
    }
    return this.rx.splice(0, n);
  }

  private frame(protocol: Protocol, cmd: number, data: number[] = [], addr = 0): number[] {
    if (protocol === "wch") {
      const addrBytes = cmd === CMD_ERASE || cmd === CMD_VERIFY ? [addr & 0xff, (addr >> 8) & 0xff, 0, 0] : [];
      const body = [cmd, data.length, ...addrBytes, ...data];
      const sum = body.reduce((a, b) => a + b, 0);
      return [0xaa, 0x55, ...body, sum & 0xff, (sum >> 8) & 0xff, 0x55, 0xaa];
    }
    const body = [cmd, cmd === CMD_PROGRAM || cmd === CMD_VERIFY ? data.length : 2, addr & 0xff, (addr >> 8) & 0xff, ...data];
    return [0x57, 0xab, ...body, body.reduce((a, b) => a + b, 0) & 0xff];
  }

  /** Send a command and check the answer; returns false on a timeout. */
  private async command(cmd: number, data: number[] = [], addr = 0, timeoutMs = 1000): Promise<boolean> {
    const p = this.protocol!;
    this.rx.length = 0;
    await this.send(this.frame(p, cmd, data, addr));
    if (cmd === CMD_END) return true; // no answer: it starts the app
    const r = await this.receive(p === "wch" ? 6 : 2, timeoutMs);
    if (!r) return false;
    const status = p === "wch" ? r[3] : r[0];
    if (status !== 0) throw new Error(`The bootloader reported an error (status ${status}) for command 0x${cmd.toString(16)}`);
    return true;
  }

  /**
   * Find the bootloader, trying both protocols, for up to `timeoutMs` (time for the
   * user to reset the board into it).
   */
  async detect(timeoutMs: number): Promise<Protocol | undefined> {
    const end = performance.now() + timeoutMs;
    while (performance.now() < end) {
      for (const p of ["wch", "legacy"] as const) {
        this.rx.length = 0;
        await this.send(this.frame(p, CMD_PING));
        const r = await this.receive(p === "wch" ? 6 : 2, 120);
        // Only a well-formed answer counts: a running app's printout can arrive here too.
        const answer = p === "wch" ? r?.[0] === 0xaa && r[1] === 0x55 && r[2] === 0 : !!r && r[0] <= 2 && r[1] === 0;
        if (answer) return (this.protocol = p);
      }
    }
    return undefined;
  }

  /** Erase, write and verify `image` (from flash address 0), then start it. */
  async flash(image: Uint8Array, onProgress?: (percent: number, stage: string) => void): Promise<void> {
    if (!this.protocol) throw new Error("Bootloader not detected");
    if (image.length > IAP_MAX_APP) {
      throw new Error(`The program is ${image.length} bytes; with the IAP bootloader at most ${IAP_MAX_APP} fit.`);
    }
    onProgress?.(0, "Erasing");
    if (!(await this.command(CMD_ERASE, [], 0, 3000))) throw new Error("No answer to erase");
    const chunks: [number, number[]][] = [];
    for (let off = 0; off < image.length; off += CHUNK) chunks.push([off, Array.from(image.subarray(off, off + CHUNK))]);
    for (const [stage, cmd] of [["Writing", CMD_PROGRAM], ["Verifying", CMD_VERIFY]] as const) {
      for (const [i, [off, data]] of chunks.entries()) {
        if (!(await this.command(cmd, data, off))) throw new Error(`No answer while ${stage.toLowerCase()} at 0x${off.toString(16)}`);
        onProgress?.(Math.round(((i + 1) / chunks.length) * 100), stage);
      }
    }
    await this.command(CMD_END);
    this.log(`Flashed ${image.length} bytes (${this.protocol === "wch" ? "WCH USART IAP" : "IAP, older protocol"}); the app is starting.`);
  }
}
