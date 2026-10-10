/**
 * DTR/RTS sequences that reset an ESP32-S3 or put it into ROM download ("boot")
 * mode without touching the BOOT/RESET buttons. Ported from esptool.py's
 * reset.py.
 *
 * Two wirings are handled:
 *  - USB-UART bridge (CP210x/CH34x) with the usual two-transistor auto-reset
 *    circuit: DTR drives IO0 (BOOT), RTS drives EN (RESET), both inverted.
 *  - The S3's native USB-Serial/JTAG (VID 0x303A, PID 0x1001): the peripheral
 *    maps the same DTR/RTS lines onto the chip's boot strap and reset internally.
 *
 * Boards without an auto-reset circuit, or firmware that has taken over the
 * native USB pins (e.g. TinyUSB CDC), can't be controlled this way and still
 * need the buttons: hold BOOT, tap RESET, release BOOT.
 */

const ESPRESSIF_VID = 0x303a;
const USB_JTAG_SERIAL_PID = 0x1001;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set both lines in one call so the auto-reset circuit never sees a half-updated state. */
const set = (port: SerialPort, dtr: boolean, rts: boolean) =>
  port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });

export function isUsbJtagSerial(port: SerialPort): boolean {
  const { usbVendorId, usbProductId } = port.getInfo();
  return usbVendorId === ESPRESSIF_VID && usbProductId === USB_JTAG_SERIAL_PID;
}

/** Reset into ROM download mode (IO0 low while EN rises). Port must be open. */
export async function enterBootloader(port: SerialPort): Promise<void> {
  if (isUsbJtagSerial(port)) {
    // esptool USBJTAGSerialReset
    await set(port, false, false); // idle
    await sleep(100);
    await set(port, true, false); // set IO0
    await sleep(100);
    // Reset. Go through (1,1) rather than (0,0): the peripheral latches the
    // strap on the transition.
    await set(port, true, true);
    await set(port, false, true);
    await sleep(100);
    await set(port, false, false); // out of reset, into the bootloader
  } else {
    // esptool UnixTightReset: change both lines together.
    await set(port, false, false);
    await set(port, true, true);
    await set(port, false, true); // IO0 high, EN low: hold in reset
    await sleep(100);
    await set(port, true, false); // IO0 low, EN high: boot into download mode
    await sleep(50);
    await set(port, false, false); // release IO0
  }
}

/** Reset and run the flashed app (IO0 stays high). Port must be open. */
export async function hardReset(port: SerialPort): Promise<void> {
  // esptool HardReset: EN low, wait, EN high. esptool-js 0.7 skips the first
  // step, so the chip never resets after flashing; this is why we do it ourselves.
  await set(port, false, true);
  if (isUsbJtagSerial(port)) {
    await sleep(200);
    await set(port, false, false);
    await sleep(200);
  } else {
    await sleep(100);
    await set(port, false, false);
  }
}
