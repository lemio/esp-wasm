/**
 * Plain-language notes for the Arduino functions and constants people use most, shown in completions
 * and on hover. Everything else comes from the headers (arduino-api.json) with its signature only.
 * `sig` names the parameters where the header doesn't; `ref` is the page on docs.arduino.cc.
 */
export interface Doc { sig?: string; doc: string; ref?: string }

const R = "https://docs.arduino.cc/language-reference/en/";
export const DOCS: Record<string, Doc> = {
  // structure
  setup: { sig: "void setup()", doc: "Runs once, when the board starts: set pin modes, start Serial.", ref: `${R}structure/sketch/setup/` },
  loop: { sig: "void loop()", doc: "Runs over and over, after setup().", ref: `${R}structure/sketch/loop/` },
  // digital I/O
  pinMode: { sig: "void pinMode(uint8_t pin, uint8_t mode)", doc: "Sets a pin to INPUT, OUTPUT, INPUT_PULLUP or INPUT_PULLDOWN.", ref: `${R}functions/digital-io/pinMode/` },
  digitalWrite: { sig: "void digitalWrite(uint8_t pin, uint8_t value)", doc: "Makes an output pin HIGH (3.3 V) or LOW (0 V).", ref: `${R}functions/digital-io/digitalwrite/` },
  digitalRead: { sig: "int digitalRead(uint8_t pin)", doc: "Reads a pin: HIGH or LOW.", ref: `${R}functions/digital-io/digitalread/` },
  // analog I/O
  analogRead: { sig: "uint16_t analogRead(uint8_t pin)", doc: "Reads a voltage on an analog pin: 0 (0 V) to 4095 (about 3.3 V) on the ESP32-S3.", ref: `${R}functions/analog-io/analogRead/` },
  analogReadMilliVolts: { sig: "uint32_t analogReadMilliVolts(uint8_t pin)", doc: "Reads a pin's voltage in millivolts, calibrated." },
  analogReadResolution: { sig: "void analogReadResolution(uint8_t bits)", doc: "How many bits analogRead() returns (default 12: 0–4095)." },
  analogWrite: { sig: "void analogWrite(uint8_t pin, int value)", doc: "Dims a light or slows a motor: a PWM signal, 0 (off) to 255 (fully on).", ref: `${R}functions/analog-io/analogWrite/` },
  ledcAttach: { sig: "bool ledcAttach(uint8_t pin, uint32_t freq, uint8_t resolution)", doc: "ESP32 PWM: starts a PWM signal on a pin at a frequency (Hz) and resolution (bits)." },
  ledcWrite: { sig: "bool ledcWrite(uint8_t pin, uint32_t duty)", doc: "ESP32 PWM: sets the duty cycle on a pin started with ledcAttach()." },
  rgbLedWrite: { sig: "void rgbLedWrite(uint8_t pin, uint8_t red, uint8_t green, uint8_t blue)", doc: "Sets the colour of an addressable RGB LED (0–255 each)." },
  touchRead: { sig: "touch_value_t touchRead(uint8_t pin)", doc: "Reads a touch pin: the value changes when a finger is near." },
  // time
  delay: { sig: "void delay(uint32_t ms)", doc: "Waits this many milliseconds (1000 = one second). Nothing else runs meanwhile.", ref: `${R}functions/time/delay/` },
  delayMicroseconds: { sig: "void delayMicroseconds(uint32_t us)", doc: "Waits this many microseconds.", ref: `${R}functions/time/delayMicroseconds/` },
  millis: { sig: "unsigned long millis()", doc: "Milliseconds since the board started. Use it to time things without delay().", ref: `${R}functions/time/millis/` },
  micros: { sig: "unsigned long micros()", doc: "Microseconds since the board started.", ref: `${R}functions/time/micros/` },
  // math
  map: { sig: "long map(long value, long fromLow, long fromHigh, long toLow, long toHigh)", doc: "Re-maps a number from one range to another, e.g. 0–4095 to 0–255.", ref: `${R}functions/math/map/` },
  constrain: { sig: "constrain(x, low, high)", doc: "Keeps x between low and high.", ref: `${R}functions/math/constrain/` },
  min: { sig: "min(a, b)", doc: "The smaller of two numbers.", ref: `${R}functions/math/min/` },
  max: { sig: "max(a, b)", doc: "The larger of two numbers.", ref: `${R}functions/math/max/` },
  abs: { sig: "abs(x)", doc: "A number without its sign.", ref: `${R}functions/math/abs/` },
  sq: { sig: "sq(x)", doc: "x times x.", ref: `${R}functions/math/sq/` },
  random: { sig: "long random(long min, long max)", doc: "A random number from min up to (not including) max. random(max) starts at 0.", ref: `${R}functions/random-numbers/random/` },
  randomSeed: { sig: "void randomSeed(unsigned long seed)", doc: "Starts the random numbers from a seed, e.g. randomSeed(analogRead(A0)).", ref: `${R}functions/random-numbers/randomSeed/` },
  // advanced I/O
  tone: { sig: "void tone(uint8_t pin, unsigned int frequency, unsigned long duration = 0)", doc: "Plays a square wave (a beep) on a pin, at a frequency in Hz.", ref: `${R}functions/advanced-io/tone/` },
  noTone: { sig: "void noTone(uint8_t pin)", doc: "Stops tone() on a pin.", ref: `${R}functions/advanced-io/noTone/` },
  pulseIn: { sig: "unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000)", doc: "Measures how long a pulse (HIGH or LOW) lasts, in microseconds.", ref: `${R}functions/advanced-io/pulseIn/` },
  shiftOut: { sig: "void shiftOut(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder, uint8_t value)", doc: "Sends a byte out one bit at a time (for shift registers).", ref: `${R}functions/advanced-io/shiftOut/` },
  shiftIn: { sig: "uint8_t shiftIn(uint8_t dataPin, uint8_t clockPin, uint8_t bitOrder)", doc: "Reads a byte in one bit at a time.", ref: `${R}functions/advanced-io/shiftIn/` },
  // interrupts
  attachInterrupt: { sig: "void attachInterrupt(uint8_t pin, void (*function)(), int mode)", doc: "Calls a function the moment a pin changes (RISING, FALLING or CHANGE).", ref: `${R}functions/external-interrupts/attachInterrupt/` },
  detachInterrupt: { sig: "void detachInterrupt(uint8_t pin)", doc: "Stops the interrupt on a pin.", ref: `${R}functions/external-interrupts/detachInterrupt/` },
  digitalPinToInterrupt: { sig: "digitalPinToInterrupt(pin)", doc: "The interrupt number of a pin, for attachInterrupt()." },
  // bits
  bitRead: { sig: "bitRead(value, bit)", doc: "Reads one bit of a number (0 is the rightmost).", ref: `${R}functions/bits-and-bytes/bitRead/` },
  bitWrite: { sig: "bitWrite(value, bit, bitvalue)", doc: "Sets one bit of a number to 0 or 1.", ref: `${R}functions/bits-and-bytes/bitWrite/` },
  bitSet: { sig: "bitSet(value, bit)", doc: "Sets one bit to 1.", ref: `${R}functions/bits-and-bytes/bitSet/` },
  bitClear: { sig: "bitClear(value, bit)", doc: "Sets one bit to 0.", ref: `${R}functions/bits-and-bytes/bitClear/` },
  // constants
  HIGH: { doc: "On: about 3.3 V.", ref: `${R}variables/constants/highlow/` },
  LOW: { doc: "Off: 0 V.", ref: `${R}variables/constants/highlow/` },
  INPUT: { doc: "pinMode: the pin listens.", ref: `${R}variables/constants/inputoutputpullup/` },
  OUTPUT: { doc: "pinMode: the pin drives HIGH or LOW.", ref: `${R}variables/constants/inputoutputpullup/` },
  INPUT_PULLUP: { doc: "pinMode: listens, with a resistor inside the chip pulling the pin up to HIGH. A button to ground then reads LOW when pressed.", ref: `${R}variables/constants/inputoutputpullup/` },
  INPUT_PULLDOWN: { doc: "pinMode: listens, with a resistor inside the chip pulling the pin down to LOW." },
  LED_BUILTIN: { doc: "The board's built-in light (on Schematik: the blue LED on GPIO40).", ref: `${R}variables/constants/ledbuiltin/` },
  RISING: { doc: "attachInterrupt: when the pin goes from LOW to HIGH." },
  FALLING: { doc: "attachInterrupt: when the pin goes from HIGH to LOW." },
  CHANGE: { doc: "attachInterrupt: whenever the pin changes." },
  true: { doc: "Yes; 1." }, false: { doc: "No; 0." },
  // Serial
  Serial: { doc: "The serial port over USB: print messages to the computer, read what it sends.", ref: `${R}functions/communication/serial/` },
  "Serial.begin": { sig: "void begin(unsigned long baud)", doc: "Starts Serial at a speed (baud), usually 115200.", ref: `${R}functions/communication/serial/begin/` },
  "Serial.print": { sig: "size_t print(value)", doc: "Sends text or a number, without a new line.", ref: `${R}functions/communication/serial/print/` },
  "Serial.println": { sig: "size_t println(value)", doc: "Sends text or a number, then a new line.", ref: `${R}functions/communication/serial/println/` },
  "Serial.printf": { sig: "size_t printf(const char *format, ...)", doc: "Sends formatted text, e.g. Serial.printf(\"%d ms\\n\", millis())." },
  "Serial.available": { sig: "int available()", doc: "How many bytes have arrived and wait to be read.", ref: `${R}functions/communication/serial/available/` },
  "Serial.read": { sig: "int read()", doc: "Reads one byte that arrived (-1 if none).", ref: `${R}functions/communication/serial/read/` },
  "Serial.readStringUntil": { sig: "String readStringUntil(char terminator)", doc: "Reads text until a character, e.g. '\\n'." },
  "Serial.write": { sig: "size_t write(uint8_t byte)", doc: "Sends raw bytes." },
};
