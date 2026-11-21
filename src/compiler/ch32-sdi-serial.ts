/**
 * `Serial` for Arduino sketches flashed over SWIO (a funprog programmer): the text goes through the
 * debug module's DATA0/DATA1 registers, the channel ch32fun calls its debug printf (SDI printf). The page
 * polls it through the programmer while the program runs (src/debug/ch32-target.ts) and prints it in the
 * output panel, so no serial adapter and no extra wires are needed.
 *
 * The protocol is ch32fun's (ch32fun.c, _write): DMDATA0 = status byte + 3 bytes, DMDATA1 = 4 more bytes.
 * Status: bit 7 = a packet is waiting for the host, bits 0-3 = its length + 4, bits 6+7 = "gave up: nobody
 * is reading". Included into the sketch's own files only (not the precompiled core and libraries), after
 * Arduino.h; `Serial1` stays the chip's real USART. Input isn't carried: read() has nothing to return.
 */
export const SDI_SERIAL_HEADER = `// esp-wasm: Serial over SWIO (ch32fun's debug printf channel); Serial1 is the chip's UART.
#pragma once
#include <Arduino.h>

#ifndef ESP_WASM_SDI_TIMEOUT
#define ESP_WASM_SDI_TIMEOUT 0x100000  // loop counts to wait for the host before giving up (about 200 ms)
#endif

class SdiSerialClass : public Stream {
 public:
  void begin(unsigned long = 0, uint8_t = 0) { setup(); }
  void end() {}
  operator bool() { return true; }

  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
  void flush() override {}

  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t *buf, size_t size) override {
    volatile uint32_t *dm0 = (volatile uint32_t *)0xe0000380, *dm1 = (volatile uint32_t *)0xe0000384;
    setup();
    if ((*dm0 & 0xc0) == 0xc0) return 0;  // gave up before: nobody is reading
    size_t place = 0;
    uint32_t timeout = ESP_WASM_SDI_TIMEOUT;
    while (place < size) {
      size_t n = size - place;
      if (n > 7) n = 7;
      while (*dm0 & 0x80) {  // the last packet hasn't been taken yet
        if (timeout-- == 0) {
          *dm0 |= 0xc0;
          return place;
        }
      }
      timeout = ESP_WASM_SDI_TIMEOUT;
      uint32_t lo = 0x80 | (uint32_t)(n + 4), hi = 0;
      for (size_t i = 0; i < n; i++) {
        if (i < 3) lo |= (uint32_t)buf[place + i] << (8 * (i + 1));
        else hi |= (uint32_t)buf[place + i] << (8 * (i - 3));
      }
      *dm1 = hi;
      *dm0 = lo;  // last: it sets the "waiting" bit
      place += n;
    }
    return size;
  }
  using Print::write;

 private:
  static void setup() {
    static bool done = false;
    if (done) return;
    done = true;
    *(volatile uint32_t *)0xe0000384 = 0;
    *(volatile uint32_t *)0xe0000380 = 0x80;
  }
};

static SdiSerialClass SdiSerial;
#undef Serial
#define Serial SdiSerial
`;
