/*
  CH32V003 Programmer

  Turns the ESP32-S3 into a funprog programmer for WCH's CH32V003 (and other
  CH32V/CH32X RISC-V chips), the programmer core from ch32fun
  (https://github.com/cnlohr/ch32fun). Flash and debug the target with ch32fun's
  minichlink, the same as with cnlohr's ESP32-S2 programmer:

    minichlink -w blink.bin flash -b     write, then reboot the target
    minichlink -T                        printf terminal (ch32fun's debug printf)

  The ESP32-S3 shows up as a USB HID device (VID 0x303a, PID 0x4004) that
  minichlink finds on its own; no driver is needed. It uses the ESP32-S3's
  native USB port (USB-OTG), so connect that port, not the USB-UART one.

  Wiring (change the pins in funprog_config.h):
    ESP32-S3 GPIO 4  ->  CH32V003 PD1 (SWIO)
    ESP32-S3 3V3     ->  CH32V003 VDD
    ESP32-S3 GND     ->  CH32V003 VSS
  A 10k pull-up from SWIO to 3V3 is optional (see R_GLITCH_HIGH).
  GPIO 5 is SWCLK, only for the two-wire chips (CH32V2xx/V3xx/X0xx).

  The sketch's USB device replaces the board's own USB serial port, so it adds a
  USB serial port of its own next to the programmer: the board stays in the
  port list, and flashing it again resets it into the bootloader over that port.
  If that doesn't work: hold BOOT while pressing RESET.
*/
#include "USB.h"
#include "USBHID.h"
#include "USBCDC.h"
#include "funprog.h"

USBHID HID;
// A USB serial port next to the programmer (also what Serial is when the build
// sets ARDUINO_USB_CDC_ON_BOOT). Defining it here, with initVariant() below,
// keeps the build's own USB start-up out: that one starts USB before setup(),
// with the default IDs, before this sketch could set its own.
USBCDC USBSerial(0);

// minichlink picks the smallest feature report that fits its commands.
// The ID is followed by the length: 0xaa 7 bytes, 0xab 63, 0xac 127, 0xad 78, 0xae 263.
#define FEATURE_REPORT(id, count)                                                     \
  0x85, id,                                         /* Report ID */                   \
  0x96, (uint8_t)((count) & 0xff), (uint8_t)((count) >> 8), /* Report Count (16-bit) */ \
  0x09, 0x01,                                       /* Usage (vendor 1) */           \
  0xb1, 0x02                                        /* Feature (Data, Var, Abs) */

static const uint8_t report_descriptor[] = {
  0x06, 0x00, 0xff,  // Usage Page (Vendor 0xff00)
  0x09, 0x01,        // Usage (vendor 1)
  0xa1, 0x01,        // Collection (Application)
  0x15, 0x00,        //   Logical Minimum (0)
  0x26, 0xff, 0x00,  //   Logical Maximum (255)
  0x75, 0x08,        //   Report Size (8)
  FEATURE_REPORT(0xaa, 7),
  FEATURE_REPORT(0xab, 63),
  FEATURE_REPORT(0xac, 127),
  FEATURE_REPORT(0xad, 78),
  FEATURE_REPORT(0xae, 263),
  0xc0,              // End Collection
};

class FunprogHID : public USBHIDDevice {
public:
  FunprogHID() {
    static bool added = false;
    if (!added) {
      added = true;
      HID.addDevice(this, sizeof(report_descriptor));
    }
  }

  uint16_t _onGetDescriptor(uint8_t *dst) override {
    memcpy(dst, report_descriptor, sizeof(report_descriptor));
    return sizeof(report_descriptor);
  }

  // Commands from minichlink: buffer holds the report without its ID.
  void _onSetFeature(uint8_t report_id, const uint8_t *buffer, uint16_t len) override {
    static uint8_t report[FUNPROG_REPORT_SIZE];
    if (len > sizeof(report) - 1) len = sizeof(report) - 1;
    report[0] = report_id;
    memcpy(report + 1, buffer, len);
    funprog_command(report, len + 1);
  }

  // Replies to minichlink. Its protocol puts the reply length where the report ID
  // goes, so this writes from buffer[-1]: the byte TinyUSB reserved for the ID.
  uint16_t _onGetFeature(uint8_t report_id, uint8_t *buffer, uint16_t len) override {
    return funprog_reply(buffer - 1, len + 1) - 1;
  }
};

FunprogHID programmer;

// Called by the core before setup(): start USB with the programmer's IDs.
void initVariant() {
  funprog_begin();

  // The IDs minichlink looks for (cnlohr's ESP32-S2 programmer).
  USB.VID(0x303a);
  USB.PID(0x4004);
  USB.serialNumber("s2-ch32xx-pgm-v0");
  USB.manufacturerName("ch32fun");
  USB.productName("ESP32-S3 funprog");
  HID.begin();
  USBSerial.begin();
  USB.begin();
}

void setup() {
  USBSerial.println("ESP32-S3 funprog: CH32V003 programmer for minichlink");
}

void loop() {
  // Everything happens in the USB callbacks.
  delay(1000);
}
