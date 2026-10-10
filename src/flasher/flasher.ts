import { ESPLoader, Transport, type IEspLoaderTerminal } from "esptool-js";
import { enterBootloader, hardReset, isUsbJtagSerial } from "./reset";

export interface FlashImage {
  address: number;
  data: Uint8Array;
  name: string;
}

export const isWebSerialSupported = (): boolean => "serial" in navigator;

/** Thin wrapper around esptool-js: connect, flash, reset. */
export class Flasher {
  private transport?: Transport;
  private loader?: ESPLoader;
  /** Last port the user picked, reused so the buttons don't prompt every time. */
  private port?: SerialPort;
  chip?: string;

  constructor(private readonly terminal: IEspLoaderTerminal) {}

  get connected(): boolean {
    return this.loader !== undefined;
  }

  async connect(baudrate = 921600): Promise<string> {
    if (!isWebSerialSupported()) {
      throw new Error("Web Serial is not available. Use Chrome or Edge on HTTPS or localhost.");
    }
    const port = await this.pickPort();
    this.transport = new Transport(port, true);
    this.loader = new ESPLoader({
      transport: this.transport,
      baudrate,
      romBaudrate: 115200,
      terminal: this.terminal,
    });
    this.chip = await this.loader.main();
    if (!/ESP32-S3/i.test(this.chip)) {
      this.terminal.writeLine(`Warning: expected ESP32-S3, found ${this.chip}`);
    }
    return this.chip;
  }

  /**
   * Write the images. With reset (default) the chip then restarts into the app;
   * pass reset: false to leave that to the serial monitor, so it catches the boot log.
   */
  async flash(
    images: FlashImage[],
    onProgress?: (percent: number, name: string) => void,
    { reset = true } = {},
  ): Promise<void> {
    if (!this.loader) throw new Error("Not connected");
    await this.loader.writeFlash({
      fileArray: images.map(({ address, data }) => ({ address, data })),
      // "keep" preserves the header bytes the image was built with (see esp-image.ts).
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (fileIndex, written, total) =>
        onProgress?.(Math.round((written / total) * 100), images[fileIndex].name),
    });
    // Not loader.after("hard_reset"): esptool-js 0.7 never pulls EN low there.
    if (reset) await hardReset(this.transport!.device);
  }

  /** The port in use or last picked. */
  get currentPort(): SerialPort | undefined {
    return this.transport?.device ?? this.port;
  }

  /** Remember a port that replaced the old one (a native-USB S3 re-enumerated). */
  usePort(port: SerialPort): void {
    this.port = port;
  }

  /** Put the chip into ROM download mode, as if BOOT were held while tapping RESET. */
  async enterBootMode(): Promise<void> {
    await this.withSignals(enterBootloader);
  }

  /** Reset the chip and run the flashed app, as if RESET were tapped. */
  async reset(): Promise<void> {
    await this.withSignals(hardReset);
  }

  /** Whether the chosen port is the S3's native USB-Serial/JTAG (vs. a USB-UART bridge). */
  get usesNativeUsb(): boolean | undefined {
    return this.port && isUsbJtagSerial(this.port);
  }

  /**
   * Pick the serial port, or reuse the remembered one. Call this straight from a
   * click handler: Chrome only shows the port picker during a user gesture.
   */
  async pickPort(): Promise<SerialPort> {
    if (!isWebSerialSupported()) {
      throw new Error("Web Serial is not available. Use Chrome or Edge on HTTPS or localhost.");
    }
    // Reuse the previous port if it's still plugged in. A native-USB S3
    // re-enumerates on reset, which can give it a new SerialPort object.
    if (this.port && (await navigator.serial.getPorts()).includes(this.port)) return this.port;
    // No VID filter: this has to work with the native USB-Serial/JTAG (0x303A)
    // as well as CP210x/CH34x bridges on DevKits.
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  /** Run a DTR/RTS sequence, opening the port briefly if no flashing session holds it. */
  private async withSignals(sequence: (port: SerialPort) => Promise<void>): Promise<void> {
    if (this.transport) {
      await sequence(this.transport.device);
      return;
    }
    const port = await this.pickPort();
    await port.open({ baudRate: 115200 });
    try {
      await sequence(port);
    } finally {
      // A native-USB S3 drops off the bus when it resets, so closing can fail.
      await port.close().catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    await this.transport?.disconnect();
    this.transport = undefined;
    this.loader = undefined;
    this.chip = undefined;
  }
}
