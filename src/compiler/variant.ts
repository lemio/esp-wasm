/**
 * Which sysroot variant a sketch needs. A sketch that uses the S3's USB port itself — a USB keyboard,
 * mouse, MIDI or mass-storage device (USB.h, USBHIDKeyboard.h…) — needs USB-OTG mode with TinyUSB.
 */
const USB_HEADER = /^\s*#\s*include\s*[<"](?:USB|USBHID\w*|USBMIDI|USBCDC|USBMSC|USBVendor|USBAudioCard|tusb)\.h[>"]/m;
export function variantFor(sources: { path: string; content: string }[]): string | undefined {
  return sources.some((f) => USB_HEADER.test(f.content)) ? "usb" : undefined;
}
