# esp-wasm



https://github.com/user-attachments/assets/2882351a-78eb-490b-93de-1b445b6149a8



An ESP32-S3 IDE that runs entirely in the browser. You write Arduino or ESP-IDF code in
Monaco, clang and GNU ld compile and link it as WebAssembly, and it flashes over USB with
Web Serial. No backend: the site is static files. Needs Chrome or Edge (Web Serial).

## Features

| | |
|---|---|
| **Flash** | One click: compile, enter download mode (DTR/RTS), flash, reset, serial monitor (115200 baud, ESP-IDF colours). The port is remembered. |
| **Arduino / ESP-IDF** | Toolbar switch. Sketches (`setup()`/`loop()`) use arduino-esp32 3.3.12 on ESP-IDF 6.0.3. ESP-IDF programs (`app_main()`) are plain C. Each mode keeps its own code. |
| **Libraries** | Built in: the core libraries plus 15 popular ones. A missing header shows matching [PlatformIO](https://registry.platformio.org) libraries: **Install** adds one with its dependencies, and the build runs again. |
| **Examples** | 553 examples of the core and libraries for this configuration, searchable by title and code. |
| **Trace** | Highlights the running line, with a fading trail of recent lines. Pause, step over/into/out, breakpoints. |
| **Reset / Disconnect** | Restart the chip, or release the serial port for another program. |

Build speed: blink ~0.4 s, a NeoPixel sketch ~2 s. A library compiles once, then it's cached.

## Arduino

- **Core libraries:** WiFi, Network, NetworkClientSecure, HTTPClient, HTTPUpdate,
  WebServer, ESPmDNS, DNSServer, AsyncUDP, NetBIOS, ArduinoOTA, Ethernet, BLE (NimBLE),
  ESP_NOW, ESP_I2S, Wire, SPI, Preferences, EEPROM, FS, SD, SD_MMC, SPIFFS, FFat,
  LittleFS, Ticker, Update, Hash, Console.
  - Left out because they need extra components: Zigbee, Matter, RainMaker, OpenThread,
    Insights, ESP_SR, ESP_Video, WiFiProv, PPP.
  - Left out because they need classic Bluetooth, which the S3 doesn't have:
    BluetoothSerial, SimpleBLE.
- **Popular libraries** ([toolchain/arduino-libraries.txt](toolchain/arduino-libraries.txt)):
  Adafruit NeoPixel, FastLED, ArduinoJson, PubSubClient, Adafruit GFX/BusIO/Unified
  Sensor/SSD1306/SH110X/seesaw, DHT, U8g2, WebSockets, AsyncTCP, ESPAsyncWebServer.
- **Like the Arduino IDE:** `Arduino.h` is included automatically, and function
  prototypes are generated.
- **`Serial`** is the port you flash over: the native USB port or UART0. ESP-IDF's
  console goes to both.
- **Flash layout (4 MB):** a 3 MB app and an 896 KB SPIFFS/LittleFS partition, as in
  Arduino's "Huge APP".

### Installed libraries

- **Storage:** kept in the browser (IndexedDB) and gzip-compressed. NimBLE-Arduino's
  5.9 MB of sources is stored as 1 MB.
- **Compiled objects** are cached too, so only the first build compiles a library
  (NimBLE-Arduino: ~30 s once, then ~3 s builds).
- **Managing them:** they're listed at the top of the Examples panel, with ✕ to remove
  one. If a library doesn't compile (often written for Arduino-ESP32 2.x),
  **Remove and show alternatives** brings the suggestions back.
- **Downloads** come from the library's GitHub repository through jsDelivr.
  PlatformIO's own download can't be fetched from a browser, because its redirect sends
  a duplicate CORS header.
- **Old ESP-IDF headers** that ESP-IDF 6 removed (`driver/adc.h`) get an empty stand-in
  with a warning.

## Trace (debugging without JTAG)

Tick **Trace** and flash. The debugger bar works with the usual keys:

| Key | Action |
|---|---|
| F6 / F5 | pause / continue |
| F10 | step over |
| F11 | step into |
| Shift+F11 | step out |
| gutter click | breakpoint |

- **The running line** is highlighted. Lines that ran recently glow and fade over
  ~1.5 s. The minimap shows both, plus breakpoints. The editor only scrolls when
  execution stops.
- **How it works:**
  1. The build adds a hook at every statement and basic block of *your* code (clang
     `-fsanitize-coverage=trace-pc`, plus `src/debug/statement-hooks.ts`).
  2. The runtime (`src/debug/trace-runtime.cpp`) reports addresses over serial as hidden
     escape sequences.
  3. The browser maps them to lines with the DWARF line table.
  4. Pausing blocks only your task; USB, Wi-Fi and other tasks keep running.
- **Limits:**
  - Pause and step work in Arduino sketches only; ESP-IDF programs only show the line.
  - In a Trace build, `Serial.read()` doesn't receive data, because the debugger owns
    the serial input.
  - Code in interrupts is highlighted but never paused.
  - Trace builds use `-Og`, so they're larger and slower.

## Inspect (hardware debugging over USB-JTAG)

**Inspect** opens a DevTools-style panel under the editor that talks to the ESP32-S3's built-in USB-JTAG
(WebUSB, Chrome/Edge; no extra hardware, use the board's native USB port). Build with **Trace** on so the
inspector has your sources' line table and symbols, flash, then **Connect JTAG**.

- **In the editor**: the paused line is highlighted, globals your code uses show their live value after the
  line (changed values glow), hovering a variable shows its value and address, and gutter breakpoints become
  hardware breakpoints (two available).
- **Variables**: search every variable in the firmware, watch it, change its value (click it), switch
  dec/hex/float, and see a history sparkline.
- **Memory**: hex view by address or variable name; bytes that changed since the last stop are highlighted.
- **Stack**, **Registers**, **Timeline** (every stop and every variable change, click to jump to the line).
- **Pause / Continue / Step / Step over / Step instruction**, and **Live** (briefly halts the CPU twice a second).

The Xtensa debug-module code (`src/debug/jtag/xtensa-ocd.ts`) follows the OCD documentation and OpenOCD but has
not yet been run against hardware. It drives the PRO_CPU only. On Windows the JTAG interface needs the WinUSB driver.

## Develop

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + static site in dist/
```

The app loads its toolchain from `public/toolchain/`, which is gitignored (~80 MB):
clang (`llvm.wasm`), GNU ld (`ld.wasm`), the precompiled ESP-IDF + Arduino
(`sysroot.tar.gz`), the bootloader and partition table, and the examples.
[toolchain/README.md](toolchain/README.md) describes how they're made:

```sh
toolchain/setup-idf.sh && toolchain/build-all.sh   # ~1 h, writes public/toolchain/
```

Add `?tools` to the URL for single steps (Build, Connect, Boot mode, Monitor, Flash .bin…).

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` builds and publishes the site on every push to `main`. The
toolchain isn't built in CI (it takes over an hour); it's a GitHub Release that the
workflow downloads, named in `toolchain/RELEASE`.

1. **Once:** in the repository settings, set **Pages → Source** to **GitHub Actions**.
2. **For each new toolchain:** run `toolchain/publish-release.sh` (needs `gh`:
   `brew install gh && gh auth login`), then commit and push `toolchain/RELEASE`.

The site works from a subfolder (`<user>.github.io/esp-wasm/`) and needs no special
headers.
