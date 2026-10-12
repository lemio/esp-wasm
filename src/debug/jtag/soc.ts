/**
 * What an ESP32-S3 address is, in words: which memory or peripheral it belongs to, which
 * register it is and what its bits mean, and whether reading it is harmless. For students who
 * know what a register or a bus is, but not this chip.
 *
 * The memory map follows the Technical Reference Manual (TRM v1.8, chapter 4, tables 4.3-1 to
 * 4.3-3). The register database (soc/esp32s3.json) is generated from ESP-IDF's register headers
 * and the TRM's register summaries by toolchain/scripts/gen-soc-registers.py; it is loaded on
 * first use, as it's about 1 MB.
 */

import dbUrl from "./soc/esp32s3.json?url";

export interface Field {
  name: string;
  lo: number;
  hi: number;
  access: string;
  desc: string;
}

export interface Register {
  addr: number;
  name: string;
  desc: string;
  fields: Field[];
  peripheral: Peripheral;
}

export interface Peripheral {
  title: string;
  base: number;
  size: number;
  intro: string;
  regs: Register[];
}

interface Db {
  peripherals: Peripheral[];
  iomux: Record<string, { off: number; pad: string; funcs: Record<string, string> }>;
  signals: { in: Record<string, string>; out: Record<string, string> };
}

type RawDb = {
  peripherals: { title: string; base: number; size: number; regs: [number, string, string, [string, number, number, string, string][]][] }[];
  iomux: Db["iomux"];
  signals: Db["signals"];
};

let db: Db | undefined;
let loading: Promise<Db> | undefined;

/** The register database; undefined until `loadSoc()` has finished. */
export const soc = () => db;

export function loadSoc(): Promise<Db> {
  loading ??= fetch(dbUrl).then((r) => r.json() as Promise<RawDb>).then((raw) => {
    const peripherals = raw.peripherals.map((p) => {
      const per: Peripheral = { title: p.title, base: p.base, size: p.size, intro: INTROS[p.title.split(" (")[0]] ?? INTROS[p.title] ?? "", regs: [] };
      per.regs = p.regs.map(([off, name, desc, fields]) => ({
        addr: p.base + off, name, desc, peripheral: per,
        fields: fields.map(([fname, lo, hi, access, fdesc]) => ({ name: fname, lo, hi, access, desc: fdesc })),
      }));
      return per;
    });
    return (db = { peripherals, iomux: raw.iomux, signals: raw.signals });
  });
  return loading;
}

// ---- the memory map ----

export interface Region {
  lo: number;
  hi: number;
  name: string;
  /** What lives there, for someone new to the chip. */
  explain: string;
  kind: "ram" | "rom" | "flash" | "rtc" | "peripheral";
  /** The same bytes at another address (the other bus): offset to add. */
  alias?: { delta: number; name: string };
  /** Reads must be whole, aligned 32-bit words (the instruction bus). */
  wordOnly?: boolean;
}

/** TRM tables 4.3-1 (internal memory) and 4.3-2 (external memory, through the caches). */
export const REGIONS: Region[] = [
  {
    lo: 0x3c000000, hi: 0x3e000000, kind: "flash", name: "Flash or PSRAM, through the data cache",
    explain: "The external flash chip (or PSRAM), seen through the data cache. Your program's constant data lives here: string literals, `const` tables. The cache maps it in 64 KB pages (its MMU decides which part of the flash appears where), so an unmapped address reads garbage or fails.",
  },
  {
    lo: 0x3fc88000, hi: 0x3fcf0000, kind: "ram", name: "Internal SRAM 1 (data bus)", alias: { delta: 0x6f0000, name: "instruction bus" },
    explain: "The main RAM (416 KB): global and static variables, the heap (malloc, new, String) and every task's stack. The same RAM also appears on the instruction bus 0x6F0000 higher (0x4037_8000 and up), where code copied to RAM runs.",
  },
  {
    lo: 0x3fcf0000, hi: 0x3fd00000, kind: "ram", name: "Internal SRAM 2 (data bus)",
    explain: "64 KB of RAM. Part of it (32 or 64 KB) can be configured as the data cache for flash/PSRAM; that part can't be read by the CPU then.",
  },
  {
    lo: 0x3ff00000, hi: 0x3ff20000, kind: "rom", name: "Internal ROM 1 (data bus)", alias: { delta: 0x40140000, name: "instruction bus" },
    explain: "Read-only data of the boot ROM, fixed at the factory. The same bytes appear at 0x4004_0000 and up on the instruction bus.",
  },
  {
    lo: 0x40000000, hi: 0x40040000, kind: "rom", name: "Internal ROM 0",
    explain: "The boot ROM (256 KB, fixed at the factory): the first code that runs after a reset (it loads the bootloader from flash) and helper functions ESP-IDF calls, like memcpy and the UART download mode.",
  },
  {
    lo: 0x40040000, hi: 0x40060000, kind: "rom", name: "Internal ROM 1 (instruction bus)", alias: { delta: -0x40140000, name: "data bus" }, wordOnly: true,
    explain: "More boot ROM code and data. The same bytes appear at 0x3FF0_0000 and up on the data bus.",
  },
  {
    lo: 0x40370000, hi: 0x40378000, kind: "ram", name: "Internal SRAM 0 (instruction bus)", wordOnly: true,
    explain: "32 KB of RAM for code (IRAM): interrupt handlers and code that must run while the flash is busy. Part of it can be configured as the instruction cache; that part can't be read then.",
  },
  {
    lo: 0x40378000, hi: 0x403e0000, kind: "ram", name: "Internal SRAM 1 (instruction bus)", alias: { delta: -0x6f0000, name: "data bus" }, wordOnly: true,
    explain: "The main RAM again, seen through the instruction bus (code placed in RAM runs from here). The same bytes are at 0x6F0000 lower on the data bus. Through this bus only aligned 32-bit reads work.",
  },
  {
    lo: 0x42000000, hi: 0x44000000, kind: "flash", name: "Flash, through the instruction cache", wordOnly: true,
    explain: "Your program's code: the flash chip, seen through the instruction cache in 64 KB pages. Functions of your sketch, Arduino and ESP-IDF run from here.",
  },
  {
    lo: 0x50000000, hi: 0x50002000, kind: "rtc", name: "RTC SLOW memory",
    explain: "8 KB of RAM in the always-on (RTC) power domain: it keeps its contents during deep sleep, and the ULP co-processor can use it. Also visible at 0x6002_1000.",
  },
  {
    lo: 0x600fe000, hi: 0x60100000, kind: "rtc", name: "RTC FAST memory",
    explain: "8 KB of RAM in the always-on power domain: kept during deep sleep. ESP-IDF puts code here that runs when waking up.",
  },
  {
    lo: 0x60000000, hi: 0x600d1000, kind: "peripheral", name: "Peripheral registers",
    explain: "Not memory: every 32-bit word here is a register of a hardware block (pins, UARTs, timers, …). Writing one changes what the hardware does; reading one shows its state, which the hardware may change by itself at any moment.",
  },
];

export const regionAt = (addr: number): Region | undefined => REGIONS.find((r) => addr >= r.lo && addr < r.hi);

/** One-paragraph introductions of the peripherals, for someone who hasn't met them yet. */
const INTROS: Record<string, string> = {
  "UART0": "Serial port 0. On most boards its TX/RX (GPIO43/44) go to the USB-to-serial chip; ESP-IDF prints its boot log here.",
  "UART1": "Serial port 1 (Arduino's Serial1), on any pins you route it to.",
  "UART2": "Serial port 2 (Arduino's Serial2), on any pins you route it to.",
  "SPI1": "Controls the flash chip for writes and erases (the CPU reads flash through the cache via SPI0).",
  "SPI0": "Feeds the instruction/data caches from the flash chip and PSRAM.",
  "SPI2": "General-purpose SPI controller (FSPI): Arduino's SPI, displays, SD cards.",
  "SPI3": "Second general-purpose SPI controller.",
  "GPIO": "The GPIO matrix: the level each pin outputs (OUT), which pins drive (ENABLE), the levels read on the pins (IN), and which peripheral signal is routed to which pin (FUNCn_OUT_SEL / FUNCn_IN_SEL). Bit n of OUT, ENABLE and IN is GPIO n (OUT1 etc. hold GPIO 32–48).",
  "GPIO sigma-delta": "Sigma-delta modulators: a cheap way to output an analog-ish level on a pin.",
  "eFuse": "One-time-programmable fuses, burned at the factory or by you: MAC address, chip revision, flash settings, security keys. The registers hold copies read at boot.",
  "RTC control": "The always-on part of the chip: power modes, deep sleep and wake-up, the RTC watchdog, reset causes, and 8 registers (STORE0–7) that keep their value during deep sleep.",
  "RTC IO": "Pins that work in deep sleep (GPIO0–21): their low-power configuration, and touch sensing.",
  "RTC sensors": "The analog side: ADC control, touch sensors, temperature sensor.",
  "RTC I2C": "An I2C controller for the ULP co-processor, usable in deep sleep.",
  "IO MUX": "One register per pad (pin): which function it connects to (MCU_SEL: 1 is plain GPIO, through the GPIO matrix), pull-up/pull-down resistors, input enable and drive strength.",
  "I2S0": "Audio interface 0 (I2S/PDM/TDM), also used for parallel data.",
  "I2S1": "Audio interface 1.",
  "I2C0": "I2C controller 0 (Arduino's Wire).",
  "I2C1": "I2C controller 1 (Wire1).",
  "UHCI0": "Connects a UART to the DMA controller, for large transfers.",
  "RMT": "Remote-control peripheral: sends and receives precisely timed pulse trains. Arduino's NeoPixel (WS2812) driver on the S3 uses it.",
  "PCNT": "Pulse counter: counts edges on pins (encoders, frequency).",
  "LEDC": "LED PWM controller: up to 8 PWM channels (analogWrite and ledcWrite use it).",
  "MCPWM0": "Motor-control PWM unit 0: complementary PWM with dead time, capture inputs.",
  "MCPWM1": "Motor-control PWM unit 1.",
  "Timer group 0": "Two 54-bit general-purpose timers (Arduino's timerBegin) and a watchdog. ESP-IDF's task watchdog uses this group's watchdog.",
  "Timer group 1": "Two more timers and the watchdog ESP-IDF's interrupt watchdog uses.",
  "System timer": "A 52-bit counter that runs at 16 MHz from boot: the time base for millis(), micros() and FreeRTOS's tick.",
  "SYSCON": "Odd jobs: clock settings of the APB bus, Wi-Fi/Bluetooth power controls, memory power.",
  "SD/MMC host": "SD card / eMMC host controller (SD_MMC library).",
  "USB Serial/JTAG": "The native USB port's built-in function: a serial port (Serial when 'USB CDC on boot') and the JTAG adapter this inspector talks through.",
  "USB wrapper": "Switches the native USB pins between the USB Serial/JTAG and the full USB OTG controller.",
  "GDMA": "The DMA controller: moves data between memory and peripherals without the CPU.",
  "ADC controller": "The digital controller of the ADCs (analogRead).",
  "LCD/camera": "Parallel LCD output and camera input.",
  "System registers": "Clock gating and resets of every peripheral (a peripheral whose clock is off reads as 0), CPU clock speed, and the cross-core interrupt registers.",
  "Permission control": "Which memory and peripherals each core and DMA may access (PMS).",
  "Interrupt matrix": "Routes the ~100 peripheral interrupt sources to the CPU's interrupt inputs.",
  "Cache and MMU": "Configuration of the caches and of the MMU that maps flash/PSRAM pages into the address space.",
  "Debug assist": "Hardware help for debugging: stack bound checks, bus access logging.",
  "World controller": "Switches the CPU between secure and non-secure 'worlds'.",
};

// ---- registers ----

/** The register at this address, or undefined (not a peripheral, a gap, or the database isn't loaded). */
export function registerAt(addr: number): Register | undefined {
  const p = peripheralAt(addr);
  return p?.regs.find((r) => r.addr === (addr & ~3));
}

export function peripheralAt(addr: number): Peripheral | undefined {
  // The block with the nearest base at or below the address (blocks sit close together: RTC IO at
  // 0x6000_8400 is followed by RTC sensors at 0x6000_8800). Same base (the interrupt matrix of
  // either core): the first one wins.
  let best: Peripheral | undefined;
  for (const p of db?.peripherals ?? []) {
    if (addr >= p.base && addr < p.base + Math.max(p.size, 0x1000) && (!best || p.base > best.base)) best = p;
  }
  return best;
}

/**
 * Registers that change state when read: reading takes a byte out of a receive FIFO. The TRM
 * lists them as "RO", but its functional descriptions say so (e.g. UART: "read data from RXFIFO
 * via UART_RXFIFO_RD_BYTE"). The inspector never reads these.
 */
const READ_SIDE_EFFECTS: [RegExp, string][] = [
  [/^UART_FIFO_REG$/, "reading it takes the next received byte out of the UART's receive FIFO: the program would never see that byte"],
  [/^I2C_DATA_REG$/, "reading it takes the next byte out of the I2C receive FIFO"],
  [/^RMT_CH\d+DATA_REG$/, "reading it advances the RMT channel's FIFO pointer"],
  [/^USB_SERIAL_JTAG_EP1_REG$/, "reading it takes the next received byte out of the USB serial port's receive FIFO"],
  [/^RTC_I2C_DATA_REG$/, "reading it can take the next received byte"],
];

/** Why reading this register would disturb the program, if it would. */
export function readSideEffect(reg: Register): string | undefined {
  return READ_SIDE_EFFECTS.find(([re]) => re.test(reg.name))?.[1];
}

/** Whether a 32-bit word at this address is safe for the inspector to read. */
export function safeToRead(addr: number): boolean {
  const reg = registerAt(addr);
  return !reg || !readSideEffect(reg);
}

/** What an access type (TRM glossary, "Access Types for Registers") means, in words. */
export function accessMeaning(access: string): string {
  const parts = access.split("/");
  const has = (p: string) => parts.includes(p);
  const out: string[] = [];
  if (access === "RO" || (has("R") && parts.length === 1)) out.push("read-only: the hardware sets it");
  else if (access === "WO" || access === "WOD") out.push("write-only: reading gives 0, not what was written");
  else if (access === "WT") out.push("writing it triggers an action; reads back 0");
  else if (has("R") && has("W")) out.push("a setting you can read and write");
  if (has("W1C") || has("WTC") || has("WC")) out.push("write 1 to clear it (how interrupt flags are acknowledged)");
  if (has("W1S") || has("WS")) out.push("write 1 to set it");
  if (has("SS")) out.push("the hardware sets it when an event happens");
  if (has("SC")) out.push("the hardware clears it by itself (e.g. when a requested action is done)");
  if (has("RC")) out.push("reading it clears it");
  return out.join("; ") || access;
}

/**
 * Notes on registers whose value doesn't mean what it seems, or that read differently from what
 * was written: by register name.
 */
export function registerNotes(reg: Register): string[] {
  const n = reg.name;
  const notes: string[] = [];
  const effect = readSideEffect(reg);
  if (effect) notes.push(`Not read by the inspector: ${effect}.`);
  if (/_W1T[SC]_REG$/.test(n)) {
    notes.push(`A write-only shortcut: writing 1-bits ${n.includes("W1TS") ? "sets" : "clears"} those bits of ${n.replace(/_W1T[SC]_REG$/, "_REG")} without touching the others (no read-modify-write, so it's safe against interrupts). Reading it always gives 0; look at ${n.replace(/_W1T[SC]_REG$/, "_REG")} instead.`);
  }
  if (/_INT_RAW_REG$/.test(n)) notes.push("Raw interrupt flags: the hardware sets a bit when its event happens, even if that interrupt isn't enabled.");
  if (/_INT_ST_REG$/.test(n)) notes.push("Interrupt status: the RAW flags that are also enabled in INT_ENA; these are the ones that interrupt the CPU.");
  if (/_INT_ENA_REG$/.test(n)) notes.push("Which interrupt flags may interrupt the CPU.");
  if (/_INT_CLR_REG$/.test(n)) notes.push("Write 1 to a bit to clear that interrupt flag; reading it gives 0.");
  if (/^TIMG_T\d(LO|HI)_REG$/.test(n)) notes.push("A snapshot, not the live counter: it's only refreshed when the program writes TIMG_TnUPDATE_REG.");
  if (/^SYSTIMER_UNIT\d_VALUE_(LO|HI)_REG$/.test(n)) notes.push("A snapshot: refreshed when SYSTIMER_UNITn_OP_REG is written (the counter itself runs at 16 MHz).");
  if (/^GPIO_IN1?_REG$/.test(n)) notes.push("The levels on the pins right now, sampled by the hardware. Only meaningful for pins whose input is enabled (IO MUX FUN_IE).");
  if (/^GPIO_OUT1?_REG$/.test(n)) notes.push("The level the program asks each pin to output. It only reaches the pin if that pin's output is enabled (GPIO_ENABLE) and the pin is routed to 'simple GPIO output' (its FUNCn_OUT_SEL is 256); otherwise a peripheral drives the pin, or nothing does.");
  if (/^GPIO_ENABLE1?_REG$/.test(n)) notes.push("1 = the pin is an output (driven); 0 = high impedance, input only.");
  if (/_DATE_REG$|_VERSION_REG$/.test(n)) notes.push("A version stamp of the hardware block, not a date or setting.");
  if (/^RTC_CNTL_STORE\d_REG$/.test(n)) notes.push("A general-purpose register that keeps its value in deep sleep; ESP-IDF uses some for boot and wake-up information.");
  if (/^EFUSE_RD_/.test(n)) notes.push("A copy of the eFuses, loaded at boot: fixed values (MAC address, calibration, settings), not live state.");
  if (reg.peripheral.title.startsWith("System registers") || /CLK_EN|RST_EN/.test(n)) notes.push("A peripheral whose clock is disabled here, or which is held in reset, reads as 0 in all its registers.");
  return notes;
}

export interface DecodedField {
  field: Field;
  value: number;
  /** The value in words, where that's possible. */
  text: string;
}

/** UART_SCLK_SEL values (TRM, UART_CLK_CONF_REG): the clock and what it's called. */
const UART_CLOCKS: Record<number, [number, string]> = { 1: [80e6, "APB_CLK (80 MHz)"], 2: [17.5e6, "RC_FAST_CLK (~17.5 MHz)"], 3: [40e6, "XTAL_CLK (40 MHz crystal)"] };

const bits = (v: number, lo: number, hi: number) => hi - lo >= 31 ? v >>> 0 : (v >>> lo) & ((1 << (hi - lo + 1)) - 1);
const DRIVE = ["~5 mA", "~10 mA", "~20 mA", "~40 mA"];

/** Pins whose bits are set in a GPIO bitmask register (bit n = GPIO n, or 32 + n for the *1 registers). */
function pinList(value: number, high: boolean): string {
  const pins: number[] = [];
  for (let b = 0; b < 32; b++) if ((value >>> b) & 1) pins.push(b + (high ? 32 : 0));
  return pins.length ? `GPIO ${pins.join(", ")}` : "none";
}

/**
 * The fields of a register value, each in words where possible. `peek` gives the value of
 * another register of the same read (some values only mean something together, like a baud rate).
 */
export function decodeRegister(reg: Register, value: number, peek?: (addr: number) => number | undefined): DecodedField[] {
  const n = reg.name;
  const out: DecodedField[] = [];
  for (const f of reg.fields) {
    const v = bits(value, f.lo, f.hi);
    let text = f.hi === f.lo ? (v ? "1 (on)" : "0 (off)") : `${v}${v > 9 ? ` (0x${v.toString(16)})` : ""}`;
    if (/^GPIO_(OUT|IN|ENABLE|STATUS)1?_(REG)$/.test(n) || /^GPIO_(OUT|IN|ENABLE)(1)?_DATA/.test(f.name)) {
      text = `${pinList(v, /1_REG$/.test(n))}${/ENABLE/.test(n) ? " drive (outputs)" : /IN/.test(n) ? " read high" : " set high"}`;
    } else if (/^IO_MUX_GPIO(\d+)_REG$/.test(n)) {
      const gpio = n.match(/\d+/)![0];
      if (f.name === "MCU_SEL") text = `${v}: ${db?.iomux[gpio]?.funcs[String(v)] ?? "?"}${v === 1 ? " (GPIO matrix: see GPIO_FUNC" + gpio + "_OUT_SEL_CFG)" : ""}`;
      if (f.name === "FUN_DRV" || f.name === "SLP_DRV") text = `${v}: ${DRIVE[v]}`;
    } else if (/^GPIO_FUNC\d+_OUT_SEL_CFG_REG$/.test(n) && /OUT_SEL$/.test(f.name)) {
      text = v === 256 ? "256: simple GPIO output (the GPIO_OUT register's bit)" : `${v}: ${db?.signals.out[String(v)] ?? "?"} (a peripheral drives this pin)`;
    } else if (f.name === "UART_SCLK_SEL") {
      text = `${v}: ${UART_CLOCKS[v]?.[1] ?? "?"}`;
    } else if (/^GPIO_FUNC\d+_IN_SEL_CFG_REG$/.test(n) && /IN_SEL$/.test(f.name)) {
      text = v === 0x38 ? "0x38: constant 1" : v === 0x3c ? "0x3C: constant 0" : `GPIO ${v}`;
    }
    out.push({ field: f, value: v, text });
  }
  // A few registers mean more as a whole.
  if (n === "GPIO_STRAP_REG") {
    // TRM 6.15 (GPIO_STRAPPING): bit 2 GPIO46, bit 3 GPIO0, bit 4 GPIO45, bit 5 GPIO3, latched at reset.
    const pin = (b: number) => (value >>> b) & 1;
    out.length = 0;
    out.push({ field: reg.fields[0], value, text: `latched at reset: GPIO0=${pin(3)}, GPIO3=${pin(5)}, GPIO45=${pin(4)}, GPIO46=${pin(2)}` });
    out.push({ field: { name: "boot mode", lo: 3, hi: 3, access: "RO", desc: "GPIO0 at reset" }, value: pin(3), text: pin(3) ? "GPIO0 was high: normal boot from flash" : "GPIO0 was low: download mode (waiting for a flasher)" });
  }
  if (/^UART_CLKDIV_REG$/.test(n)) {
    // TRM 26.4 (UART clock): baud = source clock / (SCLK_DIV_NUM + 1) / (CLKDIV + CLKDIV_FRAG/16).
    const div = bits(value, 0, 11) + bits(value, 20, 23) / 16;
    const conf = peek?.(reg.peripheral.base + 0x78); // UART_CLK_CONF_REG
    const source = conf === undefined ? undefined : UART_CLOCKS[bits(conf, 20, 21)];
    const pre = conf === undefined ? 1 : bits(conf, 12, 19) + 1;
    if (div && source) {
      out.push({ field: { name: "baud rate", lo: 0, hi: 31, access: "", desc: `${source[1]} / ${pre} / ${div.toFixed(2)}` }, value: 0, text: `≈ ${Math.round(source[0] / pre / div)} baud` });
    }
  }
  return out;
}

// ---- pins ----

/** What's special about a pin on the ESP32-S3 (datasheet pin list; boards may differ). */
export function pinNote(gpio: number): string {
  if ([0, 3, 45, 46].includes(gpio)) return "strapping pin: its level at reset selects the boot mode";
  if (gpio === 19 || gpio === 20) return `native USB ${gpio === 19 ? "D−" : "D+"}: in use while the USB port is connected`;
  if (gpio === 43 || gpio === 44) return `UART0 ${gpio === 43 ? "TX" : "RX"} by default (boot log)`;
  if (gpio >= 26 && gpio <= 32) return "usually wired to the module's flash/PSRAM: don't use";
  if (gpio >= 33 && gpio <= 37) return "used by octal PSRAM on modules that have it (-R8)";
  if (gpio >= 39 && gpio <= 42) return "external JTAG pins by default (MTCK, MTDO, MTDI, MTMS); free to use while JTAG goes over USB, as here";
  if (gpio === 38 || gpio === 48) return "the RGB LED on the ESP32-S3-DevKitC (48 on v1.0, 38 on v1.1)";
  return "";
}

/**
 * The peripheral a GPIO-matrix or IO MUX signal belongs to, and a filter that narrows its
 * registers to the signal's channel, so the pin table can link to them.
 */
export function signalPeripheral(signal: string): { base: number; filter: string; label: string } | undefined {
  const n = (re: RegExp) => Number(signal.match(re)?.[1] ?? 0);
  const rules: [RegExp, () => { base: number; filter: string; label: string }][] = [
    [/^SUBSPI/, () => ({ base: 0x60002000, filter: "", label: "SPI1, the flash controller" })],
    [/^SPI(CLK|CS\d|D\d*|Q|HD|WP|DQS)/, () => ({ base: 0x60003000, filter: "", label: "SPI0, the controller the caches read the flash/PSRAM through" })],
    [/^FSPI/, () => ({ base: 0x60024000, filter: "", label: "SPI2 (FSPI), the general-purpose SPI" })],
    [/^SPI3/, () => ({ base: 0x60025000, filter: "", label: "SPI3" })],
    [/^U(\d)/, () => ({ base: [0x60000000, 0x60010000, 0x6002e000][n(/^U(\d)/)], filter: "", label: `UART${n(/^U(\d)/)}` })],
    [/^RMT_SIG_(?:OUT|IN)(\d)/, () => ({ base: 0x60016000, filter: `CH${n(/(\d)$/)}`, label: `RMT channel ${n(/(\d)$/)}` })],
    [/^LEDC_LS_SIG_OUT(\d)/, () => ({ base: 0x60019000, filter: `CH${n(/(\d)$/)}`, label: `LEDC (PWM) channel ${n(/(\d)$/)}` })],
    [/^I2CEXT(\d)/, () => ({ base: [0x60013000, 0x60027000][n(/^I2CEXT(\d)/)], filter: "", label: `I2C${n(/^I2CEXT(\d)/)}` })],
    [/^I2S(\d)/, () => ({ base: [0x6000f000, 0x6002d000][n(/^I2S(\d)/)], filter: "", label: `I2S${n(/^I2S(\d)/)}` })],
    [/^PWM(\d)/, () => ({ base: [0x6001e000, 0x6002c000][n(/^PWM(\d)/)], filter: "", label: `MCPWM${n(/^PWM(\d)/)}` })],
    [/^PCNT/, () => ({ base: 0x60017000, filter: "", label: "the pulse counter" })],
    [/^SDHOST/, () => ({ base: 0x60028000, filter: "", label: "the SD/MMC host" })],
    [/^(CAM|LCD)/, () => ({ base: 0x60041000, filter: "", label: "the LCD/camera controller" })],
    [/^TWAI/, () => ({ base: 0x6002b000, filter: "", label: "TWAI (CAN)" })],
    [/^USB/, () => ({ base: 0x60038000, filter: "", label: "the USB Serial/JTAG controller" })],
    [/^(SIG_)?GPIO/, () => ({ base: 0x60004000, filter: "", label: "the GPIO matrix" })],
  ];
  const rule = rules.find(([re]) => re.test(signal));
  return rule?.[1]();
}

/**
 * The CPU clock from SYSTEM_SYSCLK_CONF_REG (SOC_CLK_SEL: 0 crystal, 1 PLL, 2 RC_FAST; PRE_DIV_CNT)
 * and SYSTEM_CPU_PER_CONF_REG (CPUPERIOD_SEL, PLL_FREQ_SEL), as the TRM's reset and clock chapter
 * describes them.
 */
export function cpuHz(sysclk: number | undefined, perConf: number | undefined): number | undefined {
  if (sysclk === undefined || perConf === undefined) return undefined;
  const source = (sysclk >>> 10) & 3, pre = (sysclk & 0x3ff) + 1;
  if (source === 0) return 40e6 / pre;
  if (source === 2) return 17.5e6 / pre;
  const sel = perConf & 3, pll480 = (perConf >>> 2) & 1;
  return ([80e6, 160e6, pll480 ? 240e6 : 160e6][sel] ?? 160e6);
}

/** GPIO numbers that exist on the ESP32-S3. */
export const GPIOS = [...Array(49).keys()].filter((g) => g < 22 || g > 25);
