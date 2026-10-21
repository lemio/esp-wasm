// Serial over TinyUSB's CDC port, in the USB-OTG variant of the sysroot (sdkconfig.usb).
//
// As hwcdc_serial.cpp does for USB-Serial/JTAG: the core only defines USBSerial
// when it's compiled with ARDUINO_USB_CDC_ON_BOOT=1, and the browser decides
// that per sketch. A sketch built with it gets `Serial` = USBSerial and links
// this archive member, which also does what the core's app_main does in that
// mode, before setup(): start Serial and the USB stack (USB.begin() again in
// the sketch is a no-op). Interfaces the sketch adds (USBHIDKeyboard…) register
// in their constructors, so they are part of the device from the start.
#include "sdkconfig.h"

#if CONFIG_TINYUSB_CDC_ENABLED && !ARDUINO_USB_MODE && !ARDUINO_USB_CDC_ON_BOOT
#include "USB.h"

USBCDC USBSerial(0);

// called by initArduino(); the core's own is weak and empty
extern "C" void initVariant() {
  USBSerial.begin();
  USB.begin();
}
#endif
