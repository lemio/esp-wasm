/** The CH32X035 (QingKe V4C, RV32IMAC) profile for the SWIO inspector. */
import type { ChipProfile, PinModel, PinRow } from "./chip";
import { ABI, constantAddresses, disassemble } from "./riscv-disasm";
import type { Db, Region, SocApi } from "./soc";

const FLASH_SIZE = 62 * 1024;
const FLASH_BASE = 0x08000000;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 20 * 1024;
const PORTS = { A: 0x40010800, B: 0x40010c00, C: 0x40011000 } as const;
type Port = keyof typeof PORTS;
const PORT_NAMES: Port[] = ["A", "B", "C"];
// Pins exposed by the Arduino core's CH32X035G8U variant. Smaller packages expose a subset.
const PIN_NUMBERS: Record<Port, number[]> = {
  A: [0, 1, 2, 3, 4, 5, 6, 7],
  B: [0, 1, 3, 4, 6, 7, 8, 9, 10, 11, 12],
  C: [0, 3, 14, 15, 16, 17, 18, 19],
};
const APB2PCENR = 0x40021018;
const GPIO_REGS = PORT_NAMES.flatMap((p) => [0, 4, 8, 12, 28].map((offset) => PORTS[p] + offset));
const SAFE_REGS = new Set([...GPIO_REGS, APB2PCENR]);
const bit = (v: number | undefined, n: number) => v === undefined ? undefined : (v >>> n) & 1;
const configAddress = (port: Port, n: number) => PORTS[port] + (n < 8 ? 0 : n < 16 ? 4 : 28);
const configMode = (cfg: number | undefined, n: number) => cfg === undefined ? undefined : (cfg >>> ((n % 8) * 4)) & 15;

const regions: Region[] = [
  {
    lo: 0, hi: FLASH_SIZE, kind: "flash", name: "Flash (where the CPU runs it)",
    alias: { delta: FLASH_BASE, name: "the flash's own address" },
    explain: "The 62 KB of program flash, mapped at address 0: the CPU starts at 0 after a reset and runs your program from here. The same bytes are at 0x0800_0000.",
  },
  {
    lo: FLASH_BASE, hi: FLASH_BASE + FLASH_SIZE, kind: "flash", name: "Flash (62 KB)",
    alias: { delta: -FLASH_BASE, name: "address 0, where the CPU runs it" },
    explain: "The program memory, written by the funprog programmer in 64-byte blocks. The CPU sees the same bytes at address 0.",
  },
  {
    lo: RAM_BASE, hi: RAM_BASE + RAM_SIZE, kind: "ram", name: "SRAM (20 KB)",
    explain: "The 20 KB of RAM: global and static variables, and the stack, which grows down from the end of RAM.",
  },
  {
    lo: 0x40000000, hi: 0x60000000, kind: "peripheral", name: "Peripheral registers",
    explain: "The CH32X035 peripheral register space. Register names and side effects are not mapped yet; avoid reading from hardware addresses unless you know they are safe.",
  },
  {
    lo: 0xe0000000, hi: 0xe0100000, kind: "peripheral", name: "Core peripherals",
    explain: "Registers built into the QingKe core, including the interrupt controller and SysTick.",
  },
];

const emptyDb: Db = { peripherals: [], iomux: {}, signals: { in: {}, out: {} } };
const regionAt = (addr: number) => regions.find((r) => addr >= r.lo && addr < r.hi);
const soc: SocApi = {
  regions,
  regionAt,
  db: () => emptyDb,
  load: async () => emptyDb,
  registerAt: () => undefined,
  peripheralAt: () => undefined,
  readSideEffect: () => undefined,
  safeToRead: (addr) => regionAt(addr)?.kind !== "peripheral" || SAFE_REGS.has(addr),
  registerNotes: () => [],
  decodeRegister: () => [],
};

const pins: PinModel = {
  headers: [
    ["Pin", "Pins from the Arduino CH32X035G8U variant; smaller packages expose only a subset."],
    ["Direction", "GPIO configuration; alternate-function routing is not decoded."],
    ["History", "The sampled pin levels, oldest first."],
    ["Level", "Output latch and input level."], ["Speed", "Output mode"], ["Note", ""],
  ],
  levelRegs: [...GPIO_REGS, APB2PCENR],
  counter: "SysTick CNT",
  allRegs: () => [...GPIO_REGS, APB2PCENR],
  hz: () => undefined,
  level(levels, pin) {
    const port = pin[1] as Port;
    const n = Number(pin.slice(2));
    const portIndex = PORT_NAMES.indexOf(port);
    if (portIndex < 0 || !PIN_NUMBERS[port].includes(n) || !bit(levels[GPIO_REGS.length], portIndex + 2)) return undefined;
    const index = portIndex * 5;
    const cfg = levels[index + (n < 8 ? 0 : n < 16 ? 1 : 4)];
    const mode = configMode(cfg, n);
    if (mode === undefined) return undefined;
    const output = (mode & 3) !== 0 && (mode >>> 2) < 2;
    return bit(levels[index + (output ? 3 : 2)], n);
  },
  rows(words, prev) {
    const clocks = words.get(APB2PCENR);
    return PORT_NAMES.flatMap((port, pi) => PIN_NUMBERS[port].map((n): PinRow => {
      const base = PORTS[port], id = `P${port}${n}`;
      const clock = bit(clocks, pi + 2);
      const mode = configMode(words.get(configAddress(port, n)), n);
      const input = bit(words.get(base + 8), n), output = bit(words.get(base + 12), n);
      const changed = (bit(prev?.get(base + 8), n) !== undefined && bit(prev?.get(base + 8), n) !== input)
        || (bit(prev?.get(base + 12), n) !== undefined && bit(prev?.get(base + 12), n) !== output);
      const common = { id, changed, note: "", off: clock === 0, drive: "" };
      if (clock === 0) return { ...common, dir: "off", dirTitle: `GPIO${port}'s clock is off.`, level: "—" };
      if (clock === undefined || mode === undefined) return { ...common, dir: "?", dirTitle: "Configuration or clock could not be read.", level: "—" };
      const speed = mode & 3, cnf = mode >>> 2;
      const reads = input === undefined ? "input not read" : `reads ${input ? "high" : "low"}`;
      if (!speed) {
        const kinds = ["analog input", "input (floating)", "input", "reserved"];
        return {
          ...common, dir: kinds[cnf], dirTitle: `GPIO configuration = 0x${mode.toString(16)}.`,
          pull: cnf === 2 && output !== undefined ? (output ? "pull-up" : "pull-down") : undefined,
          level: reads, dot: input,
        };
      }
      const alternate = cnf >= 2, openDrain = !!(cnf & 1);
      const driven = alternate ? "alternate function" : output === undefined ? "output not read"
        : openDrain ? (output ? "released" : "pulled low") : `driven ${output ? "high" : "low"}`;
      return {
        ...common, dir: alternate ? "alternate-function output" : openDrain ? "output (open-drain)" : "output",
        dirTitle: `GPIO configuration = 0x${mode.toString(16)}.${alternate ? " Peripheral routing is not decoded." : ""}`,
        level: `${driven}, ${reads}`, dot: alternate ? input : output,
        drive: `mode ${speed}`,
      };
    }));
  },
};

const roleShort: Record<string, string> = {
  pc: "next instruction", ra: "return address", sp: "stack pointer", gp: "global pointer", tp: "thread pointer",
  s0: "saved / frame pointer", s1: "saved", a0: "1st argument / result", a1: "2nd argument / result",
  a2: "3rd argument", a3: "4th argument", a4: "5th argument", a5: "6th argument", a6: "7th argument", a7: "8th argument",
  t0: "temporary", t1: "temporary", t2: "temporary", t3: "temporary", t4: "temporary", t5: "temporary", t6: "temporary",
  s2: "saved", s3: "saved", s4: "saved", s5: "saved", s6: "saved", s7: "saved", s8: "saved", s9: "saved", s10: "saved", s11: "saved",
};
const roleLong: Record<string, string> = {
  pc: "where the CPU is: the next instruction to run",
  zero: "always 0: writes to it are ignored",
  ra: "return address: where this function goes back to",
  sp: "stack pointer: the bottom of the stack, which grows down from the end of RAM",
  gp: "global pointer: set once at start-up to reach nearby global data",
  tp: "thread pointer: reserved for thread-local data",
  s0: "saved register; when used with frame pointers, it is the frame pointer",
  s1: "saved register: a function that uses it puts it back before returning",
  s2: "saved register: a function that uses it puts it back before returning",
  s3: "saved register: a function that uses it puts it back before returning",
  s4: "saved register: a function that uses it puts it back before returning",
  s5: "saved register: a function that uses it puts it back before returning",
  s6: "saved register: a function that uses it puts it back before returning",
  s7: "saved register: a function that uses it puts it back before returning",
  s8: "saved register: a function that uses it puts it back before returning",
  s9: "saved register: a function that uses it puts it back before returning",
  s10: "saved register: a function that uses it puts it back before returning",
  s11: "saved register: a function that uses it puts it back before returning",
  a0: "1st input of a function, and its result", a1: "2nd input (and the high half of a 64-bit result)",
  a2: "3rd input", a3: "4th input", a4: "5th input", a5: "6th input", a6: "7th input", a7: "8th input",
  t0: "temporary: any function may change it", t1: "temporary: any function may change it",
  t2: "temporary: any function may change it", t3: "temporary: any function may change it",
  t4: "temporary: any function may change it", t5: "temporary: any function may change it",
  t6: "temporary: any function may change it",
};

export const ch32x035: ChipProfile = {
  id: "ch32x035",
  name: "CH32X035",
  arch: "riscv",
  link: "SWIO",
  soc,
  pins,
  regNames: ABI,
  sp: 2,
  roleShort,
  roleLong,
  callBack: 2,
  maxBreakpoints: 64,
  defaultMemory: RAM_BASE,
  ram: { lo: RAM_BASE, hi: RAM_BASE + RAM_SIZE },
  minAddress: FLASH_BASE,
  places: [
    ["Core peripherals", 0xe000e000, "QingKe interrupt controller and SysTick"],
  ],
  disassemble,
  constantAddresses,
  operandRegs: (ops) => [...new Set(ops.match(/\b(zero|ra|sp|gp|tp|t[0-6]|s(?:[0-9]|10|11)|a[0-7])\b/g) ?? [])]
    .map((name) => ({ name, index: ABI.indexOf(name) })),
  text: {
    connecting: "Pick the funprog programmer in the browser's list.",
    notConnected: "Wire the funprog programmer to the CH32X035's DIO/DCK debug pins, 3V3 and GND, then press Connect. Flashing via funprog connects automatically.",
    connectTitle: "Connect to the CH32X035 through the funprog programmer (WebHID, SWIO)",
    image: "the program image",
    fileMapNote: "The file is a copy of the flash from its start: byte n of the file is flash address 0x0800_0000 + n, which the CPU also sees at address n.",
    unmapped: "This address isn't in the CH32X035's mapped flash, RAM, peripheral, or core-register regions.",
    systemCode: "system code (ch32fun, the Arduino core or a library)",
    isa: "RISC-V assembly (RV32IMAC)",
    endian: "the CH32X035 is little-endian, so the last byte is the most significant",
    help: {
      "Pins": "GPIO mode, input and output levels for pins in the Arduino CH32X035G8U variant. Smaller packages expose only a subset. Alternate-function routing is not decoded.",
      "Program": "The program as RISC-V machine code: its location in flash and the instructions of the current function, with source lines where available. Instructions are 2 or 4 bytes. Flash is at 0x0000… (also 0x0800…), RAM at 0x2000…, and peripheral registers at 0x4000… and 0xE000…. Addresses are typically built using lui and an immediate offset.",
      "Registers": "The CPU's 32 working registers (RV32IMAC) and program counter pc, by their usual names. Hover a value for what it could point to.",
      "Memory": "Read variables, stack and flash freely. Peripheral registers are not decoded yet; GPIO configuration and level registers are safe for pin sampling. Other hardware addresses require an explicit read.",
    },
  },
};
