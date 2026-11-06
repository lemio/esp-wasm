/** The CH32V003 (WCH QingKe V2A, RISC-V RV32EC, debugged over SWIO with a funprog programmer), for the inspector. */
import type { ChipProfile, PinModel, PinRow } from "./chip";
import { ABI, constantAddresses, disassemble } from "./riscv-disasm";
import { RAM_BASE, RAM_SIZE, ch32v003Soc, cpuHzFromCfgr0 } from "./soc-ch32v003";

const PORTS = { A: 0x40010800, C: 0x40011000, D: 0x40011400 } as const;
type Port = keyof typeof PORTS;
const PINS: [Port, number][] = [["A", 1], ["A", 2], ...[0, 1, 2, 3, 4, 5, 6, 7].map((n): [Port, number] => ["C", n]), ...[0, 1, 2, 3, 4, 5, 6, 7].map((n): [Port, number] => ["D", n])];
/** Per port: CFGLR (modes), INDR (levels read), OUTDR (levels driven). */
const LEVEL_REGS = (["A", "C", "D"] as Port[]).flatMap((p) => [PORTS[p], PORTS[p] + 8, PORTS[p] + 12]);
const RCC_CFGR0 = 0x40021004, APB2PCENR = 0x40021018, APB1PCENR = 0x4002101c, AFIO_PCFR1 = 0x40010004, STK_CTLR = 0xe000f000;
const PORT_CLOCK: Record<Port, number> = { A: 2, C: 4, D: 5 };
const SPEED = ["", "10 MHz", "2 MHz", "30 MHz"];
const ADC: Record<string, string> = { PA2: "A0", PA1: "A1", PC4: "A2", PD2: "A3", PD3: "A4", PD5: "A5", PD6: "A6", PD4: "A7" };

const bit = (v: number | undefined, n: number) => (v === undefined ? undefined : (v >>> n) & 1);

/** A peripheral's signals on the pins, for its current remapping (CH32V003 reference manual, chapter 7). */
interface Signal { name: string; pin: string; base: number; label: string; output: boolean }

function signals(pcfr1: number, apb1: number, apb2: number): Signal[] {
  const out: Signal[] = [];
  const add = (on: boolean, base: number, label: string, map: [string, string, boolean][]) => {
    if (on) for (const [name, pin, output] of map) out.push({ name, pin, base, label, output });
  };
  const usart = ((pcfr1 >>> 21) & 1) << 1 | ((pcfr1 >>> 2) & 1);
  add(!!bit(apb2, 14), 0x40013800, "USART1", [
    [["USART1_TX", "PD5", true], ["USART1_RX", "PD6", false], ["USART1_CK", "PD4", true]],
    [["USART1_TX", "PD0", true], ["USART1_RX", "PD1", false], ["USART1_CK", "PD7", true]],
    [["USART1_TX", "PD6", true], ["USART1_RX", "PD5", false], ["USART1_CK", "PD7", true]],
    [["USART1_TX", "PC0", true], ["USART1_RX", "PC1", false], ["USART1_CK", "PC5", true]],
  ][usart] as [string, string, boolean][]);
  const i2c = ((pcfr1 >>> 22) & 1) << 1 | ((pcfr1 >>> 1) & 1);
  add(!!bit(apb1, 21), 0x40005400, "I2C1", ([
    [["I2C1_SCL", "PC2", true], ["I2C1_SDA", "PC1", true]],
    [["I2C1_SCL", "PD1", true], ["I2C1_SDA", "PD0", true]],
    [["I2C1_SCL", "PC5", true], ["I2C1_SDA", "PC6", true]],
    [["I2C1_SCL", "PC5", true], ["I2C1_SDA", "PC6", true]],
  ] as [string, string, boolean][][])[i2c]);
  add(!!bit(apb2, 12), 0x40013000, "SPI1", [
    [(pcfr1 & 1) ? "PC0" : "PC1", "NSS", true], ["PC5", "SCK", true], ["PC6", "MOSI", true], ["PC7", "MISO", false],
  ].map(([pin, n, o]) => [`SPI1_${n}`, pin as string, o as boolean]));
  if (!((pcfr1 >>> 6) & 3) && !((pcfr1 >>> 23) & 1)) {
    add(!!bit(apb2, 11), 0x40012c00, "TIM1", [
      ["TIM1_CH1", "PD2", true], ["TIM1_CH2", "PA1", true], ["TIM1_CH3", "PC3", true], ["TIM1_CH4", "PC4", true],
      ["TIM1_CH1N", "PD0", true], ["TIM1_CH2N", "PA2", true], ["TIM1_CH3N", "PD1", true],
    ]);
  }
  // TIM2's four mappings (AFIO_PCFR1 TIM2_RM: none, partial 1, partial 2, full).
  add(!!bit(apb1, 0), 0x40000000, "TIM2", ([
    ["PD4", "PD3", "PC0", "PD7"], ["PC5", "PC2", "PD2", "PC1"], ["PC1", "PD3", "PC0", "PD7"], ["PC1", "PC7", "PD6", "PD5"],
  ][(pcfr1 >>> 8) & 3]).map((pin, i): [string, string, boolean] => [`TIM2_CH${i + 1}`, pin, true]));
  return out;
}

/** What's special about a pin: a few words, and the whole story for the tooltip. */
function pinNote(pin: string): [string, string] {
  const notes: [string, string][] = [];
  if (pin === "PD1") notes.push(["SWIO", "SWIO: the programmer's debug wire. Using it as GPIO cuts the inspector off"]);
  if (pin === "PD7") notes.push(["NRST?", "NRST: the reset pin, if the option bytes enable it"]);
  if (pin === "PA1" || pin === "PA2") notes.push([pin === "PA1" ? "OSCI" : "OSCO", `${pin === "PA1" ? "OSCI" : "OSCO"}: a crystal's pin, when one is used`]);
  if (pin === "PD5" || pin === "PD6") notes.push([`UART ${pin === "PD5" ? "TX" : "RX"}`, `USART1 ${pin === "PD5" ? "TX" : "RX"} by default (ch32fun's UART printf)`]);
  if (ADC[pin]) notes.push([ADC[pin], `analog input ${ADC[pin]} (ADC channel ${ADC[pin].slice(1)})`]);
  return [notes.map((n) => n[0]).join(" · "), notes.map((n) => n[1]).join("\n")];
}

const pins: PinModel = {
  headers: [
    ["Pin", "Click a pin for its port's registers (CFGLR: modes, INDR: levels read, OUTDR: levels driven)"],
    ["Direction", "From the port's CFGLR (4 bits per pin): input (analog, floating, or with a pull resistor of about 40 kΩ; OUTDR's bit picks up or down), or output (push-pull, open-drain), driven by your code or by a peripheral (an alternate function: which one depends on AFIO_PCFR1's remap bits and which peripherals are switched on in RCC)"],
    ["History", "The level at each read of the pins (each stop, or every Live values update), oldest left. Hover a sample for when it was taken, in SysTick counts"],
    ["Level", "Driven: what OUTDR asks for. Reads: INDR, the level actually on the pin"],
    ["Speed", "An output's maximum switching speed (CFGLR MODE): faster edges, more noise"], ["Note", ""],
  ],
  levelRegs: LEVEL_REGS,
  counter: "SysTick CNT",
  allRegs: () => [...LEVEL_REGS, RCC_CFGR0, APB2PCENR, APB1PCENR, AFIO_PCFR1, STK_CTLR],
  hz(w) {
    const hclk = cpuHzFromCfgr0(w.get(RCC_CFGR0));
    const ctlr = w.get(STK_CTLR);
    return hclk && ctlr !== undefined ? hclk / ((ctlr >>> 2) & 1 ? 1 : 8) : hclk;
  },
  level(levels, pin) {
    const p = (["A", "C", "D"] as Port[]).indexOf(pin[1] as Port), n = Number(pin[2]);
    const [cfg, ind, outd] = [levels[p * 3], levels[p * 3 + 1], levels[p * 3 + 2]];
    if (cfg === undefined) return undefined;
    return bit((cfg >>> (n * 4)) & 3 ? outd : ind, n);
  },
  rows(w, prev) {
    const apb2 = w.get(APB2PCENR) ?? 0, apb1 = w.get(APB1PCENR) ?? 0;
    const sigs = signals(w.get(AFIO_PCFR1) ?? 0, apb1, apb2);
    return PINS.map(([port, n]): PinRow => {
      const id = `P${port}${n}`;
      const base = PORTS[port];
      const idLink = { base, filter: "", title: `Show port ${port}'s registers (GPIO${port})` };
      const cfg = w.get(base), inp = bit(w.get(base + 8), n), out = bit(w.get(base + 12), n);
      const inBefore = bit(prev?.get(base + 8), n), outBefore = bit(prev?.get(base + 12), n);
      const changed = (inBefore !== undefined && inBefore !== inp) || (outBefore !== undefined && outBefore !== out);
      const [note, noteTitle] = pinNote(id);
      if (!bit(apb2, PORT_CLOCK[port])) {
        return { id, idLink, dir: "off", dirTitle: `Port ${port}'s clock is off (RCC_APB2PCENR IOP${port}EN = 0): the port does nothing, and its registers read as 0.`, level: "—", changed: false, off: true, drive: "", note, noteTitle };
      }
      if (cfg === undefined) return { id, idLink, dir: "?", dirTitle: "Not read", level: "—", changed, off: false, drive: "", note, noteTitle };
      const mode = (cfg >>> (n * 4)) & 3, cnf = (cfg >>> (n * 4 + 2)) & 3;
      const reads = inp === undefined ? "" : `reads ${inp ? "high" : "low"}`;
      if (!mode) {
        const users = sigs.filter((s) => s.pin === id && !s.output);
        const pull = cnf === 2 ? (out ? "pull-up" : "pull-down") : undefined;
        const kind = cnf === 0 ? "analog input" : "input";
        const peripheral = cnf === 0 && ADC[id] && bit(apb2, 9) ? `ADC ${ADC[id]}` : users.map((s) => s.name).join(" or ") || undefined;
        const link = cnf === 0 && peripheral ? { base: 0x40012400, filter: "", label: "ADC1" } : users[0] ? { base: users[0].base, filter: "", label: users[0].label } : undefined;
        return {
          id, idLink, dir: peripheral ? `${kind} for` : kind, peripheral, peripheralLink: link, pull,
          dirTitle: `CFGLR MODE${n} = 0 (input), CNF${n} = ${cnf}: ${["analog (the digital input is off; for the ADC)", "floating (no pull resistor)", `with a pull resistor; OUTDR bit ${n} = ${out} picks ${out ? "up" : "down"}`, "reserved"][cnf]}.`,
          level: cnf === 0 ? "analog (digital input off)" : reads || "—", dot: cnf === 0 ? undefined : inp, changed, off: false, drive: "", note, noteTitle,
        };
      }
      const af = cnf >= 2, openDrain = cnf & 1;
      const users = sigs.filter((s) => s.pin === id && s.output);
      const peripheral = af ? users.map((s) => s.name).join(" or ") || "a peripheral, but none is routed here (by AFIO_PCFR1's remapping, of the peripherals switched on)" : undefined;
      const driven = af ? "driven by the peripheral" : openDrain ? (out ? "released (open-drain: high only with a pull-up)" : "pulled low") : `driven ${out ? "high" : "low"}`;
      const level = `${driven}${reads ? `, ${reads}` : ""}`;
      const conflict = !af && !openDrain && out !== undefined && inp !== undefined && out !== inp;
      return {
        id, idLink, dir: af ? "output from" : openDrain ? "output (open-drain)" : "output",
        dirTitle: `CFGLR MODE${n} = ${mode} (output, ${SPEED[mode]}), CNF${n} = ${cnf}: ${["push-pull: your code drives it high and low (funDigitalWrite sets OUTDR)", "open-drain: your code pulls it low or lets go", "alternate function, push-pull: a peripheral drives it", "alternate function, open-drain: a peripheral pulls it low (I2C)"][cnf]}.`,
        peripheral, peripheralLink: users[0] ? { base: users[0].base, filter: "", label: users[0].label } : undefined,
        level, dot: af ? inp : out, warn: conflict ? `${level} — it should read ${out ? "high" : "low"}: shorted, or overloaded?` : undefined,
        changed, off: false, drive: SPEED[mode], note, noteTitle,
      };
    });
  },
};

const REG_NAMES = ABI.slice(0, 16);

export const ch32v003: ChipProfile = {
  id: "ch32v003",
  name: "CH32V003",
  arch: "riscv",
  link: "SWIO",
  soc: ch32v003Soc,
  pins,
  regNames: REG_NAMES,
  sp: 2,
  roleShort: {
    pc: "next instruction", ra: "return address", sp: "stack pointer", gp: "global pointer", tp: "thread pointer",
    s0: "saved / frame pointer", s1: "saved", a0: "1st argument / result", a1: "2nd argument / result", a2: "3rd argument", a3: "4th argument", a4: "5th argument", a5: "6th argument",
  },
  roleLong: {
    pc: "where the CPU is: the next instruction to run",
    zero: "always 0: writes to it are ignored",
    ra: "return address: where this function goes back to (a function that calls others saves it on the stack first)",
    sp: "stack pointer: the bottom of the stack, which grows down from the end of RAM; this function's locals are just above it",
    gp: "global pointer: set once at start-up to the middle of the small globals, so they can be reached in one instruction (gp ± 2 KB)",
    tp: "thread pointer: unused on this chip",
    t0: "temporary: any function may change it", t1: "temporary: any function may change it", t2: "temporary: any function may change it",
    s0: "saved register: a function that uses it puts it back before returning; with frame pointers on, the frame pointer",
    s1: "saved register: a function that uses it puts it back before returning",
    a0: "1st input of a function, and its result", a1: "2nd input (and the high half of a 64-bit result)", a2: "3rd input", a3: "4th input", a4: "5th input", a5: "6th input",
  },
  callBack: 2,
  maxBreakpoints: 64,
  defaultMemory: RAM_BASE,
  ram: { lo: RAM_BASE, hi: RAM_BASE + RAM_SIZE },
  minAddress: 0x08000000,
  places: [
    ["GPIOC", 0x40011000, "Port C: PC0–PC7"], ["GPIOD", 0x40011400, "Port D: PD0–PD7"], ["GPIOA", 0x40010800, "Port A: PA1, PA2"],
    ["RCC", 0x40021000, "Clocks and peripheral enables"], ["SysTick", 0xe000f000, "The timer behind Delay_Ms"],
    ["USART1", 0x40013800, "The serial port"], ["TIM1", 0x40012c00, "Advanced timer (PWM)"], ["TIM2", 0x40000000, "General-purpose timer"],
    ["ADC1", 0x40012400, "Analog inputs"], ["PFIC", 0xe000e000, "The interrupt controller"],
  ],
  disassemble,
  constantAddresses,
  operandRegs: (ops) => [...new Set(ops.match(/\b(zero|ra|sp|gp|tp|t[0-2]|s[01]|a[0-5])\b/g) ?? [])].map((name) => ({ name, index: REG_NAMES.indexOf(name) })),
  text: {
    connecting: "Pick the funprog programmer in the browser's list (the ESP32-S3 running funprog › CH32V003_Programmer).",
    notConnected: "Wire the programmer to the CH32V003 (SWIO → PD1, 3V3, GND), flash your program “via funprog programmer (SWIO)”, then press Connect. Flashing that way connects by itself.",
    connectTitle: "Connect to the CH32V003 through the funprog programmer (WebHID, SWIO)",
    image: "the program image",
    fileMapNote: "The file is a copy of the flash from its start: byte n of the file is flash address 0x0800_0000 + n, which the CPU runs at address n.",
    unmapped: "This address isn't mapped to any memory or peripheral on the CH32V003: reading it would fail.",
    systemCode: "system code (ch32fun or the C library)",
    isa: "RISC-V assembly (RV32EC)",
    endian: "the CH32V003 is little-endian, so the last byte is the most significant",
    help: {
      "Pins": "Every pin: whether it's an input (with its pull resistor) or an output, driven by your code (funDigitalWrite) or by a peripheral (USART, SPI, I2C, a timer; click it for its registers), and its level. History: one bar per read of the pins (each stop, or each Live values update while this tab is open); hover a bar for when it was taken, in SysTick counts.",
      "Program": "The program as machine code: where it sits in the image written to flash, and the CPU instructions of the function the CPU is in, each explained, with your source lines in between. Hover an instruction to see its line in the editor; click a call or jump to follow it. Most instructions are 2 bytes (the compressed set) or 4. Everything shares one 32-bit address space: 0x0000… is code in flash, 0x2000… is RAM, 0x4000… and 0xE000… are hardware registers (the Memory tab). A 32-bit address doesn't fit in one instruction, so the compiler builds it in two: lui sets the top 20 bits, and addi or the load/store's offset adds the rest.",
      "Registers": "The CPU's 16 working registers (RV32E) and the program counter pc (the instruction it runs next), by their usual names: ra holds the return address, sp the stack pointer, a0–a5 a function's inputs and result, t0–t2 temporaries, s0–s1 values kept across calls. Hover a value for what it could point to.",
      "Memory": "Any address on the chip. Memory is shown as 32-bit words with what each could mean; the peripherals (0x4000_0000 and up, and the core's at 0xE000_0000) are shown as named registers, decoded into their fields.",
      "Call stack": "Which function is running and which functions called it, newest first (found from each function's start, where it makes room on the stack and saves ra). Below: the raw stack memory, where functions keep their saved registers and locals.",
    },
  },
};
