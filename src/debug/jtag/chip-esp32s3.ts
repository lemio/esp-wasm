/** The ESP32-S3 (Xtensa LX7, debugged over its built-in USB-JTAG), for the inspector. */
import type { ChipProfile, Insn, PinModel, PinRow } from "./chip";
import { GPIOS, cpuHz, esp32s3Soc, pinNote, signalPeripheral } from "./soc";
import { disassemble } from "./xtensa-disasm";

/** GPIO_OUT, GPIO_OUT1, GPIO_ENABLE, GPIO_ENABLE1, GPIO_IN, GPIO_IN1: every pin's level in six words. */
const PIN_LEVEL_REGS = [0x60004004, 0x60004010, 0x60004020, 0x6000402c, 0x6000403c, 0x60004040];
const SYSCLK_CONF = 0x600c0060; // SYSTEM_SYSCLK_CONF_REG: the CPU clock's source
const CPU_PER_CONF = 0x600c0010; // SYSTEM_CPU_PER_CONF_REG: 80/160/240 MHz
const DRIVE_LABEL = ["~5 mA", "~10 mA", "~20 mA", "~40 mA"];

const bit = (m: Map<number, number> | undefined, lo: number, hi: number, g: number) => {
  const v = m?.get(g < 32 ? lo : hi);
  return v === undefined ? undefined : (v >>> (g & 31)) & 1;
};

const pins: PinModel = {
  headers: [
    ["GPIO", "Click a number for the pin's own configuration registers (IO MUX)"],
    ["Direction", "Output: the chip drives the pin (GPIO_ENABLE). Input: its level is read (IO MUX FUN_IE). Driven by a peripheral: through the GPIO matrix (FUNCn_OUT_SEL) or straight from the IO MUX (MCU_SEL); click its name for its registers. Plus the internal pull resistor (IO MUX FUN_PU/FUN_PD, about 45 kΩ)"],
    ["History", "The level at each read of the pins (each stop, or every Live values update), oldest left. Hover a sample for when it was taken, in CPU clock cycles"],
    ["Level", "Driven: what GPIO_OUT asks for. Reads: GPIO_IN, the level actually on the pin"],
    ["Drive", "Output drive strength (IO MUX FUN_DRV)"], ["Note", ""],
  ],
  levelRegs: PIN_LEVEL_REGS,
  counter: "CCOUNT",
  allRegs(db) {
    const addrs = [...PIN_LEVEL_REGS, SYSCLK_CONF, CPU_PER_CONF];
    for (const g of GPIOS) {
      addrs.push(0x60004554 + 4 * g); // GPIO_FUNCg_OUT_SEL_CFG_REG
      const pad = db.iomux[String(g)];
      if (pad) addrs.push(0x60009000 + pad.off);
    }
    return addrs;
  },
  hz: (w) => cpuHz(w.get(SYSCLK_CONF), w.get(CPU_PER_CONF)),
  level(levels, pin) {
    const g = Number(pin);
    const hi = g < 32 ? 0 : 1, b = g & 31;
    const [out, en, inp] = [levels[hi], levels[2 + hi], levels[4 + hi]];
    if (en === undefined) return undefined;
    const v = (en >>> b) & 1 ? out : inp;
    return v === undefined ? undefined : (v >>> b) & 1;
  },
  rows(w, prev, db) {
    return GPIOS.map((g): PinRow => {
      const pad = db.iomux[String(g)];
      const mux = pad ? w.get(0x60009000 + pad.off) : undefined;
      const outSel = w.get(0x60004554 + 4 * g);
      const mcuSel = mux === undefined ? undefined : (mux >>> 12) & 7;
      const ie = mux !== undefined && (mux >>> 9) & 1;
      const pu = mux !== undefined && (mux >>> 8) & 1, pd = mux !== undefined && (mux >>> 7) & 1;
      const oe = bit(w, 0x60004020, 0x6000402c, g);
      const out = bit(w, 0x60004004, 0x60004010, g), inp = bit(w, 0x6000403c, 0x60004040, g);
      const inBefore = bit(prev, 0x6000403c, 0x60004040, g), outBefore = bit(prev, 0x60004004, 0x60004010, g);
      const func = mcuSel === undefined ? "?" : pad?.funcs[String(mcuSel)] ?? `function ${mcuSel}`;
      const viaMatrix = mcuSel === 1 || (mcuSel === 0 && /^GPIO\d+$/.test(func));
      const sig = outSel === undefined ? undefined : outSel & 0x1ff;
      let connected: string, connectedTitle: string;
      if (!viaMatrix) {
        connected = func;
        connectedTitle = `Connected straight to ${func} by the IO MUX (MCU_SEL = ${mcuSel}), bypassing the GPIO matrix.`;
      } else if (sig === 256 || sig === undefined) {
        connected = "GPIO";
        connectedTitle = "Plain GPIO, through the GPIO matrix (FUNCn_OUT_SEL = 256): if your code uses this pin, digitalWrite sets its GPIO_OUT bit and digitalRead reads its GPIO_IN bit.";
      } else {
        connected = db.signals.out[String(sig)] ?? `signal ${sig}`;
        connectedTitle = `A peripheral output (signal ${sig}, ${connected}) is routed to this pin through the GPIO matrix.`;
      }
      const pull = pu ? "pull-up" : pd ? "pull-down" : "";
      const peripheral = !viaMatrix ? func : connected !== "GPIO" ? connected : undefined;
      const dir = !viaMatrix ? "set by" : oe ? (peripheral ? "output from" : "output") : ie ? "input" : "off";
      let level = "";
      if (oe && viaMatrix && (sig === 256 || sig === undefined)) level = `driven ${out ? "high" : "low"}`;
      else if (oe) level = "driven by the peripheral";
      if (ie && inp !== undefined) level += `${level ? ", " : ""}reads ${inp ? "high" : "low"}`;
      const conflict = oe && ie && (sig === 256) && out !== undefined && inp !== undefined && out !== inp;
      return {
        id: String(g), idLink: { base: 0x60009000, filter: `GPIO${g}_`, title: `Show GPIO${g}'s pad register (IO MUX)` },
        dir, dirTitle: connectedTitle, peripheral, peripheralLink: peripheral ? signalPeripheral(peripheral) : undefined, pull,
        level: level || "—", dot: oe ? out : inp,
        warn: conflict ? `${level} — it should read ${out ? "high" : "low"}: shorted, or overloaded?` : undefined,
        changed: (inBefore !== undefined && inBefore !== inp) || (outBefore !== undefined && outBefore !== out),
        off: !oe && !ie && viaMatrix,
        drive: mux === undefined || !oe ? "" : DRIVE_LABEL[(mux >>> 10) & 3],
        note: pinNote(g),
      };
    });
  },
};

/**
 * Follow constants through straight-line code, to say which address a load or store touches
 * ("a8 + 0 = 0x60004010, GPIO_OUT1_REG"): L32R/MOVI/MOV/ADDI set a register to a known value,
 * anything else that writes it (or a branch target, or a call) forgets it. A small,
 * conservative version of what a compiler's constant propagation does.
 */
function constantAddresses(insns: Insn[], word: (addr: number) => number | undefined): Map<number, number> {
  const targets = new Set(insns.filter((i) => i.target !== undefined).map((i) => i.target!));
  const known = new Map<string, number>();
  const out = new Map<number, number>();
  const writesFirst = /^(l8ui|l16ui|l16si|l32i|l32i\.n|l32ai|movi|movi\.n|mov|mov\.n|add|add\.n|addi|addi\.n|addmi|addx\d|sub|subx\d|and|or|xor|extui|slli|srli|srai|sll|srl|sra|src|mull|muluh|mulsh|quou|quos|remu|rems|min|max|minu|maxu|neg|abs|sext|clamps|nsa|nsau|rsr|rsil|l32r|moveqz|movnez|movltz|movgez|salt|saltu|xsr)$/;
  for (const i of insns) {
    if (targets.has(i.addr)) known.clear();
    const ops = i.operands.split(", ");
    const k = (r: string) => known.get(r);
    // Loads and stores: base register + offset.
    if (/^(l|s)(8|16|32)(ui|si|i)(\.n)?$|^l32ai$|^s32ri$/.test(i.mnemonic) && ops.length === 3 && k(ops[1]) !== undefined) {
      out.set(i.addr, (k(ops[1])! + Number(ops[2])) >>> 0);
    }
    const dst = ops[0];
    if (i.mnemonic === "l32r" && i.literal !== undefined) {
      const v = word(i.literal);
      if (v === undefined) known.delete(dst); else known.set(dst, v);
    } else if (/^movi(\.n)?$/.test(i.mnemonic)) known.set(dst, Number(ops[1]) >>> 0);
    else if (/^mov(\.n)?$/.test(i.mnemonic)) {
      if (k(ops[1]) === undefined) known.delete(dst); else known.set(dst, k(ops[1])!);
    } else if (/^addi(\.n)?$|^addmi$/.test(i.mnemonic)) {
      if (k(ops[1]) === undefined) known.delete(dst); else known.set(dst, (k(ops[1])! + Number(ops[2])) >>> 0);
    } else if (writesFirst.test(i.mnemonic)) known.delete(dst);
    if (/^call/.test(i.mnemonic)) for (let r = 8; r < 16; r++) known.delete(`a${r}`); // the callee's registers overlap these
    if (/^(ret|retw|j$|jx)/.test(i.mnemonic)) known.clear();
  }
  return out;
}

export const esp32s3: ChipProfile = {
  id: "esp32s3",
  name: "ESP32-S3",
  arch: "xtensa",
  link: "JTAG",
  soc: esp32s3Soc,
  pins,
  regNames: Array.from({ length: 16 }, (_, i) => `a${i}`),
  sp: 1,
  roleShort: { pc: "next instruction", a0: "return address", a1: "stack pointer", a2: "1st argument / result", a3: "2nd argument", a4: "3rd argument", a5: "4th argument", a6: "5th argument", a7: "frame pointer" },
  roleLong: {
    pc: "where the CPU is: the next instruction to run",
    a0: "return address: where this function goes back to",
    a1: "stack pointer: this function's scratch memory",
    a2: "1st input of the function, and its result",
    a3: "2nd input", a4: "3rd input", a5: "4th input", a6: "5th input", a7: "6th input; in unoptimized code (Trace builds) the frame pointer: the stack pointer after the function set up its frame, which local variables are addressed from",
  },
  callBack: 3,
  maxBreakpoints: 2,
  defaultMemory: 0x3fc88000,
  ram: { lo: 0x3fc88000, hi: 0x3fd00000 },
  minAddress: 0x3c000000,
  places: [
    ["GPIO", 0x60004000, "Pin output/input/enable registers"], ["IO MUX", 0x60009000, "Per-pin configuration: function, pull-ups, drive strength"],
    ["UART0", 0x60000000, "Serial port 0"], ["Timer group 0", 0x6001f000, "Hardware timers and the task watchdog"],
    ["System timer", 0x60023000, "The 16 MHz clock behind millis()"], ["LEDC (PWM)", 0x60019000, "analogWrite's PWM channels"],
    ["RTC control", 0x60008000, "Power, sleep, reset reasons"], ["eFuse", 0x60007000, "Factory data: MAC address, chip revision"],
  ],
  disassemble,
  constantAddresses,
  operandRegs: (ops) => [...new Set(ops.match(/\ba(?:1[0-5]|[0-9])\b/g) ?? [])].map((name) => ({ name, index: Number(name.slice(1)) })),
  text: {
    connecting: "Pick the ESP32-S3 in the browser's list (it shows as “USB JTAG/serial debug unit”).",
    notConnected: "Plug the ESP32-S3 in by its native USB port (often marked “USB”, not “UART”), upload your sketch, then press Connect.",
    connectTitle: "Connect to the ESP32-S3 through its native USB port (WebUSB)",
    image: "app.bin",
    fileMapNote: "Each block is a segment of the file: hover for where it's loaded. Flash segments are read in place through the cache; RAM segments are copied to RAM by the bootloader at start-up.",
    unmapped: "This address isn't mapped to any memory or peripheral on the ESP32-S3: reading it would fail.",
    systemCode: "system code (Arduino, ESP-IDF or a library)",
    help: {},
    isa: "Xtensa assembly",
    endian: "the ESP32-S3 is little-endian, so the last byte is the most significant",
  },
};
