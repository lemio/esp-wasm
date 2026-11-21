/**
 * The notes for WCH's Arduino core (arduino_core_ch32), shown in completions and on hover in CH32 (Arduino)
 * projects. The generic Arduino notes (arduino-docs.ts) carry over where they hold for the CH32 core;
 * the ESP32-only ones (ledc, touch, NeoPixel LED, 3.3 V, 4095…) are left out, and the CH32 differences
 * replace them. The USBPD notes follow the library's header (libraries/USBPD_SINK/src/USBPD.h).
 */
import { DOCS, type Doc } from "./arduino-docs";

const R = "https://docs.arduino.cc/language-reference/en/";
const ESP32_ONLY = ["analogReadMilliVolts", "ledcAttach", "ledcWrite", "rgbLedWrite", "touchRead"];

export function ch32Docs(chip: "ch32v003" | "ch32x035"): Record<string, Doc> {
  const v003 = chip === "ch32v003";
  const adcBits = v003 ? 10 : 12, adcMax = (1 << adcBits) - 1;
  const docs: Record<string, Doc> = Object.fromEntries(Object.entries(DOCS).filter(([k]) => !ESP32_ONLY.includes(k)));
  Object.assign(docs, {
    digitalWrite: { ...DOCS.digitalWrite, sig: "void digitalWrite(uint32_t pin, uint32_t value)", doc: "Makes an output pin HIGH (the chip's supply voltage) or LOW (0 V)." },
    pinMode: { ...DOCS.pinMode, sig: "void pinMode(uint32_t pin, uint32_t mode)", doc: "Sets a pin to INPUT, OUTPUT, INPUT_PULLUP, INPUT_PULLDOWN, INPUT_FLOATING, INPUT_ANALOG or OUTPUT_OD (open drain)." },
    digitalRead: { ...DOCS.digitalRead, sig: "int digitalRead(uint32_t pin)" },
    digitalToggle: { sig: "void digitalToggle(uint32_t pin)", doc: "Flips an output pin: HIGH becomes LOW and the other way round." },
    analogRead: { sig: "uint32_t analogRead(uint32_t pin)",
      doc: `Reads a voltage on an analog pin (A0, A1…, or the pin's name): 0 (0 V) to ${adcMax} (the supply voltage), because the ADC has ${adcBits} bits here. analogReadResolution() changes the range.`, ref: `${R}functions/analog-io/analogRead/` },
    analogReadResolution: { sig: "void analogReadResolution(int bits)", doc: `How many bits analogRead() returns (default ${adcBits}: 0–${adcMax}).` },
    analogWrite: { sig: "void analogWrite(uint32_t pin, uint32_t value)",
      doc: "Dims a light or slows a motor: a PWM signal on a pin with a timer output, 0 (off) to 4095 (fully on) by default, at 1 kHz. analogWriteResolution() and analogWriteFrequency() change that.", ref: `${R}functions/analog-io/analogWrite/` },
    analogWriteResolution: { sig: "void analogWriteResolution(int bits)", doc: "How many bits analogWrite() takes (default 12: 0–4095; use 8 for the usual 0–255)." },
    analogWriteFrequency: { sig: "void analogWriteFrequency(uint32_t freq)", doc: "The PWM frequency of analogWrite(), in Hz (default 1000)." },
    HIGH: { doc: "On: the chip's supply voltage (3.3 V or 5 V, whatever powers the board).", ref: `${R}variables/constants/highlow/` },
    LED_BUILTIN: { doc: "Not set on the CH32 boards: use the pin your LED is on, e.g. #define LED_PIN PD0 (PA0 on the CH32X035).", ref: `${R}variables/constants/ledbuiltin/` },
    Serial: { doc: v003
      ? "Text for the Output panel. Flashed over SWIO (a funprog programmer) it travels through the debug connection: no adapter, no wires, and the baud rate is ignored. Flashed over the USB-serial bootloader it is USART1 instead (TX on PD5, RX on PD6)."
      : "Text for the Output panel, sent over the SWIO debug connection: no adapter and no extra wires, and the baud rate is ignored. Serial1 is the chip's real UART (USART1: TX on PB10, RX on PB11). Reading from Serial isn't supported over SWIO.", ref: `${R}functions/communication/serial/` },
    Serial1: { doc: v003 ? "The chip's USART1: TX on PD5, RX on PD6." : "The chip's USART1: TX on PB10, RX on PB11. Start it with Serial1.begin(baud), and use a USB-serial adapter to read it.", ref: `${R}functions/communication/serial/` },
  });
  if (!v003) Object.assign(docs, {
    USBPD: { doc: "USB Power Delivery: ask a USB-C charger or power bank for a voltage and a current. Call USBPD.requestVoltage() in setup(), then check USBPD.isReady() in loop()." },
    "USBPD.begin": { sig: "void begin()", doc: "Starts USB Power Delivery. The request functions call it for you." },
    "USBPD.end": { sig: "void end()", doc: "Stops USB Power Delivery and forgets the contract and the source's options. VBUS isn't guaranteed to return to 5 V; reconnecting the source may be needed before starting again." },
    "USBPD.requestVoltage": { sig: "bool requestVoltage(uint16_t voltage, float current)", doc: "Asks the source for a whole-number voltage (volts) and at least this current (amperes). It returns false only when the values are invalid; getStatus() tells whether the source can provide it." },
    "USBPD.requestCapability": { sig: "bool requestCapability(uint8_t index, float current)", doc: "Asks for one of the source's listed options (index from 0) and at least this current (amperes)." },
    "USBPD.isReady": { sig: "bool isReady()", doc: "True once the source has switched to the requested power." },
    "USBPD.getStatus": { sig: "USBPDStatus getStatus()", doc: "Whether the request is pending (USBPD_NEGOTIATING), done (USBPD_READY), or can't be met (USBPD_NO_SOURCE, USBPD_VOLTAGE_UNAVAILABLE, USBPD_CURRENT_UNAVAILABLE, USBPD_REJECTED, USBPD_DISCONNECTED, USBPD_ERROR)." },
    "USBPD.getVoltage": { sig: "float getVoltage()", doc: "The agreed voltage in volts, or 0 when not ready. It's the contract, not a measurement of VBUS." },
    "USBPD.getCurrent": { sig: "float getCurrent()", doc: "The agreed current in amperes, or 0 when not ready." },
    "USBPD.hasCapabilities": { sig: "bool hasCapabilities()", doc: "True once the source's power options have arrived." },
    "USBPD.getCapabilityCount": { sig: "uint8_t getCapabilityCount()", doc: "How many options the source offers." },
    "USBPDCapability.minVoltage": { doc: "The lowest voltage of this option, in volts. A fixed option has the same minVoltage and maxVoltage." },
    "USBPDCapability.maxVoltage": { doc: "The highest voltage of this option, in volts. A programmable option can provide any voltage between minVoltage and maxVoltage." },
    "USBPDCapability.current": { doc: "The current this option can provide, in amperes." },
    "USBPDCapability.programmable": { doc: "True when the option can provide any voltage between minVoltage and maxVoltage; false when it is one fixed voltage." },
    "USBPD.getCapability": { sig: "bool getCapability(uint8_t index, USBPDCapability &capability)", doc: "Reads one option (index from 0): its minVoltage, maxVoltage, current and whether it's programmable (any voltage in between)." },
  });
  return docs;
}
