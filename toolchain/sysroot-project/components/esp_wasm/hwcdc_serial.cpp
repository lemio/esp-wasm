// Serial over the S3's native USB-Serial/JTAG port.
//
// The core only defines HWCDCSerial when it's compiled with
// ARDUINO_USB_CDC_ON_BOOT=1, which would fix the choice for every sketch. The
// browser instead compiles each sketch with ARDUINO_USB_CDC_ON_BOOT=1 when it
// flashes over native USB, which makes `Serial` mean HWCDCSerial in the
// sketch, and 0 otherwise (Serial = UART0). This archive member is only
// linked when a sketch actually uses it.
#include "HWCDC.h"

#if SOC_USB_SERIAL_JTAG_SUPPORTED && !ARDUINO_USB_CDC_ON_BOOT
HWCDC HWCDCSerial;
#endif
