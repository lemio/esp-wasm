# esp-wasm

An ESP32-S3 IDE that runs entirely in the browser. You write C in Monaco, it compiles
to Xtensa with clang running as WebAssembly, and it flashes over USB with Web Serial.
There's no backend: the whole thing is static files.

See **[docs/PLAN.md](docs/PLAN.md)** for the architecture, risks and roadmap.

## Status

| Part | State |
|---|---|
| Editor (Monaco), UI, log console | ✅ working |
| Compile + link in the browser (clang and GNU ld as WebAssembly) | ✅ working: blink builds in ~1 s, rebuilds in ~0.2 s |
| ELF → ESP image (elf2image port) | ✅ byte-identical to esptool |
| Compile errors as editor squiggles | ✅ working |
| Flashing via esptool-js / Web Serial | 🟡 written, not yet tried on a board |

## Toolchain

The browser loads the compiler, linker and precompiled ESP-IDF from `public/toolchain/`
(gitignored). Build it once with:

```sh
toolchain/setup-idf.sh && toolchain/build-all.sh   # ~1 h, see toolchain/README.md
```

## Develop

```sh
npm install
npm run dev        # http://localhost:5173 (Chrome/Edge, needed for Web Serial)
npm run typecheck
npm run build      # static site in dist/
```

Pick **Arduino** (a sketch with `setup()`/`loop()`) or **ESP-IDF (C)** (a program with
`app_main()`) in the toolbar. Each keeps its own code.

**Flash** does everything in one click. It compiles the code against ESP-IDF v6.0.3
(and the Arduino core for sketches), puts the chip into download mode, writes the bootloader, partition table
and app, then resets the chip and shows what it prints (serial monitor, 115200 baud) in
the output panel. ESP-IDF log colours are kept. The first time, Chrome asks you to pick
the serial port. After that the port is remembered.

The app's console goes to UART0 *and* the native USB port, so the monitor works whichever
of the DevKit's two USB ports you use. Over native USB the chip briefly drops off the bus
when it resets; the monitor waits for it and reconnects.

Entering download mode and resetting go through the serial DTR/RTS lines
(`src/flasher/reset.ts`, ported from esptool). That needs a board with an auto-reset
circuit, or a connection through the S3's native USB port. Otherwise use the buttons:
hold BOOT, tap RESET, release BOOT, then press **Flash**.

### Arduino

The Arduino core is arduino-esp32 3.3.12. Sketches can use:

- **Core libraries:** WiFi, Network, NetworkClientSecure, HTTPClient, HTTPUpdate,
  WebServer, ESPmDNS, DNSServer, AsyncUDP, NetBIOS, ArduinoOTA, Ethernet, BLE (NimBLE),
  ESP_NOW, ESP_I2S, Wire, SPI, Preferences, EEPROM, FS, SD, SD_MMC, SPIFFS, FFat,
  LittleFS, Ticker, Update, Hash, Console. Left out: Zigbee, Matter, RainMaker,
  OpenThread, Insights, ESP_SR, ESP_Video, WiFiProv and PPP, which need extra
  components, and BluetoothSerial and SimpleBLE, which need classic Bluetooth (the S3
  has none).
- **Popular libraries** (from PlatformIO's top list, see
  `toolchain/arduino-libraries.txt`): Adafruit NeoPixel, FastLED, ArduinoJson,
  PubSubClient, Adafruit GFX/BusIO/Unified Sensor/SSD1306/SH110X/seesaw, DHT, U8g2,
  WebSockets, AsyncTCP, ESPAsyncWebServer.

**Other libraries:** if a sketch includes a header that isn't available (for example
`#include <BleKeyboard.h>`), the output shows the libraries on the
[PlatformIO registry](https://registry.platformio.org) that provide it instead of the
error. Click **Install**, and the build runs again. A library's own dependencies (from its
`library.properties` `depends=` or `library.json`) are installed with it, except ones that
are built in (`toolchain/builtin-libraries.json`) or already installed. Installed libraries are kept in the
browser (IndexedDB), gzip-compressed (NimBLE-Arduino: 5.9 MB of sources stored as 1 MB).
A library is compiled once; its objects are cached, compressed, in the browser too, so
later builds (also after a reload) only compile your sketch. They're listed at the top of the **Examples** panel, with ✕ to remove
one. If an installed library doesn't compile (often: written for Arduino-ESP32 2.x),
**Remove and show alternatives** brings the suggestions back. Downloads come from the
library's GitHub repository through jsDelivr, because PlatformIO's own download
currently can't be fetched from a browser (its redirect sends a duplicate CORS header).
Headers that ESP-IDF 6 removed but old libraries still include (such as
`driver/adc.h`) get an empty stand-in with a warning.

As in the Arduino IDE, `Arduino.h` is included automatically. Unlike the IDE, functions
must be declared before they're used, because no prototypes are generated. `Serial` is
the port you flash over: the native USB port or UART0.

The flash layout is Arduino's "Huge APP" for 4 MB flash: a 3 MB app and an 896 KB
SPIFFS/LittleFS partition.

### Trace: see which line is running, pause and step

Tick **Trace** next to Flash, and flash. While the sketch runs, the line it's executing
is highlighted, with an arrow in the gutter, and a debugger bar appears above the editor:

- **Pause** (F6) stops the sketch where it is; **Continue** (F5) resumes.
- **Step over** (F10) runs the current line, including any calls it makes.
- **Step into** (F11) stops at the next line, also inside a called function.
- **Step out** (Shift+F11) runs until the current function returns.
- **Breakpoints:** click in the gutter next to a line. A line without code moves to the
  next line that has some.

Lines that ran recently leave a **trail**: they keep glowing and fade out over about
1.5 s, so you see every line a loop passes through, even ones that run in microseconds.
The chip collects every distinct place that ran since its last report and sends them 10
times a second.

Pausing stops only your code's task; the rest of the system (USB, Wi-Fi, other tasks)
keeps running. During `delay()` or a library call, the highlight stays on the line of
your code that made the call.

How it works, without a JTAG debugger:

1. **Instrumentation:** the Trace build calls a small hook at every statement of *your*
   code (the core and libraries aren't instrumented). clang's
   `-fsanitize-coverage=trace-pc` covers basic blocks, and `src/debug/statement-hooks.ts`
   adds the statements in between.
2. **The runtime** (`src/debug/trace-runtime.cpp`) records the address. A background
   task reports it 20 times a second over the console as an escape sequence, which the
   monitor hides.
3. **Mapping:** the browser maps addresses to lines with the build's DWARF line table
   (`src/debug/line-table.ts`).
4. **Commands** (pause, step, breakpoints as address ranges) go back over the same
   serial port. The hook stops by blocking the task in place, and compares stack
   pointers to step over or out of calls.

Limits:

- Pause and step need an Arduino sketch, because the runtime reads commands through
  `Serial`. ESP-IDF programs show the running line only.
- In a Trace build the debugger uses the serial input, so `Serial.read()` in your
  sketch won't see the monitor's data.
- Code running in interrupts is highlighted but never stopped.
- Trace builds use `-Og` and are somewhat larger and slower, so untick Trace for
  timing-critical code.

### Examples

**Examples** opens a panel with the examples of the Arduino core and every included
library, 553 in all: only the ones that apply to an ESP32-S3 with this configuration.
Search matches every word against the title, library, folder and the code. Clicking an
example opens it, with tabs for its extra files, and asks first if you've changed your
sketch. Examples marked *doesn't build* failed in the browser toolchain's automatic
build test (usually because they need a library that isn't included); hover for the
error.

**Reset** restarts the chip (while the monitor runs, you see the boot log).

For troubleshooting, add `?tools` to the URL to show the single steps: Build, Connect,
Boot mode, Monitor (start/stop), and Flash .bin… (writes `.bin` files you pick yourself).
