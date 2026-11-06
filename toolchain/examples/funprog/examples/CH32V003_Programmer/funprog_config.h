// funprog configuration for the ESP32-S3 port (see ch32fun's
// minichlink/funprog/funprog_config_example.h for every option).
#ifndef FUNPROG_CONFIG_H
#define FUNPROG_CONFIG_H

// ---- Wiring --------------------------------------------------------------
// SWIO is the CH32V003's single-wire debug pin (PD1). SWCLK is only used by the
// two-wire RVSWD chips (CH32V2xx/V3xx/X0xx), not by the CH32V003.
// Both must be GPIO 0..31 (the bit-banging uses the GPIO.out/enable/in registers).
#define SWIO_PIN                 4
#define SWCLK_PIN                5
// Optional: a GPIO that switches the target's power (HIGH = on), for example
// through a P-MOSFET, so minichlink can power-cycle it. -1 = not used: power
// the target from the ESP32-S3 board's 3V3 pin.
#define TARGET_POWER_PIN         -1
// Optional: an LED that lights while a command runs. -1 = not used.
#define STATUS_LED_PIN           -1

// ---- Capabilities reported to minichlink ---------------------------------
#define DEBUG_PRINT              0
#define CH5xx_SUPPORT            0 // CH5xx (BLE) chips: not in this port
#define CH5xx_EEPROM             0
#define CH5xx_OPTIONS            0
#define CH5xx_UNLOCK             0
#define UPDI_SUPPORT             0 // AVR UPDI: not in this port
#define USB_HID_INTERFACE        1
#define USB_VENDOR_INTERFACE     0
#define WEBSOCKET_INTERFACE      0
#define WEB_INTERFACE            0
#define BLE_INTERFACE            0
#define MCO_SUPPORT              0

#define PROGRAMMER_TYPE_UNKNOWN  0
#define PROGRAMMER_TYPE_ESP32S2  1
#define PROGRAMMER_TYPE_CH32V003 2
#define PROGRAMMER_TYPE_CH570    3
#define PROGRAMMER_TYPE_ESP32    4
#define PROGRAMMER_TYPE_SWADGE   5
#define PROGRAMMER_TYPE          PROGRAMMER_TYPE_ESP32

#define HAS_MCO                  (MCO_SUPPORT << 12)
#define HAS_BLE                  (BLE_INTERFACE << 11)
#define HAS_WEB_UI               (WEB_INTERFACE << 10)
#define HAS_WEBSOCKET            (WEBSOCKET_INTERFACE << 9)
#define HAS_USB_VENDOR           (USB_VENDOR_INTERFACE << 8)
#define HAS_USB_HID              (USB_HID_INTERFACE << 7)
#define HAS_UPDI_SUPPORT         (UPDI_SUPPORT << 5)
#define HAS_CH5xx_UNLOCK         (CH5xx_UNLOCK << 3)
#define HAS_CH5xx_OPTIONS        (CH5xx_OPTIONS << 2)
#define HAS_CH5xx_EEPROM         (CH5xx_EEPROM << 1)
#define HAS_CH5xx_SUPPORT        (CH5xx_SUPPORT << 0)

#define CAPABILITIES HAS_CH5xx_SUPPORT | \
                     HAS_CH5xx_EEPROM  | \
                     HAS_CH5xx_OPTIONS | \
                     HAS_CH5xx_UNLOCK  | \
                     HAS_UPDI_SUPPORT  | \
                     HAS_USB_HID

#define MAX_IN_TIMEOUT           1000

// Without an external 10k pull-up on SWIO, briefly drive the line high after
// each read bit instead of waiting for the internal pull-up (as on the ESP32-S2
// programmer). Comment out if you fit a 10k pull-up to 3V3.
#define R_GLITCH_HIGH

#endif
