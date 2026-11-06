/**
 * What a CH32V003 address is, in words: its memory map (reference manual CH32V003RM, chapter
 * 1.2), which register it is and what its bits mean. The register database
 * (soc/ch32v003.json) is generated from WCH's SVD file by toolchain/scripts/gen-soc-ch32v003.py.
 */
import dbUrl from "./soc/ch32v003.json?url";
import {
  type DecodedField, type Db, type Peripheral, type RawDb, type Region, type Register, type SocApi, parseDb,
} from "./soc";

let db: Db | undefined;
let loading: Promise<Db> | undefined;

export const RAM_BASE = 0x20000000;
export const RAM_SIZE = 2048;
export const FLASH_BASE = 0x08000000;
export const FLASH_SIZE = 16384;

export const REGIONS: Region[] = [
  {
    lo: 0x00000000, hi: FLASH_SIZE, kind: "flash", name: "Flash (where the CPU runs it)", alias: { delta: FLASH_BASE, name: "the flash's own address" },
    explain: "The 16 KB of flash, mapped at address 0: the CPU starts at 0 after a reset and runs your program from here. Code and constants (string literals, `const` tables) live here. The same bytes are at 0x0800_0000, the flash's own address.",
  },
  {
    lo: FLASH_BASE, hi: FLASH_BASE + FLASH_SIZE, kind: "flash", name: "Flash (16 KB)", alias: { delta: -FLASH_BASE, name: "address 0, where the CPU runs it" },
    explain: "The program memory: your code and constants, written by the programmer in 64-byte pages. The CPU sees the same bytes at address 0.",
  },
  {
    lo: 0x1ffff000, hi: 0x1ffff780, kind: "rom", name: "System flash (the boot loader)",
    explain: "1920 bytes WCH programmed at the factory: the bootloader that can load a program over the UART (IAP). The chip runs it after a reset only when the option bytes say so.",
  },
  {
    lo: 0x1ffff780, hi: 0x1ffff800, kind: "rom", name: "Vendor bytes (electronic signature)",
    explain: "Read-only facts about this chip: the flash size (0x1FFF_F7E0) and a unique 96-bit ID (0x1FFF_F7E8).",
  },
  {
    lo: 0x1ffff800, hi: 0x1ffff840, kind: "rom", name: "Option bytes",
    explain: "Settings that survive a reset and reprogramming: read protection, whether PD7 is the reset pin, the watchdog's start-up mode, boot from the bootloader, and two user data bytes.",
  },
  {
    lo: RAM_BASE, hi: RAM_BASE + RAM_SIZE, kind: "ram", name: "SRAM (2 KB)",
    explain: "All the RAM there is: global and static variables from the start (initialized ones, then the zeroed .bss), and the stack, which grows down from the end (0x2000_0800). What's in between is free; a stack that grows into the variables overwrites them.",
  },
  {
    lo: 0x40000000, hi: 0x40024000, kind: "peripheral", name: "Peripherals",
    explain: "The hardware's registers: GPIO ports, timers, the USART, SPI, I2C, the ADC, DMA, clocks. Reading or writing one talks to that hardware directly; funDigitalWrite and friends are just writes here.",
  },
  {
    lo: 0xe0000000, hi: 0xe0100000, kind: "peripheral", name: "Core peripherals",
    explain: "Part of the QingKe RISC-V core itself: the interrupt controller (PFIC, 0xE000_E000) and the SysTick timer (0xE000_F000) that ch32fun's Delay_Ms counts with.",
  },
];

export const regionAt = (addr: number): Region | undefined => REGIONS.find((r) => addr >= r.lo && addr < r.hi);

const INTROS: Record<string, string> = {
  "PWR": "Power control: the voltage detector and deep-sleep (standby) settings.",
  "RCC": "Reset and clock control: the clock source (24 MHz internal oscillator, a crystal, the PLL that doubles it to 48 MHz), and one enable bit per peripheral. A peripheral whose clock is off ignores writes and reads as 0.",
  "EXTEN": "Extended configuration: the internal voltage regulator and the LOCKUP reset.",
  "GPIOA": "Port A: only PA1 and PA2 (also the crystal's pins). CFGLR has 4 bits per pin: MODE (input, or output at 2/10/30 MHz) and CNF (analog, floating, pull-up/down; push-pull, open-drain, alternate function). INDR: the levels read. OUTDR: the levels output (for an input with CNF=pull, its bit selects pull-up). BSHR/BCR set or clear OUTDR bits in one write.",
  "GPIOC": "Port C: PC0–PC7. CFGLR has 4 bits per pin: MODE (input, or output at 2/10/30 MHz) and CNF (analog, floating, pull-up/down; push-pull, open-drain, alternate function). INDR: the levels read. OUTDR: the levels output (for an input with CNF=pull, its bit selects pull-up). BSHR/BCR set or clear OUTDR bits in one write.",
  "GPIOD": "Port D: PD0–PD7 (PD1 is SWIO, the debug wire this inspector reads the chip through). CFGLR has 4 bits per pin: MODE (input, or output at 2/10/30 MHz) and CNF (analog, floating, pull-up/down; push-pull, open-drain, alternate function). INDR: the levels read. OUTDR: the levels output. BSHR/BCR set or clear OUTDR bits in one write.",
  "AFIO": "Alternate functions: which pins the USART, SPI, I2C and timers use (PCFR1's remap bits), and which port each external interrupt line watches (EXTICR).",
  "EXTI": "External interrupts: an interrupt or event on a pin's rising or falling edge (one line per pin number; AFIO_EXTICR picks the port).",
  "DMA1": "The DMA controller: 7 channels that copy data between memory and peripherals (the ADC, SPI, USART) without the CPU.",
  "IWDG": "Independent watchdog: resets the chip unless the program reloads it in time. Runs from its own 128 kHz clock.",
  "WWDG": "Window watchdog: resets the chip if the program refreshes it too late, or too early.",
  "TIM1": "Advanced-control timer: 16-bit, 4 channels with complementary outputs and dead time (motor control, PWM), input capture.",
  "TIM2": "General-purpose timer: 16-bit, 4 channels for PWM, input capture and timing.",
  "I2C1": "The I2C controller (two-wire bus to sensors and displays), up to 400 kHz.",
  "SPI1": "The SPI controller: fast serial bus to displays, flash, radios.",
  "USART1": "The serial port (TX/RX), with optional hardware flow control; ch32fun's UART printf uses it.",
  "ADC1": "The 10-bit analog-to-digital converter: 8 external inputs (A0–A7) plus the internal reference.",
  "DBG": "Debug support: whether the watchdogs and timers keep running while the CPU is halted by the debugger.",
  "ESIG": "Electronic signature: the flash size and the chip's unique ID, set at the factory.",
  "FLASH": "The flash controller: wait states, and the unlock keys and commands for erasing and writing pages (what the programmer uses).",
  "PFIC": "Programmable Fast Interrupt Controller: which interrupts are enabled, pending and active, their priorities, and the system reset (CFGR).",
  "SysTick": "The core's 32-bit system timer. ch32fun starts it at boot counting HCLK (48 MHz by default); Delay_Ms and Delay_Us wait on it.",
};

export function loadSoc(): Promise<Db> {
  loading ??= fetch(dbUrl).then((r) => r.json() as Promise<RawDb>).then((raw) => (db = parseDb(raw, (title) => INTROS[title.split(" (")[0]] ?? "")));
  return loading;
}

export function peripheralAt(addr: number): Peripheral | undefined {
  let best: Peripheral | undefined;
  for (const p of db?.peripherals ?? []) {
    if (addr >= p.base && addr < p.base + Math.max(p.size, 0x400) && (!best || p.base > best.base)) best = p;
  }
  return best;
}

export function registerAt(addr: number): Register | undefined {
  return peripheralAt(addr)?.regs.find((r) => r.addr === (addr & ~3) >>> 0);
}

/** Registers whose reading changes the hardware's state. */
const READ_SIDE_EFFECTS: [RegExp, string][] = [
  [/^USART1_DATAR$/, "reading it takes the received byte (and clears RXNE): the program would never see that byte"],
  [/^SPI1_DATAR$/, "reading it takes the received data out of the SPI's buffer"],
  [/^I2C1_DATAR$/, "reading it takes the received byte and moves the I2C transfer on"],
  [/^I2C1_STAR2$/, "reading STAR1 then STAR2 clears the I2C's ADDR flag, which would disturb a transfer in progress"],
  [/^ADC1_RDATAR$/, "reading it clears the conversion-done flag (EOC)"],
];

export function readSideEffect(reg: Register): string | undefined {
  return READ_SIDE_EFFECTS.find(([re]) => re.test(reg.name))?.[1];
}

export function safeToRead(addr: number): boolean {
  const reg = registerAt(addr);
  return !reg || !readSideEffect(reg);
}

export function registerNotes(reg: Register): string[] {
  const n = reg.name;
  const notes: string[] = [];
  const effect = readSideEffect(reg);
  if (effect) notes.push(`Not read by the inspector: ${effect}.`);
  if (/^GPIO[ACD]_(BSHR|BCR)$/.test(n)) notes.push(`Write-only shortcuts: writing 1-bits sets (BS) or clears (BR) those bits of ${n.slice(0, 5)}_OUTDR without touching the others. Reading gives 0; look at OUTDR instead.`);
  if (/^GPIO[ACD]_INDR$/.test(n)) notes.push("The levels on the pins right now, sampled by the hardware, for every pin, whatever its mode.");
  if (/^GPIO[ACD]_OUTDR$/.test(n)) notes.push("What the program asks the pins to output: only pins configured as outputs (CFGLR MODE ≠ 0) drive it. For an input with pull resistor, the bit picks pull-up (1) or pull-down (0).");
  if (/^GPIO[ACD]_CFGLR$/.test(n)) notes.push("Each pin's mode: MODEn 0 = input (CNFn: 0 analog, 1 floating, 2 with pull-up/down); MODEn 1 = output 10 MHz, 2 = 2 MHz, 3 = 30 MHz (CNFn: 0 push-pull, 1 open-drain, 2 alternate-function push-pull, 3 alternate-function open-drain).");
  if (/^RCC_APB[12]PCENR$|^RCC_AHBPCENR$/.test(n)) notes.push("A peripheral whose clock bit is 0 here is off: its registers read as 0 and ignore writes.");
  if (/^STK_CNT$/.test(n)) notes.push("Counts while the CPU runs; with the CPU halted by the debugger it stands still (DBG_CR doesn't change that for SysTick on this core).");
  if (/^PFIC_/.test(n) && /(IPSR|ISR)/.test(n)) notes.push("Interrupt pending/active flags: the hardware sets them; the program clears pending ones through IPRR.");
  if (/^ESIG_/.test(n)) notes.push("Fixed at the factory: the same on every read.");
  return notes;
}

const bits = (v: number, lo: number, hi: number) => hi - lo >= 31 ? v >>> 0 : (v >>> lo) & ((1 << (hi - lo + 1)) - 1);
const MODES = ["input", "output, 10 MHz", "output, 2 MHz", "output, 30 MHz"];
const IN_CNF = ["analog", "floating", "with pull-up/down", "reserved"];
const OUT_CNF = ["push-pull", "open-drain", "alternate function, push-pull", "alternate function, open-drain"];
const CLOCKS = ["HSI (24 MHz internal)", "HSE (crystal)", "PLL (2 × source)", "?"];

/** HPRE: the AHB prescaler's codes (0–7: divide by n+1; 8–15: 2, 4, …, 256). */
export const hpreDivider = (v: number) => (v < 8 ? v + 1 : 2 << (v - 8));

/** HCLK (the CPU clock) from RCC_CFGR0, assuming an external clock of 24 MHz like the HSI. */
export function cpuHzFromCfgr0(cfgr0: number | undefined): number | undefined {
  if (cfgr0 === undefined) return undefined;
  const sws = bits(cfgr0, 2, 3);
  const src = sws === 2 ? 48e6 : 24e6;
  return src / hpreDivider(bits(cfgr0, 4, 7));
}

export function decodeRegister(reg: Register, value: number): DecodedField[] {
  const n = reg.name;
  const out: DecodedField[] = [];
  const cfg = /^GPIO[ACD]_CFGLR$/.test(n);
  for (const f of reg.fields) {
    const v = bits(value, f.lo, f.hi);
    let text = f.hi === f.lo ? (v ? "1 (on)" : "0 (off)") : `${v}${v > 9 ? ` (0x${v.toString(16)})` : ""}`;
    if (cfg && /^MODE\d$/.test(f.name)) text = `${v}: ${MODES[v]}`;
    else if (cfg && /^CNF\d$/.test(f.name)) {
      const mode = bits(value, f.lo - 2, f.lo - 1);
      text = `${v}: ${(mode ? OUT_CNF : IN_CNF)[v]}`;
    } else if (n === "RCC_CFGR0" && (f.name === "SW" || f.name === "SWS")) text = `${v}: ${CLOCKS[v]}`;
    else if (n === "RCC_CFGR0" && f.name === "HPRE") text = `${v}: HCLK = clock / ${hpreDivider(v)}`;
    else if (n === "STK_CTLR" && f.name === "STCLK") text = v ? "1: HCLK" : "0: HCLK / 8";
    out.push({ field: f, value: v, text });
  }
  if (n === "RCC_CFGR0") {
    const hz = cpuHzFromCfgr0(value);
    if (hz) out.push({ field: { name: "CPU clock", lo: 0, hi: 31, access: "", desc: "HCLK, from SWS and HPRE (a crystal counted as 24 MHz)" }, value: 0, text: `≈ ${hz / 1e6} MHz` });
  }
  return out;
}

export const ch32v003Soc: SocApi = {
  regions: REGIONS, regionAt, db: () => db, load: loadSoc, registerAt, peripheralAt, readSideEffect, safeToRead, registerNotes, decodeRegister,
};
