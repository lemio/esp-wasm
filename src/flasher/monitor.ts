import { hardReset } from "./reset";

/** ESP-IDF's default console baud rate (CONFIG_ESP_CONSOLE_UART_BAUDRATE). */
export const MONITOR_BAUD = 115200;

/** How long to wait for a native-USB S3 to come back after it resets. */
const RECONNECT_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MonitorEvents {
  /** Decoded text from the device. */
  data(text: string): void;
  /** Status messages about the monitor itself. */
  info(message: string, level?: "muted" | "error"): void;
  /** The device came back as a different SerialPort object (native USB re-enumerated). */
  portChanged?(port: SerialPort): void;
  /** The monitor stopped, by request or because the device went away. */
  stopped?(): void;
}

/**
 * Serial monitor: streams what the chip prints into the output panel.
 *
 * A native-USB S3 (USB-Serial/JTAG) drops off the bus whenever it resets and
 * comes back a moment later, sometimes as a new SerialPort object. The monitor
 * waits for it and carries on.
 */
export class SerialMonitor {
  private port?: SerialPort;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private loop?: Promise<void>;
  private stopping = false;

  constructor(private readonly events: MonitorEvents) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  /**
   * Open the port and start streaming. With reset, the chip is reset once
   * reading has started, so the boot log is captured too.
   */
  async start(port: SerialPort, { reset = false } = {}): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.open(port);
    this.events.info(`Serial monitor at ${MONITOR_BAUD} baud`, "muted");
    const loop = this.run().finally(() => {
      if (this.loop === loop) this.loop = undefined;
      this.events.stopped?.();
    });
    this.loop = loop;
    if (reset) await hardReset(port);
  }

  /** Send text to the chip (e.g. debugger commands). */
  async write(text: string): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) throw new Error("Serial monitor isn't connected");
    const writer = writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text));
    } finally {
      writer.releaseLock();
    }
  }

  /** Reset the chip without interrupting the monitor. */
  async reset(): Promise<void> {
    if (this.port) await hardReset(this.port);
  }

  async stop(): Promise<void> {
    const loop = this.loop;
    if (!loop) return;
    this.stopping = true;
    await this.reader?.cancel().catch(() => {});
    await loop;
  }

  private async open(port: SerialPort): Promise<void> {
    await port.open({ baudRate: MONITOR_BAUD });
    // Opening can assert DTR/RTS. Release both so the auto-reset circuit
    // (or the native USB peripheral) leaves the chip running. RTS first: RTS high
    // with DTR low, even for a moment in between, is what resets the chip.
    await port.setSignals({ requestToSend: false });
    await port.setSignals({ dataTerminalReady: false });
    this.port = port;
  }

  private async run(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      while (!this.stopping && this.port) {
        const port = this.port;
        // port.readable is replaced after recoverable errors (break, framing,
        // overrun), and null once the device is gone.
        while (!this.stopping && port.readable) {
          this.reader = port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await this.reader.read();
              if (done) break;
              if (value?.length) this.events.data(decoder.decode(value, { stream: true }));
            }
          } catch {
            // Read error: either recoverable (readable is replaced) or the device left.
          } finally {
            this.reader.releaseLock();
            this.reader = undefined;
          }
        }
        if (this.stopping) break;

        await port.close().catch(() => {});
        this.port = undefined;
        this.events.info("Serial port went away (the chip reset?), waiting for it to come back…", "muted");
        const again = await this.waitForPort(port);
        if (!again) {
          if (!this.stopping) this.events.info("Serial monitor stopped: the device didn't come back.", "error");
          break;
        }
        await this.open(again);
        if (again !== port) this.events.portChanged?.(again);
        this.events.info("Serial port reconnected.", "muted");
      }
    } finally {
      await this.port?.close().catch(() => {});
      this.port = undefined;
    }
  }

  /** Wait for the same device to show up again: same object, or same USB VID/PID. */
  private async waitForPort(old: SerialPort): Promise<SerialPort | undefined> {
    const { usbVendorId, usbProductId } = old.getInfo();
    const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
    while (!this.stopping && Date.now() < deadline) {
      await sleep(250);
      const ports = await navigator.serial.getPorts();
      const candidates = ports.includes(old)
        ? [old]
        : ports.filter((p) => {
            const info = p.getInfo();
            return info.usbVendorId === usbVendorId && info.usbProductId === usbProductId;
          });
      for (const p of candidates) {
        try {
          // Probe: the port may be listed before the device is ready to open.
          await p.open({ baudRate: MONITOR_BAUD });
          await p.close();
          return p;
        } catch {
          // not ready yet
        }
      }
    }
    return undefined;
  }
}
