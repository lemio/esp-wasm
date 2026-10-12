/**
 * The hardware inspector: a DevTools-style panel under the editor, driven over
 * USB-JTAG, that also draws into the Monaco editor itself — the running line and
 * the lines just run, values next to the code that uses them (with what they were
 * before), and values on hover.
 *
 * Every stop is recorded (registers, the top of the stack, watched values), so the
 * panel can compare a stop with the one before it and the user can scrub back through
 * the recording. Auto-step keeps stepping on its own at a chosen speed, recording
 * every line or every instruction as it goes.
 */
import * as monaco from "monaco-editor";
import {
  type DataSymbol, type LineTable, type SourceLocation,
  dataSymbols, functionAt, locateExact,
} from "../line-table";
import type { VarInfo } from "../dwarf-info";
import { formatTyped, strip, typeName, typeSize } from "./format";
import { pointeeLength, summarize, type Summary } from "./library-views";
import type { TypeInfo } from "../dwarf-info";
import { type Program, codeAt, fileOffsetOf, funcAt, loadProgram, wordAt } from "./program";
import { type Insn, disassemble } from "./xtensa-disasm";
import { morphChildren } from "./morph";

type StructType = Extract<TypeInfo, { k: "struct" }>;
type Member = StructType["members"][number];
import {
  type Peripheral, GPIOS, accessMeaning, cpuHz, decodeRegister, loadSoc, peripheralAt, pinNote, readSideEffect,
  REGIONS, regionAt, registerAt, registerNotes, safeToRead, signalPeripheral, soc,
} from "./soc";
import type { DebugTarget, Registers, StopCause } from "./target";

type Format = "dec" | "hex" | "float";

interface Watch {
  /** Identity: "g:<address>" for globals, "l:<function>:<name>:<scope>" for locals. */
  key: string;
  sym: DataSymbol;
  /** DWARF type, for readable structs and arrays. */
  type?: number;
  /** Set for locals and parameters; sym.addr is recomputed from the stack frame at every read. */
  local?: VarInfo;
  /** For a static local or a class member: what it belongs to ("loop"). */
  scope?: string;
  /** A local that isn't in a live stack frame right now (the last value stays shown, dimmed). */
  stale?: boolean;
  /** Why the last read failed (a bad address, say); the other watches are still read. */
  error?: string;
  /** For an object: what its pointer members point to, read at the last stop (by member name). */
  follow?: Map<string, Uint8Array>;
  format: Format;
  /** Last values, oldest first (at most HISTORY), from stops and live reads. */
  history: number[];
  bytes?: Uint8Array;
  /** The value before the latest read. */
  prev?: Uint8Array;
  changed: boolean;
  auto: boolean;
}

/** A stack frame: where it is executing and its frame base (CFA), when its function has debug info. */
interface Frame {
  /** Where it is: the PC for the innermost frame, the return address for callers. */
  pc: number;
  /** Address to look up in the line table (a return address minus one for callers). */
  at: number;
  /** The frame's stack pointer. */
  sp: number;
  cfa?: number;
}

/** Everything read at one stop, kept so stops can be compared and revisited. */
interface CpuState {
  /** Step number, counting from the connection. */
  n: number;
  at: number;
  core: number;
  /** Why it stopped, in plain words. */
  reason: string;
  cause?: StopCause;
  pc: number;
  where?: SourceLocation;
  ar: number[];
  stack?: { base: number; words: number[] };
  /** The call chain from the unwinder, innermost first: the PC, then each return address. */
  calls?: number[];
  /** Watched values by watch key. */
  values: Map<string, Uint8Array>;
  /** It came from a step out of the stop before (so that stop's line is the one that just ran). */
  stepped?: boolean;
}

interface TimelineEntry {
  at: number;
  text: string;
  loc?: SourceLocation;
  /** A recorded stop: clicking it goes back to that moment. */
  state?: CpuState;
}

export interface InspectorHost {
  editor: monaco.editor.IStandaloneCodeEditor;
  /** The project's sources, by compiled path ("/src/sketch.ino"). */
  sources(): { file: string; model: monaco.editor.ITextModel }[];
  /** Show this file in the editor. */
  showFile(file: string): void;
  /** Start addresses of the breakpoints set in the gutter. */
  breakpoints(table: LineTable): number[];
  log(text: string, level?: "error" | "ok" | "muted"): void;
  /** JTAG connected or gone: the software tracer steps aside while it's connected. */
  connectionChanged?(connected: boolean): void;
  /** The inspector restarted the chip: its USB serial side starts over, so reopen the monitor. */
  chipRestarted?(): void;
}

const HISTORY = 40;
/** Live mode: longest intended pause, shortest gap between pauses, and gap as a multiple of the last pause. */
const LIVE_BUDGET_MS = 100;
const LIVE_MIN_GAP_MS = 1000;
const LIVE_DUTY = 20;
const MAX_AUTO = 16;
const MAX_FRAMES = 8;
const MAX_TYPED_BYTES = 128;
const STACK_WORDS = 32;
const MAX_STEPS = 4000;
/** Recorded stops kept for comparing and scrubbing back. */
const MAX_STATES = 2000;
/** Give up on a source-line step that's still going after this long, and stop where it is. */
const STEP_TIME_LIMIT_MS = 15000;
/** Consecutive failed polls before the stop-watcher gives up and says so. */
const POLL_FAILURES = 5;
/** Editor lines run just before the current one, faded by age. */
const TRAIL = 4;
const TABS = ["Variables", "Call stack", "Pins", "Program", "Registers", "Memory", "History"] as const;
const DRIVE_LABEL = ["~5 mA", "~10 mA", "~20 mA", "~40 mA"];

/** What the inspector remembers between visits (localStorage), so a reload doesn't lose the place. */
const PREFS_KEY = "esp-wasm:inspector";
interface Prefs {
  open?: boolean;
  dock?: string;
  h?: string;
  w?: string;
  tab?: Tab;
  live?: boolean;
  log?: boolean;
  autoMode?: string;
  autoSpeed?: string;
  connected?: boolean;
}
/** Search results shown at once in the Memory tab. */
const SEARCH_SHOWN = 30;

/** A suggestion or search result of the Memory tab. */
interface MemoryPlace {
  label: string;
  kind: string;
  detail: string;
  addr?: number;
  go: () => void;
}
/** GPIO_OUT, GPIO_OUT1, GPIO_ENABLE, GPIO_ENABLE1, GPIO_IN, GPIO_IN1: every pin's level in six words. */
const PIN_LEVEL_REGS = [0x60004004, 0x60004010, 0x60004020, 0x6000402c, 0x6000403c, 0x60004040];
const SYSCLK_CONF = 0x600c0060; // SYSTEM_SYSCLK_CONF_REG: the CPU clock's source
const CPU_PER_CONF = 0x600c0010; // SYSTEM_CPU_PER_CONF_REG: 80/160/240 MHz
/** Pin samples kept for the history sparklines. */
const PIN_HISTORY = 60;

/** One read of the pins, for their history. */
interface PinSample {
  at: number;
  /** The CPU's cycle counter (CCOUNT) when it was taken. */
  cycles?: number;
  /** The CPU clock then, to turn cycles into time. */
  hz?: number;
  /** The PIN_LEVEL_REGS values. */
  levels: (number | undefined)[];
  /** The recorded stop it was taken at (state.n); none for Live values samples. */
  state?: number;
}
type Tab = (typeof TABS)[number];

const TAB_HELP: Record<Tab, string> = {
  "Variables": "The values your program is working with. “Before” is the value at the previous stop, so you can see what the last step changed.",
  "Call stack": "Which function is running and which functions called it, newest first. Below: the raw stack memory, where functions keep their local values.",
  "Pins": "Every GPIO pin: what drives it (your code through digitalWrite, or a peripheral like the RMT or a UART; click it for that peripheral's registers), whether it's an output or an input with its pull resistor, and its level. History: one bar per read of the pins (each stop, or each Live values update while this tab is open); hover a bar for when it was taken in CPU clock cycles. That counter (CCOUNT, 32 bits) stands still while the CPU is paused, so it measures the program's own running time; it wraps every 2³² cycles (about 27 s at 160 MHz).",
  "Program": "The program as machine code: where it sits in app.bin (the file written to flash) and the CPU instructions of the function the CPU is in, each explained, with your source lines in between. Hover an instruction to see its line in the editor; click a call or jump to follow it. Everything shares one 32-bit address space: 0x42… is code in flash, 0x3FC8… is RAM, 0x6000… are hardware registers (the Memory tab). An instruction is only 2–3 bytes, too short to hold a 32-bit address, so the compiler stores the addresses a function needs (of other functions, variables, hardware registers) as constants in a “literal pool” in flash just before the function, and loads them with l32r.",
  "Registers": "The CPU's 16 working registers a0–a15 and the program counter pc (the instruction it runs next). The ESP32-S3's Xtensa CPU has 64 physical registers; a0–a15 is a sliding window on them that moves with every function call, so each function gets fresh ones. By convention a0 holds the return address and a1 the stack pointer. Hover a value for what it could point to.",
  "Memory": "Any address on the chip. Memory is shown as 32-bit words with what each could mean; the peripheral area (0x6000_0000 and up) is shown as named registers, decoded into their fields.",
  "History": "Every stop and every change, newest first. Click a stop to look back at that moment.",
};

const CAUSES: Record<StopCause, string> = {
  breakpoint: "it reached your breakpoint",
  watchpoint: "a watched memory location changed",
  step: "it finished the step",
  pause: "you pressed Pause",
  crash: "the program crashed",
  unknown: "it stopped",
};

/** ESP-IDF's panic reasons ("Core 1 panic'ed (StoreProhibited)"), in plain words. */
const PANICS: [RegExp, string][] = [
  [/StoreProhibited/, "it tried to write to memory that doesn't exist; usually a pointer that is NULL or was never set"],
  [/LoadProhibited/, "it tried to read memory that doesn't exist; usually a pointer that is NULL or was never set"],
  [/InstrFetchProhibited/, "it jumped to an address with no code; usually a function pointer that was never set"],
  [/IllegalInstruction/, "it ran something that isn't a valid instruction; often a corrupted stack (a local array written past its end)"],
  [/IntegerDivideByZero/, "it divided a whole number by zero"],
  [/LoadStoreAlignment/, "it read or wrote a number at an address that isn't a multiple of its size"],
  [/Interrupt wdt timeout/i, "an interrupt handler (or a section with interrupts off) ran too long"],
  [/Task watchdog|task_wdt/i, "a task didn't give the CPU back in time; a loop without delay() or yield() can do that"],
  [/Stack (canary|protection fault|overflow)/i, "a task ran out of stack memory; large local arrays are a common cause"],
  [/abort\(\)|assert/i, "the program stopped itself (abort or a failed assert)"],
];

/** A word or two next to each register's name. */
const ROLE_SHORT: Record<string, string> = { pc: "next instruction", a0: "return address", a1: "stack pointer", a2: "1st argument / result", a3: "2nd argument", a4: "3rd argument", a5: "4th argument", a6: "5th argument", a7: "frame pointer" };

const REGISTER_ROLES: Record<string, string> = {
  pc: "where the CPU is: the next instruction to run",
  a0: "return address: where this function goes back to",
  a1: "stack pointer: this function's scratch memory",
  a2: "1st input of the function, and its result",
  a3: "2nd input", a4: "3rd input", a5: "4th input", a6: "5th input", a7: "6th input; in unoptimized code (Trace builds) the frame pointer: the stack pointer after the function set up its frame, which local variables are addressed from",
};

const hex = (n: number, width = 8) => (n >>> 0).toString(16).padStart(width, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shortFile = (f: string) => f.replace("/src/", "");
/** "loop::hue" → hue: the name the code uses. */
const shortName = (n: string) => (n.includes("::") ? n.slice(n.lastIndexOf("::") + 2) : n);
const sameBytes = (a?: Uint8Array, b?: Uint8Array) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A toolbar button's icon and text. Docked to the side of the editor, where the panel is narrow,
 * only the icon shows (CSS hides .lbl); the button's title says what it does.
 */
function setLabel(b: HTMLElement, icon: string, text: string): void {
  if (b.dataset.label === `${icon}${text}`) return;
  b.dataset.label = `${icon}${text}`;
  const ic = document.createElement("span");
  ic.className = "ic";
  ic.textContent = icon;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = ` ${text}`;
  b.replaceChildren(ic, lbl);
  b.setAttribute("aria-label", text);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Little-endian bytes as a number (up to 6 bytes stay exact). */
function toNumber(bytes: Uint8Array, signed: boolean): number {
  let v = 0;
  for (let i = Math.min(bytes.length, 6) - 1; i >= 0; i--) v = v * 256 + bytes[i];
  const size = Math.min(bytes.length, 6);
  return signed && size && v >= 2 ** (size * 8 - 1) ? v - 2 ** (size * 8) : v;
}

function formatBytes(b: Uint8Array, format: Format): string {
  if (b.length > 8) return [...b.subarray(0, 16)].map((x) => hex(x, 2)).join(" ") + (b.length > 16 ? " …" : "");
  if (format === "hex") return "0x" + [...b].reverse().map((x) => hex(x, 2)).join("");
  if (format === "float" && (b.length === 4 || b.length === 8)) return String(Number(asFloat(b).toPrecision(7)));
  return String(toNumber(b, true));
}

const asFloat = (b: Uint8Array) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return b.length === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
};

/** "+3", "−0.5": how a number moved, for values that are plain numbers. */
function delta(before: Uint8Array, now: Uint8Array, format: Format): string {
  if (now.length > 8 || before.length !== now.length) return "changed";
  const f = format === "float" && (now.length === 4 || now.length === 8);
  const d = f ? asFloat(now) - asFloat(before) : toNumber(now, true) - toNumber(before, true);
  if (!Number.isFinite(d)) return "changed";
  const text = String(Number(Math.abs(d).toPrecision(6)));
  return d > 0 ? `+${text}` : d < 0 ? `−${text}` : "same";
}

export class JtagInspector {
  private target?: DebugTarget;
  private table?: LineTable;
  private symbols: DataSymbol[] = [];
  private watches: Watch[] = [];
  private halted = false;
  private regs?: Registers;
  private frames?: Frame[];
  private spans = new Map<number, { file: string; first: number; last: number } | undefined>();
  private dismissed = new Set<string>();
  private globalTypes = new Map<number, number>();
  private frameSizes = new Map<number, number>();
  private stack?: { base: number; words: number[]; prev?: number[] };
  private memory = {
    addr: 0x3fc88000, length: 128, bytes: undefined as Uint8Array | undefined, prev: undefined as Uint8Array | undefined,
    /** For a peripheral: its registers' values by address. */
    words: undefined as Map<number, number> | undefined, prevWords: undefined as Map<number, number> | undefined,
    filter: "",
    /** What's typed in the search box ("" when it shows the current address). */
    query: "",
    /** The tab a link brought the user here from, for a way back. */
    from: undefined as Tab | undefined,
  };
  private timeline: TimelineEntry[] = [];
  private where?: SourceLocation;
  private tab: Tab = "Variables";
  private queue: Promise<unknown> = Promise.resolve();
  private polling = false;
  /** How long the last live-values pause froze the program (ms), for checking it stays short. */
  lastLivePause = 0;
  private stepping = false;
  /** The tab's help text unfolded (when the panel is narrow). */
  private helpOpen = false;
  /** What's typed in the Variables tab's search, and in the Program view's. */
  private varQuery = "";
  private programQuery = "";
  /** Objects whose members are shown (watch keys). */
  private readonly expanded = new Set<string>();
  private cancelStep = false;
  private autoRunning = false;
  private connecting = false;
  /** The last error, shown in the status banner until the next change of state. */
  private error = "";
  /** The recording: one entry per stop, oldest first. */
  private states: CpuState[] = [];
  private stepCount = 0;
  /** Index into `states` while looking back; undefined shows the latest. */
  private viewIndex?: number;
  private execDecorations?: { model: monaco.editor.ITextModel; ids: string[] };
  private readonly inlineDecorations = new Map<monaco.editor.ITextModel, string[]>();

  private readonly story = el("div", "jt-story");
  private readonly scrubber = el("div", "jt-scrub");
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private readonly body = el("div", "jt-body");
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly live = el("input");
  private readonly verbose = el("input");
  private readonly autoMode = el("select", "jt-select");
  private readonly autoSpeed = el("select", "jt-select");

  constructor(private readonly root: HTMLElement, private readonly host: InspectorHost, private readonly createTarget: () => DebugTarget) {
    root.classList.add("jtag-panel");
    const bar = el("div", "jt-bar");
    const add = (id: string, label: [string, string], title: string, action: () => Promise<void>, cls = "dbg") => {
      const b = el("button", cls);
      setLabel(b, ...label);
      b.title = title;
      b.onclick = () => void action().catch((e) => this.fail(e));
      this.buttons[id] = b;
      bar.append(b);
      return b;
    };
    add("connect", ["⏻", "Connect"], "Connect to the ESP32-S3 through its native USB port (WebUSB)", () => this.toggleConnection());
    add("pause", ["⏸", "Pause"], "Freeze the program to look inside it, or let it run on", async () => {
      if (this.autoRunning || this.stepping) this.stopStepping();
      else if (this.halted && this.crashed) await this.restart();
      else if (this.halted) await this.resume();
      else await this.pause();
    });
    add("over", ["⏭", "Next line"], "Run one line of your code. Functions it calls run in one go", () => this.stepLine(true));
    add("line", ["⤵", "Step into"], "Run one line, going inside the functions it calls if they're yours", () => this.stepLine(false));
    add("insn", ["↧", "Next instruction"], "Run exactly one machine instruction (advanced)", () => this.stepInstruction(), "dbg subtle");
    const autoGroup = el("span", "jt-group");
    const autoButton = el("button", "dbg");
    setLabel(autoButton, "⏯", "Auto-step");
    autoButton.title = "Keep stepping by itself, slowly enough to follow, recording every stop. Stops at breakpoints, or when you press Stop";
    autoButton.onclick = () => void this.autoStep().catch((e) => this.fail(e));
    this.buttons.auto = autoButton;
    for (const [v, label] of [["over", "by line"], ["line", "by line, into functions"], ["insn", "by instruction"], ["bp", "by breakpoint"]]) this.autoMode.add(new Option(label, v));
    for (const [v, label] of [["1000", "slow"], ["400", "medium"], ["100", "fast"], ["0", "fastest"]]) this.autoSpeed.add(new Option(label, v, false, v === "400"));
    this.autoMode.title = "What one automatic step is. By breakpoint: run at full speed to the next breakpoint, record that stop, wait, and run on again";
    this.autoSpeed.title = "How long to wait between automatic steps";
    autoGroup.append(autoButton, this.autoMode, this.autoSpeed);
    this.autoMode.onchange = this.autoSpeed.onchange = () => this.savePrefs();
    bar.append(autoGroup);

    this.live.type = "checkbox";
    const liveLabel = el("label", "check");
    liveLabel.title = "While the program runs, freeze it for a moment (under 0.1 s, at most once a second) to update the watched values";
    liveLabel.append(this.live, el("span", "lbl", " Live values"), el("span", "short", " Live"));
    this.live.onchange = () => {
      this.savePrefs();
      void this.livePoll();
    };
    this.verbose.type = "checkbox";
    this.verbose.checked = true;
    const verboseLabel = el("label", "check subtle");
    verboseLabel.title = "Log every USB transfer, TAP scan and debug-register access to the browser's developer console (for bug reports)";
    verboseLabel.append(this.verbose, " Log");
    verboseLabel.classList.add("jt-log");
    this.verbose.onchange = () => this.savePrefs();
    const close = el("button", "small", "×");
    close.title = "Close the hardware inspector";
    close.onclick = () => this.hide();
    bar.append(liveLabel, verboseLabel, close);
    bar.title = "Drag the toolbar to the left, right or bottom edge of the editor to dock the panel there";
    bar.classList.add("jt-drag");
    bar.onpointerdown = (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, label, input, select")) return;
      const area = root.parentElement!;
      bar.setPointerCapture(e.pointerId);
      const dockAt = (ev: PointerEvent) => {
        const r = area.getBoundingClientRect();
        const x = (ev.clientX - r.left) / r.width;
        return x > 0.65 ? "right" : x < 0.35 ? "left" : "bottom";
      };
      const move = (ev: PointerEvent) => area.setAttribute("data-dock-preview", dockAt(ev));
      const up = (ev: PointerEvent) => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        area.removeAttribute("data-dock-preview");
        area.dataset.dock = dockAt(ev);
        this.savePrefs();
        host.editor.layout();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    };
    const tabs = el("div", "jt-tabs");
    for (const t of TABS) {
      const b = el("button", "jt-tab", t);
      b.onclick = () => {
        this.tab = t;
        this.savePrefs();
        this.render();
      };
      this.tabButtons.set(t, b);
      tabs.append(b);
    }
    const resizer = el("div", "jt-resizer");
    resizer.title = "Drag to resize the panel";
    resizer.onpointerdown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      resizer.setPointerCapture(e.pointerId);
      const area = root.parentElement!;
      const dock = area.dataset.dock ?? "bottom";
      const rect = area.getBoundingClientRect();
      const move = (ev: PointerEvent) => {
        if (dock === "bottom") root.style.setProperty("--jt-h", `${Math.round(Math.min(Math.max(rect.bottom - ev.clientY, 120), rect.height - 120))}px`);
        else root.style.setProperty("--jt-w", `${Math.round(Math.min(Math.max(dock === "right" ? rect.right - ev.clientX : ev.clientX - rect.left, 240), rect.width - 240))}px`);
        area.style.setProperty("--jt-w", root.style.getPropertyValue("--jt-w"));
        host.editor.layout();
      };
      const up = () => {
        resizer.removeEventListener("pointermove", move);
        resizer.removeEventListener("pointerup", up);
        this.savePrefs();
        host.editor.layout();
      };
      resizer.addEventListener("pointermove", move);
      resizer.addEventListener("pointerup", up);
    };
    root.append(resizer, bar, this.story, this.scrubber, tabs, this.body);
    this.restorePrefs();
    this.setState();

    // The register descriptions (about 1 MB) load in the background.
    void loadSoc().then(() => this.render()).catch(() => {});
    for (const language of ["c", "cpp"]) {
      monaco.languages.registerHoverProvider(language, { provideHover: (model, pos) => this.hover(model, pos) });
    }
    // No resume on page close: USB transfers cut off by the page going away can wedge the chip's
    // JTAG adapter. A chip left paused is let go by the next Flash (release()) or Connect instead.
    host.editor.onDidChangeModel(() => {
      this.renderInline();
      this.showExec(false);
    });
  }

  show(): void {
    this.root.hidden = false;
    this.savePrefs();
    this.host.editor.layout();
  }

  hide(): void {
    this.root.hidden = true;
    this.savePrefs();
    this.host.editor.layout();
  }

  // ---- remembered between visits (localStorage) ----

  /** Whether JTAG was connected when the page was left: it reconnects then (no picker). */
  private wasConnected = false;

  private savePrefs(): void {
    const area = this.root.parentElement;
    const prefs: Prefs = {
      open: !this.root.hidden, dock: area?.dataset.dock, h: this.root.style.getPropertyValue("--jt-h") || undefined,
      w: this.root.style.getPropertyValue("--jt-w") || undefined, tab: this.tab, live: this.live.checked, log: this.verbose.checked,
      autoMode: this.autoMode.value, autoSpeed: this.autoSpeed.value, connected: this.wasConnected,
    };
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch { /* storage unavailable: nothing is remembered */ }
  }

  private restorePrefs(): void {
    let prefs: Prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Prefs;
    } catch { /* nothing remembered */ }
    const area = this.root.parentElement;
    if (prefs.open) this.root.hidden = false;
    if (area && prefs.dock) area.dataset.dock = prefs.dock;
    if (prefs.h) this.root.style.setProperty("--jt-h", prefs.h);
    if (prefs.w) {
      this.root.style.setProperty("--jt-w", prefs.w);
      area?.style.setProperty("--jt-w", prefs.w);
    }
    if (prefs.tab && (TABS as readonly string[]).includes(prefs.tab)) this.tab = prefs.tab;
    if (prefs.live !== undefined) this.live.checked = prefs.live;
    if (prefs.log !== undefined) this.verbose.checked = prefs.log;
    if (prefs.autoMode) this.autoMode.value = prefs.autoMode;
    if (prefs.autoSpeed) this.autoSpeed.value = prefs.autoSpeed;
    this.wasConnected = !!prefs.connected;
    // Connected before the page was reloaded: connect again, quietly (only to a device this page
    // was allowed before; never the browser's picker).
    if (this.wasConnected && !this.root.hidden) setTimeout(() => void this.connect(true), 300);
  }

  /** The panel is open: builds are made for it (debug info, no trace hooks). */
  get visible(): boolean {
    return !this.root.hidden;
  }

  /** The program (machine code, functions, app.bin layout), for the Program view. */
  private program?: Program;
  /** The Program view: a function or address chosen by the user (else where the CPU is). */
  private programAt?: number;
  private asmHover?: { model: monaco.editor.ITextModel; ids: string[] };

  /** The symbols of the build now on the chip, and the build itself (for its machine code). */
  attach(table: LineTable | undefined, elf?: Uint8Array, app?: { data: Uint8Array; address: number }): void {
    this.table = table;
    try {
      this.program = elf ? loadProgram(elf, app) : undefined;
    } catch {
      this.program = undefined;
    }
    this.programAt = undefined;
    this.symbols = table ? dataSymbols(table) : [];
    this.globalTypes = new Map((table?.info?.vars ?? []).filter((v) => v.addr !== undefined && v.type >= 0).map((v) => [v.addr!, v.type]));
    this.frames = undefined;
    this.dismissed.clear();
    this.spans.clear();
    this.frameSizes.clear();
    this.watches = [];
    this.timeline = [];
    this.states = [];
    this.viewIndex = undefined;
    this.memory.bytes = this.memory.prev = undefined;
    this.stack = undefined;
    this.discoverGlobals();
    this.setState();
  }

  get connected(): boolean {
    return !!this.target;
  }

  /** The tail of the serial output, to find ESP-IDF's message when the program crashes. */
  private serialTail = "";
  private panic?: { at: number; text: string };

  /** Serial monitor text, as it arrives. */
  serialText(text: string): void {
    this.serialTail = (this.serialTail + text).slice(-2000);
    const m = /Guru Meditation Error: Core\s+\d+ panic'ed \(([^)]*)\)|(Interrupt wdt timeout|Task watchdog got triggered|Stack (?:canary|protection fault)|abort\(\) was called|assert failed)/.exec(this.serialTail);
    if (m) {
      this.panic = { at: Date.now(), text: m[1] ?? m[2] };
      this.serialTail = this.serialTail.slice(m.index + m[0].length);
    }
  }

  /** Why the program crashed, in plain words, if ESP-IDF said so in the last few seconds. */
  private crashReason(): string {
    const p = this.panic && Date.now() - this.panic.at < 10000 ? this.panic.text : "";
    const plain = PANICS.find(([re]) => re.test(p))?.[1];
    return p ? `${plain ? `${plain} (ESP-IDF says “${p}”)` : `ESP-IDF says “${p}”`}` : "";
  }

  /**
   * Let the chip run and close the JTAG connection (before flashing, or when the page goes away).
   * Not connected, it still checks the chip: one left paused by an earlier page (closed or
   * reloaded mid-session) can't be flashed, so it connects quietly (no picker) to let it run.
   */
  async release(): Promise<void> {
    const t = this.target;
    if (!t) {
      await this.exclusiveUsb(async () => {
        if (this.target) return;
        const quiet = this.createTarget();
        quiet.setTrace((line) => {
          if (this.verbose.checked) console.log(`[jtag release] ${line}`);
        });
        const check = (async () => {
          await quiet.connect(true);
          if (await quiet.isHalted()) this.host.log("JTAG: the chip was still paused by an earlier session; letting it run", "muted");
          await quiet.disconnect(); // resumes it
        })();
        // Never hold up a flash for long: if the JTAG side doesn't answer, flash anyway.
        await Promise.race([check, sleep(5000)]).catch(() => { /* no JTAG device allowed or reachable */ });
      });
      if (!this.target) return;
      return this.release();
    }
    this.dropTarget();
    await this.run(() => t.disconnect().catch(() => {}));
  }

  /** The program crashed: continuing would only crash again (ESP-IDF holds it for the debugger). */
  private get crashed(): boolean {
    return this.states[this.states.length - 1]?.cause === "crash" && this.halted;
  }

  /** Start the program over, as after power-up (the USB connection stays). */
  private async restart(): Promise<void> {
    const t = this.target!;
    await this.run(async () => {
      if (this.target !== t) return;
      t.setBreakpoints(this.hardwareBreakpoints());
      await t.restartChip();
      this.halted = false;
    });
    this.host.chipRestarted?.();
    this.note("you restarted the chip");
    this.viewIndex = undefined;
    this.error = "";
    this.frames = undefined;
    this.clearExec();
    this.setState();
    void this.pollForStop();
  }

  // ---- connection and run control ----

  private fail(e: unknown): void {
    if (!this.target) return; // a late error from a session that's already gone
    const message = (e as Error).message ?? String(e);
    this.error = message;
    this.renderStory();
    this.host.log(`JTAG: ${message}`, "error");
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.then(action, action);
    this.queue = next.catch(() => {});
    return next;
  }

  private async toggleConnection(): Promise<void> {
    if (this.target) {
      const t = this.target;
      this.wasConnected = false;
      this.dropTarget();
      this.savePrefs();
      await this.run(() => t.disconnect().catch(() => {}));
      return;
    }
    await this.connect(false);
  }

  /**
   * Connect again without the browser's picker (after a re-flash, which resets the chip and makes
   * it re-appear on USB): retried for a few seconds while the chip boots.
   */
  async reconnect(): Promise<void> {
    if (this.target) return;
    for (let attempt = 0; attempt < 10 && !this.target; attempt++) {
      await sleep(500);
      if (await this.connect(true)) return;
    }
    this.host.log("JTAG: couldn't reconnect after flashing; press Connect.", "muted");
  }

  /** Opening the USB device: one at a time (a Connect click and Flash's check can coincide). */
  private usbLock: Promise<unknown> = Promise.resolve();
  private exclusiveUsb<T>(action: () => Promise<T>): Promise<T> {
    const next = this.usbLock.then(action, action);
    this.usbLock = next.catch(() => {});
    return next;
  }

  /** `quiet`: no picker, no error messages (for reconnect). Whether it connected. */
  private connect(quiet: boolean): Promise<boolean> {
    return this.exclusiveUsb(() => (this.target ? Promise.resolve(true) : this.connectNow(quiet)));
  }

  private async connectNow(quiet: boolean): Promise<boolean> {
    const target = this.createTarget();
    const start = performance.now();
    target.setTrace((line) => {
      if (this.verbose.checked) console.log(`[jtag ${((performance.now() - start) / 1000).toFixed(3)}] ${line}`);
    });
    target.onLost = (reason) => {
      if (this.target !== target) return;
      this.wasConnected = false;
      this.savePrefs();
      this.host.log(`JTAG: ${reason}`, "error");
      this.dropTarget(`${reason}. Connect again once the chip is back.`);
    };
    target.onReset = () => {
      if (this.target !== target) return;
      this.host.log("JTAG: the chip restarted; breakpoints are set again", "muted");
      this.note("the chip restarted");
      this.frames = undefined;
      this.frameSizes.clear();
      // The reset cleared the hardware breakpoints: stop briefly to put them back.
      if (this.hardwareBreakpoints().length) this.breakpointsChanged();
    };
    this.connecting = true;
    this.error = "";
    this.setState();
    try {
      await target.connect(quiet);
    } catch (e) {
      this.connecting = false;
      if (!quiet) {
        this.error = (e as Error).message ?? String(e);
        this.host.log(`JTAG: ${this.error}`, "error");
      }
      this.setState();
      return false;
    }
    this.connecting = false;
    this.target = target;
    this.stepCount = 0;
    this.host.connectionChanged?.(true);
    this.wasConnected = true;
    this.savePrefs();
    this.host.log(`JTAG connected: ${target.name}${target.coreCount > 1 ? `, ${target.coreCount} cores` : ""}`, "ok");
    const halted = await this.run(async () => {
      this.halted = await target.isHalted();
      if (this.halted) await this.chooseCore(target);
      return this.halted;
    });
    if (halted) await this.snapshot("it was already paused when you connected");
    else {
      void this.pollForStop();
      // Breakpoints set in the editor (remembered from before a reload, say) go into the chip now,
      // not only at the next Continue.
      if (this.hardwareBreakpoints().length) this.breakpointsChanged();
    }
    if (this.live.checked) void this.livePoll(); // Live values was on (before a reload, say)
    void this.watchWhilePaused(target);
    this.setState();
    return true;
  }

  /** Forget the session (after a disconnect, or when the chip went away). */
  private dropTarget(error = ""): void {
    if (this.target) this.host.connectionChanged?.(false);
    this.target = undefined;
    this.halted = false;
    this.cancelStep = true;
    this.autoRunning = false;
    this.live.checked = false;
    this.viewIndex = undefined;
    this.error = error;
    this.clearExec();
    this.setState();
    this.renderInline();
  }

  /** Update the buttons, the status banner and the panel after any change. */
  private setState(): void {
    const busy = this.stepping || this.autoRunning;
    const b = this.buttons;
    setLabel(b.connect, ...(this.target ? ["⏏", "Disconnect"] : this.connecting ? ["…", "Connecting…"] : ["⏻", "Connect"]) as [string, string]);
    b.connect.title = this.target ? "Disconnect from the chip (it keeps running)" : "Connect to the ESP32-S3 through its native USB port (WebUSB)";
    b.connect.disabled = this.connecting;
    const [icon, text, title] = busy ? ["■", "Stop", "Stop stepping and stay where the program is"]
      : this.crashed ? ["↻", "Restart", "Start the program over (continuing would only crash again)"]
      : this.halted ? ["▶", "Continue", "Let the program run on"] : ["⏸", "Pause", "Freeze the program to look inside it"];
    setLabel(b.pause, icon, text);
    b.pause.title = title;
    b.pause.disabled = !this.target;
    for (const id of ["line", "over", "insn", "auto"]) b[id].disabled = !this.target || !this.halted || busy;
    this.autoMode.disabled = this.autoSpeed.disabled = !this.target;
    this.render();
  }

  private stopStepping(): void {
    this.autoRunning = false;
    this.cancelStep = true;
  }

  // State changes happen inside the queued action, so a background job queued behind it
  // (stop polling, live values, re-programming breakpoints) sees the state it will act on.

  private async pause(): Promise<void> {
    const t = this.target!;
    const stopped = await this.run(async () => {
      if (this.target !== t || this.halted) return false; // the stop-watcher got there first
      await t.halt();
      this.halted = true;
      await this.chooseCore(t);
      return true;
    });
    if (stopped) await this.snapshot();
  }

  /**
   * After a stop, follow the core that matters: the one that stopped by itself (breakpoint,
   * crash), else one that's in your code, else the one Arduino runs loop() on (core 1).
   */
  private async chooseCore(t: DebugTarget): Promise<void> {
    if (t.coreCount < 2) return;
    if (t.stoppedCore !== undefined) return t.selectCore(t.stoppedCore);
    const table = this.table;
    if (table) {
      // First a core that's in your code, then one that's in a function your code called
      // (gpio_set_level, delay, …): its call stack leads back to your code.
      // Only stopped cores: one held in reset (after a restart) has no registers to read.
      for (const i of t.haltedCores) {
        t.selectCore(i);
        if (functionAt(table, await t.readPc())) return;
      }
      for (const i of t.haltedCores) {
        t.selectCore(i);
        const frames = await t.readFrames(MAX_FRAMES).catch(() => []);
        if (frames.slice(1).some((f) => functionAt(table, f.pc - 1))) return;
      }
    }
    // Neither: the core your program's main task runs on. Arduino runs loop() on core 1;
    // ESP-IDF's app_main runs on core 0.
    const arduino = !!table && Array.from({ length: table.funcs.length / 3 }, (_, k) => table.names[table.funcs[3 * k + 2]]).some((n) => /^loop(\(|$)/.test(n));
    const preferred = arduino ? Math.min(1, t.coreCount - 1) : 0;
    t.selectCore(t.haltedCores.includes(preferred) ? preferred : t.haltedCores[0] ?? preferred);
  }

  private async resume(): Promise<void> {
    const t = this.target!;
    const resumed = await this.run(async () => {
      if (this.target !== t || !this.halted) return false;
      t.setBreakpoints(this.hardwareBreakpoints());
      await t.resume();
      this.halted = false;
      return true;
    });
    if (!resumed) return;
    this.viewIndex = undefined;
    this.error = "";
    this.clearExec();
    this.setState();
    void this.pollForStop();
  }

  private hardwareBreakpoints(): number[] {
    return this.table ? this.host.breakpoints(this.table) : [];
  }

  /** Called when the gutter breakpoints change: they take effect at the next resume. */
  breakpointsChanged(): void {
    const count = this.hardwareBreakpoints().length;
    if (this.target && count > 2) {
      this.host.log(`JTAG: the ESP32-S3 can stop at only 2 places at once; ${count - 2} of your ${count} breakpoints won't stop the program. Remove one to use another.`, "error");
    }
    if (this.target && !this.halted) {
      // While running, stop briefly to program the new breakpoints.
      const t = this.target;
      void this.run(async () => {
        if (this.target !== t || this.halted) return; // halted by now: they're applied on the next resume
        // Stopped by itself (at a breakpoint)? Leave it stopped for the stop-watcher to report.
        if (await t.isHalted()) return;
        await t.halt();
        t.setBreakpoints(this.hardwareBreakpoints());
        await t.resume();
      }).catch((e) => this.fail(e));
    }
  }

  /**
   * Watch for the program hitting a breakpoint. A failed poll (a USB hiccup) is retried: one
   * error must not leave the panel saying "running" while the CPU sits at a breakpoint.
   */
  private async pollForStop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let failures = 0;
    try {
      while (this.target && !this.halted) {
        await sleep(100);
        const t = this.target;
        if (!t || this.halted) break;
        let stopped: boolean;
        try {
          stopped = await this.run(async () => {
            if (this.target !== t || this.halted) return false;
            if (!(await t.isHalted())) return false;
            this.halted = true;
            await this.chooseCore(t);
            return true;
          });
          failures = 0;
        } catch (e) {
          if (++failures < POLL_FAILURES) continue;
          this.fail(new Error(`Lost track of the CPU (${(e as Error).message}). Press Pause, or reconnect.`));
          break;
        }
        if (stopped) await this.snapshot();
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * While paused, the chip can still be reset from outside (its reset button, the Reset button
   * up top, a re-flash); it then runs again, from the start. Checked about once a second.
   */
  private async watchWhilePaused(t: DebugTarget): Promise<void> {
    while (this.target === t) {
      await sleep(1000);
      if (this.target !== t || !this.halted || this.stepping || this.autoRunning) continue;
      try {
        const restarted = await this.run(async () => this.target === t && this.halted && !this.stepping && await t.checkRestarted());
        if (!restarted) continue;
        this.halted = false;
        this.viewIndex = undefined;
        this.clearExec();
        this.setState();
        // The reset cleared the breakpoints (onReset couldn't put them back: it ran while this
        // still counted as paused).
        if (this.hardwareBreakpoints().length) this.breakpointsChanged();
        void this.pollForStop();
      } catch { /* a USB hiccup: try again next time */ }
    }
  }

  /**
   * Live values. The chip's interrupt watchdog (about 300 ms) panics the core if it's
   * halted for long, and every register or memory word costs several USB round trips,
   * so each pause is kept to a small time budget: only watched variables are read (no
   * registers, stack or memory view), a few at a time in round-robin order, and the gap
   * between pauses grows with the measured pause length so the program mostly runs.
   */
  private async livePoll(): Promise<void> {
    let next = 0;
    let gap = LIVE_MIN_GAP_MS;
    while (this.live.checked && this.target) {
      // Globals and statics only: a local needs a walk of the call stack to find, and while the
      // program runs its function is rarely the one on the CPU at that instant anyway.
      const watches = this.watches.filter((w) => !w.local);
      // With the Pins tab open, every update also samples the pins, for their history.
      const pins = this.tab === "Pins" && !!this.pins;
      if (!this.halted && (watches.length || pins)) {
        const t = this.target;
        try {
          let paused = 0;
          await this.run(async () => {
            // Paused by the user meanwhile, or stopped at a breakpoint by itself: don't resume it.
            if (this.target !== t || this.halted || await t.isHalted()) return;
            const start = performance.now();
            await t.halt();
            this.frames = undefined;
            const budgetEnd = start + LIVE_BUDGET_MS;
            let n = 0;
            if (pins) await this.readPins(t, true);
            for (; n < watches.length && (n === 0 || performance.now() < budgetEnd); n++) {
              await this.readWatch(t, watches[(next + n) % watches.length], false);
            }
            if (watches.length) next = (next + n) % watches.length;
            t.setBreakpoints(this.hardwareBreakpoints());
            await t.resume();
            paused = performance.now() - start;
          });
          gap = Math.max(LIVE_MIN_GAP_MS, paused * LIVE_DUTY);
          this.lastLivePause = paused;
          if (paused > LIVE_BUDGET_MS * 2) this.host.log(`JTAG live: pausing took ${Math.round(paused)} ms. Watch fewer variables to keep the program running smoothly.`, "muted");
          this.render();
          this.renderInline();
        } catch (e) {
          this.fail(e);
          this.live.checked = false;
        }
      }
      await sleep(gap);
    }
  }

  // ---- stepping ----

  private async stepInstruction(): Promise<void> {
    const t = this.target!;
    this.stepping = true;
    this.setState();
    try {
      const stepped = await this.run(async () => {
        if (this.target !== t || !this.halted) return false;
        t.setBreakpoints(this.hardwareBreakpoints());
        await t.stepInstruction();
        return true;
      });
      if (stepped) await this.snapshot("one instruction ran", true);
    } finally {
      this.stepping = false;
      this.setState();
    }
  }

  /**
   * Step to the next source line. Calls into code without line info are run through, and so
   * (for Next line) are calls made from your code; once the step has left your code (returned
   * into the framework, say), a call back into your code stops there: stepping past the end
   * of loop() lands on its first line again instead of skipping it. Stopped outside your code
   * (inside delay(), say), it first runs until that returns to your code.
   */
  private async stepLine(over: boolean): Promise<void> {
    const t = this.target!;
    const table = this.table;
    if (!table) return this.stepInstruction();
    this.cancelStep = false;
    this.stepping = true;
    this.setState();
    let note = "";
    let reason = "it finished the line";
    let moved = false;
    try {
      await this.run(async () => {
        if (this.target !== t || !this.halted) return;
        let pc = await t.readPc();
        if (!functionAt(table, pc)) {
          // In system code: finish it, up to the first caller that's your code.
          this.frames = undefined;
          const caller = (await this.ensureFrames(t)).slice(1).find((f) => functionAt(table, f.at));
          // Not called from your code: the CPU is running another task (often idle, while loop() sleeps in delay()).
          const resumeAt = caller ? caller.at + 1 : await this.whereLoopResumes(t);
          if (resumeAt === undefined) {
            note = "The CPU is running system code (another task), and it isn't clear where your code continues. Set a breakpoint in your code and press Continue.";
            reason = "it's in system code";
            return;
          }
          const result = await this.runTo(t, resumeAt);
          reason = result === "reached" ? "it came back to your code" : result;
          moved = true;
          return;
        }
        const start = locateExact(table, pc);
        moved = true;
        if (start) reason = `line ${start.line} ran`;
        const startFn = functionAt(table, pc);
        const deadline = Date.now() + STEP_TIME_LIMIT_MS;
        for (let n = 0; ; n++) {
          if (this.cancelStep) { reason = "you pressed Stop"; break; }
          if (n >= MAX_STEPS || Date.now() > deadline) { note = "No line of your code was reached in time; stopped where the CPU is."; break; }
          const before = pc;
          t.setBreakpoints(this.hardwareBreakpoints());
          await t.stepInstruction();
          pc = await t.readPc();
          const loc = locateExact(table, pc);
          const insideStart = startFn && pc >= startFn.start && pc < startFn.end;
          const entered = await this.enteredCall(t, before, pc);
          if (entered !== undefined && (!loc || (over && functionAt(table, before)))) {
            // Run until the call returns, then keep stepping.
            const result = await this.runTo(t, entered);
            if (result !== "reached") { reason = result; break; }
            pc = await t.readPc();
            continue;
          }
          if (loc && (loc.line !== start?.line || loc.file !== start?.file || !insideStart)) break;
        }
      });
      if (note) this.host.log(`JTAG: ${note}`, "muted");
      // Read the new stop before the buttons come back, so the next click acts on what's shown.
      await this.snapshot(reason, moved);
    } finally {
      this.stepping = false;
      this.setState();
      // An error while a call was running to its return leaves the CPU running: keep watching it.
      if (this.target === t && !this.halted) void this.pollForStop();
    }
  }

  /**
   * Let the program run until the current core gets to `addr` (a return address), with a
   * temporary breakpoint there. Runs inside the queue; the CPU is halted again afterwards.
   */
  private async runTo(t: DebugTarget, addr: number): Promise<"reached" | string> {
    const core = t.core;
    t.setBreakpoints([addr, ...this.hardwareBreakpoints()].slice(0, 2));
    await t.resume();
    this.halted = false;
    const deadline = Date.now() + 30000;
    let result = "";
    while (!(await t.isHalted())) {
      if (this.target !== t) return "disconnected";
      if (this.cancelStep || Date.now() > deadline) {
        await t.halt();
        result = this.cancelStep ? "you pressed Stop" : "the function didn't return within 30 s, so it was paused";
        break;
      }
      await sleep(50);
    }
    this.halted = true;
    if (result) {
      await this.chooseCore(t);
      return result;
    }
    // Stopped at the return address (on the stepping core), or somewhere else: a breakpoint of yours.
    if (t.stoppedCore === core) {
      t.selectCore(core);
      if ((await t.readPc()) === addr) return "reached";
    }
    await this.chooseCore(t);
    return CAUSES.breakpoint;
  }

  /**
   * Where your code continues once its task wakes up, while the CPU runs another one (often the
   * idle task, while your code waits in delay() or vTaskDelay()): the innermost return address
   * into your code on that task's saved stack, just after the call it's waiting in. FreeRTOS keeps
   * a waiting task's stack pointer in the first word of its task control block (TCB). Arduino's
   * loop task is found through loopTaskHandle; any other task (ESP-IDF's app_main, tasks you
   * created) through FreeRTOS's lists of ready, delayed and suspended tasks. Else the start of
   * loop(), for Arduino.
   */
  private async whereLoopResumes(t: DebugTarget): Promise<number | undefined> {
    const table = this.table!;
    const word = (b: Uint8Array, i = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
    let loopStart: number | undefined;
    for (let i = 0; i < table.funcs.length; i += 3) {
      if (/^loop(\(|$)/.test(table.names[table.funcs[i + 2]])) loopStart = table.funcs[i];
    }
    const top = (await t.readPc()) & 0xc0000000;
    const resumesAt = async (tcb: number): Promise<number | undefined> => {
      const sp = word(await t.readMemory(tcb, 4));
      const bytes = await t.readMemory(sp, 512);
      for (let i = 0; i + 4 <= bytes.length; i += 4) {
        const w = word(bytes, i);
        if (!(w >>> 30)) continue; // a windowed return address has the call size in its top bits
        const ra = ((w & 0x3fffffff) | top) >>> 0;
        if (functionAt(table, ra - 1) && locateExact(table, ra)) return ra;
      }
      return undefined;
    };
    try {
      const handle = this.symbols.find((s) => s.name === "loopTaskHandle");
      const tcb = handle && word(await t.readMemory(handle.addr, 4));
      if (tcb) return (await resumesAt(tcb)) ?? loopStart;
      for (const tcb of await this.waitingTasks(t)) {
        const ra = await resumesAt(tcb).catch(() => undefined);
        if (ra !== undefined) return ra;
      }
    } catch (e) {
      this.host.log(`JTAG: couldn't read the waiting task's stack: ${(e as Error).message}`, "muted");
    }
    return loopStart;
  }

  /**
   * The TCBs of the tasks that aren't running right now, from FreeRTOS's task lists (tasks.c).
   * A list is { item count, pxIndex, end marker { value, pxNext, pxPrevious } }: 20 bytes, its
   * first item at +12. An item is { value, pxNext, pxPrevious, pvOwner (the TCB), container }.
   */
  private async waitingTasks(t: DebugTarget): Promise<number[]> {
    const word = (b: Uint8Array, i = 0) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(i, true);
    const lists: number[] = [];
    for (const s of this.symbols) {
      if (/^(xDelayedTaskList[12]|xSuspendedTaskList|xPendingReadyList)$/.test(s.name)) lists.push(s.addr);
      // One list per priority, highest last: those wake first.
      if (s.name === "pxReadyTasksLists") for (let o = s.size - 20; o >= 0; o -= 20) lists.push(s.addr + o);
    }
    const running = this.symbols.find((s) => s.name === "pxCurrentTCBs" || s.name === "pxCurrentTCB");
    const skip = new Set<number>();
    if (running) {
      const b = await t.readMemory(running.addr, Math.min(Math.max(running.size, 4), 8));
      for (let i = 0; i + 4 <= b.length; i += 4) skip.add(word(b, i));
    }
    const tcbs: number[] = [];
    for (const list of lists) {
      const head = await t.readMemory(list, 20);
      const count = word(head, 0);
      let item = word(head, 12);
      for (let n = 0; n < Math.min(count, 32) && item !== list + 8; n++) {
        const it = await t.readMemory(item, 16);
        const tcb = word(it, 12);
        if (tcb && !skip.has(tcb) && !tcbs.includes(tcb)) tcbs.push(tcb);
        item = word(it, 4);
      }
    }
    return tcbs;
  }

  /** If the instruction at `from` was a call that landed at `to`, the address it returns to. */
  private async enteredCall(t: DebugTarget, from: number, to: number): Promise<number | undefined> {
    if (to >= from && to < from + 4) return undefined;
    const b = await t.readMemory(from, 3);
    const insn = b[0] | (b[1] << 8) | (b[2] << 16);
    const isCall = (insn & 0xf) === 5; // CALL0/4/8/12: op0 = 5, n in bits 5:4
    // CALLX0/4/8/12: op0, op1, op2 and r are 0, bits 7:6 are 3 (bits 5:4 hold n, bits 11:8 the register)
    const isCallx = (insn & 0xfff0cf) === 0x0000c0;
    if (!isCall && !isCallx) return undefined;
    const n = (insn >> 4) & 3;
    const regs = await t.readRegisters();
    return ((regs.ar[n * 4] & 0x3fffffff) | (to & 0xc0000000)) >>> 0;
  }

  /** Keep stepping on its own, one recorded stop at a time, until Stop, a breakpoint or a crash. */
  private async autoStep(): Promise<void> {
    if (this.autoRunning) return this.stopStepping();
    this.autoRunning = true;
    this.cancelStep = false;
    this.viewIndex = undefined;
    this.setState();
    try {
      if (this.autoMode.value === "bp" && !this.hardwareBreakpoints().length) {
        this.host.log("JTAG: auto-step by breakpoint needs a breakpoint: click left of a line number to set one", "error");
        return;
      }
      while (this.autoRunning && this.target && this.halted) {
        const mode = this.autoMode.value;
        if (mode === "insn") await this.stepInstruction();
        else if (mode === "bp") {
          if (!(await this.runToBreakpoint())) break;
        } else await this.stepLine(mode === "over");
        if (!this.autoRunning || this.cancelStep || !this.halted) break;
        const last = this.states[this.states.length - 1];
        if (last?.cause === "crash") break;
        // Stepping line by line, a breakpoint ends the run; by breakpoint, it's where each step ends.
        if (mode !== "bp" && last && this.hardwareBreakpoints().includes(last.pc)) {
          this.host.log("JTAG: auto-step stopped at a breakpoint", "muted");
          break;
        }
        const wait = Number(this.autoSpeed.value);
        if (wait) await sleep(wait);
      }
    } finally {
      this.autoRunning = false;
      this.setState();
    }
  }

  /**
   * One auto-step by breakpoint: let the program run at full speed until it stops at a breakpoint
   * (the stop-watcher records it). Stop pauses it wherever it is. Whether it reached one.
   */
  private async runToBreakpoint(): Promise<boolean> {
    const before = this.states.length;
    await this.resume();
    while (this.target && !this.halted) {
      if (!this.autoRunning || this.cancelStep) {
        await this.pause();
        return false;
      }
      await sleep(50);
    }
    // The stop-watcher saw the stop; wait for its reading to be recorded.
    for (let n = 0; n < 100 && this.states.length === before && this.target; n++) await sleep(50);
    return this.halted && this.states.length > before;
  }

  // ---- reading the chip ----

  /** Read everything the panels show and record it as a new stop; the CPU must be halted. */
  private async read(reason?: string, stepped = false): Promise<void> {
    const t = this.target!;
    this.frames = undefined;
    let cause = await t.stopCause().catch((): StopCause => "unknown");
    this.regs = await t.readRegisters();
    // With a debugger attached, ESP-IDF's crash handler puts a breakpoint on the instruction that
    // failed and returns to it: a breakpoint stop that isn't one of yours is a crash.
    // Only when there's evidence of a crash: ESP-IDF's panic message, or a stop outside your code.
    // A breakpoint in your code the editor doesn't know is one still programmed in the chip
    // (from before a page reload, say): resuming clears it.
    let foreign = false;
    if (!reason && cause === "breakpoint" && !this.hardwareBreakpoints().includes(this.regs.pc)) {
      const inYourCode = !!this.table && !!functionAt(this.table, this.regs.pc);
      if (this.crashReason() || !inYourCode) cause = "crash";
      else foreign = true;
    }
    this.where = this.table ? locateExact(this.table, this.regs.pc) : undefined;
    // Past the registers, a part that can't be read (a corrupt stack pointer, a bad address)
    // is reported but doesn't take the rest of the snapshot down with it.
    const sp = this.regs.ar[1];
    try {
      const raw = await t.readMemory(sp, STACK_WORDS * 4);
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const words = Array.from({ length: STACK_WORDS }, (_, i) => dv.getUint32(i * 4, true));
      this.stack = { base: sp, words, prev: this.stack?.base === sp ? this.stack.words : undefined };
    } catch (e) {
      this.stack = undefined;
      this.host.log(`JTAG: couldn't read the stack at 0x${hex(sp)}: ${(e as Error).message}`, "muted");
    }
    try {
      await this.discoverLocals(t);
    } catch (e) {
      this.host.log(`JTAG: couldn't walk the call stack: ${(e as Error).message}`, "muted");
    }
    for (const w of this.watches) await this.readWatch(t, w);
    if (this.tab === "Memory" || this.memory.bytes || this.memory.words) {
      await this.readMemoryView(t).catch((e) => this.host.log(`JTAG: ${(e as Error).message}`, "error"));
    }
    const pinSample = this.tab === "Pins"
      ? await this.readPins(t).catch((e) => void this.host.log(`JTAG: couldn't read the pins: ${(e as Error).message}`, "muted"))
      : undefined;
    const values = new Map<string, Uint8Array>();
    for (const w of this.watches) if (w.bytes && !w.stale && !w.error) values.set(w.key, w.bytes);
    const state: CpuState = {
      n: ++this.stepCount, at: Date.now(), core: t.core, cause, stepped,
      reason: cause === "crash" ? `${CAUSES.crash}${this.crashReason() ? `: ${this.crashReason()}` : ""}`
        : foreign ? "it reached a breakpoint that's still set in the chip but not in the editor (from before the page was reloaded?); Continue clears it"
        : reason ?? CAUSES[cause],
      pc: this.regs.pc, where: this.where, ar: [...this.regs.ar],
      stack: this.stack && { base: this.stack.base, words: [...this.stack.words] }, values,
      calls: (this.frames as Frame[] | undefined)?.map((f) => f.pc), // set by discoverLocals()
    };
    this.states.push(state);
    if (pinSample) pinSample.state = state.n;
    if (this.states.length > MAX_STATES) this.states.shift();
    this.timeline.push({ at: state.at, text: `stopped: ${state.reason}`, loc: state.where, state });
    if (this.timeline.length > MAX_STATES) this.timeline.shift();
  }

  /** `deep`: also read what an object's pointers point to (not in Live mode: pauses stay short). */
  private async readWatch(t: DebugTarget, w: Watch, deep = true): Promise<void> {
    try {
      await this.readWatchValue(t, w);
      if (deep) await this.followPointers(t, w);
      w.error = undefined;
    } catch (e) {
      w.error = (e as Error).message;
      w.changed = false;
    }
  }

  private async readWatchValue(t: DebugTarget, w: Watch): Promise<void> {
    if (w.local && w.local.addr === undefined) {
      const frame = (await this.ensureFrames(t)).find((f) => f.cfa !== undefined && f.at >= w.local!.lo && f.at < w.local!.hi);
      if (!frame) {
        w.stale = true;
        w.changed = false;
        return;
      }
      w.stale = false;
      w.sym.addr = ((w.local.base === "sp" ? frame.sp : frame.cfa!) + w.local.fbreg!) >>> 0;
    }
    const bytes = await t.readMemory(w.sym.addr, Math.min(w.sym.size, w.type !== undefined ? MAX_TYPED_BYTES : 64));
    const before = w.bytes;
    w.changed = !!before && !sameBytes(before, bytes);
    w.prev = before;
    w.bytes = bytes;
    if (w.sym.size <= 8) w.history = [...w.history, toNumber(bytes, true)].slice(-HISTORY);
    const [was, now] = before ? [this.fmtBytes(w, before), this.fmtBytes(w, bytes)] : [];
    if (w.changed && was !== now) this.note(`${w.sym.name} changed: ${was} → ${now}`);
  }

  /** The struct/class a type is, when its layout is known. */
  private structType(type: number | undefined): StructType | undefined {
    const info = this.table?.info;
    const t = info && type !== undefined ? strip(info, type) : undefined;
    return t?.k === "struct" && t.members.length ? t : undefined;
  }

  /** A member's value as a number (integers, booleans, enums, pointers), from the object's bytes. */
  private memberNum(m: Member, bytes: Uint8Array): number | undefined {
    const info = this.table?.info;
    const t = info && strip(info, m.type);
    if (!t || (t.k !== "base" && t.k !== "ptr" && t.k !== "enum")) return undefined;
    const size = t.k === "ptr" ? 4 : t.size;
    if (size > 4 || m.off + size > bytes.length) return undefined;
    let v = 0;
    for (let i = size - 1; i >= 0; i--) v = v * 256 + bytes[m.off + i];
    const signed = t.k === "base" && (t.enc === 5 || t.enc === 6);
    return signed && v >= 2 ** (size * 8 - 1) ? v - 2 ** (size * 8) : v;
  }

  /**
   * Read what an object's pointer members point to (a NeoPixel's colour buffer, say), sized by a
   * sibling member that holds the length where there is one.
   */
  private async followPointers(t: DebugTarget, w: Watch): Promise<void> {
    const st = this.structType(w.type);
    const info = this.table?.info;
    if (!st || !info || !w.bytes || w.stale) return;
    const bytes = w.bytes;
    const num = (name: string) => {
      const m = st.members.find((x) => x.name === name);
      return m && this.memberNum(m, bytes);
    };
    const follow = new Map<string, Uint8Array>();
    for (const m of st.members) {
      const mt = strip(info, m.type);
      if (mt?.k !== "ptr") continue;
      const addr = num(m.name);
      const region = addr ? regionAt(addr) : undefined;
      if (!addr || !region || region.kind === "peripheral" || region.wordOnly) continue;
      const len = pointeeLength(m.name, num, mt.to >= 0 ? typeSize(info, mt.to) || 1 : 1);
      try {
        follow.set(m.name, await t.readMemory(addr, len));
      } catch { /* an address that can't be read: leave it out */ }
    }
    w.follow = follow;
  }

  /** A library's plain-language summary of an object, if there's one for its class. */
  private summary(w: Watch, bytes: Uint8Array | undefined): Summary | undefined {
    const st = this.structType(w.type);
    if (!st || !bytes) return undefined;
    return summarize(st.name, {
      num: (name) => {
        const m = st.members.find((x) => x.name === name);
        return m && this.memberNum(m, bytes);
      },
      target: (name) => (this.lookingBack ? undefined : w.follow?.get(name)),
    });
  }

  /** A value short enough to sit next to the code: an object by its library's summary. */
  private inlineValue(w: Watch, bytes: Uint8Array): string {
    const s = this.summary(w, bytes);
    if (s) return s.short;
    const text = this.fmtBytes(w, bytes);
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }

  /** A class only declared in your code (its layout is in a library's debug info): shown as bytes. */
  private opaque(w: Watch): boolean {
    const info = this.table?.info;
    let t = w.type ?? -1;
    for (let n = 0; n < 8 && info?.types[t]?.k === "alias"; n++) t = (info.types[t] as { to: number }).to;
    return info?.types[t]?.k === "struct" && !(info.types[t] as { members: unknown[] }).members.length;
  }

  /** Whether a value reads as a value (a number, a struct), rather than a dump of bytes. */
  private readableValue(w: Watch): boolean {
    return w.sym.size <= 8 || (w.type !== undefined && w.type >= 0 && !this.opaque(w));
  }

  /** A value for display: typed (structs, arrays, enums) when the type is known. */
  private fmtBytes(w: Watch, bytes: Uint8Array): string {
    const info = this.table?.info;
    if (info && w.type !== undefined && w.type >= 0 && w.format !== "hex" && !this.opaque(w)) return formatTyped(info, w.type, bytes);
    return formatBytes(bytes, w.format);
  }

  /** What a watch shows when there's no value: why not, in plain words. */
  private noValue(w: Watch): string {
    if (w.error) return "(can't be read)";
    if (w.local && w.local.fbreg === undefined && w.local.addr === undefined) return "(optimized away)";
    if (w.local) return "(not in use right now)";
    return this.target ? "pause to see" : "—";
  }

  /** Bytes the compiler reserved for the frame, read from the function's first instruction. */
  private async frameSize(t: DebugTarget, start: number): Promise<number> {
    let size = this.frameSizes.get(start);
    if (size === undefined) {
      const b = await t.readMemory(start, 3);
      if (b[0] === 0x36) size = ((b[2] << 4) | (b[1] >> 4)) * 8; // entry a1, N
      else if (b[0] === 0x12 && b[1] === 0xc1) size = Math.max(0, -((b[2] << 24) >> 24)); // addi a1, a1, -N (call0 ABI)
      else size = 0;
      this.frameSizes.set(start, size);
    }
    return size;
  }

  private async ensureFrames(t: DebugTarget): Promise<Frame[]> {
    if (this.frames) return this.frames;
    const raw = await t.readFrames(MAX_FRAMES);
    const frames: Frame[] = [];
    for (const [i, f] of raw.entries()) {
      const at = i ? f.pc - 1 : f.pc;
      const fn = this.table && functionAt(this.table, at);
      let cfa: number | undefined;
      if (fn) cfa = f.sp + (i === 0 && f.pc === fn.start ? 0 : await this.frameSize(t, fn.start));
      frames.push({ pc: f.pc, at, sp: f.sp, cfa });
    }
    return (this.frames = frames);
  }

  /** Add the locals and parameters of the user functions on the stack. */
  private async discoverLocals(t: DebugTarget): Promise<void> {
    const info = this.table?.info;
    if (!info) return;
    const frames = await this.ensureFrames(t);
    for (const f of frames) {
      if (f.cfa === undefined) continue;
      for (const v of info.vars) {
        if (v.fbreg !== undefined && v.type >= 0 && f.at >= v.lo && f.at < v.hi) this.addLocal(v, true);
      }
    }
  }

  private localKey(v: VarInfo): string {
    return `l:${v.func}:${v.name}:${v.lo.toString(16)}`;
  }

  private addLocal(v: VarInfo, auto = false): void {
    const key = this.localKey(v);
    if (this.watches.some((w) => w.key === key) || (auto && this.dismissed.has(key))) return;
    if (auto && this.watches.filter((w) => w.auto).length >= MAX_AUTO * 2) return;
    const size = this.table?.info && v.type >= 0 ? typeSize(this.table.info, v.type) : 0;
    this.watches.push({
      key, sym: { name: v.name, addr: v.addr ?? 0, size: size || 4 }, type: v.type, local: v,
      format: "dec", history: [], changed: false, auto,
    });
  }

  private note(text: string): void {
    this.timeline.push({ at: Date.now(), text, loc: this.where });
    if (this.timeline.length > MAX_STATES) this.timeline.shift();
  }

  /** A stop: read the chip, record it, show where it is, update every view. */
  private async snapshot(reason?: string, stepped = false): Promise<void> {
    const t = this.target;
    let read = false;
    try {
      // Only while still halted: a Continue queued ahead of this would have the core running.
      read = await this.run(async () => {
        if (!t || this.target !== t || !this.halted) return false;
        await this.read(reason, stepped);
        return true;
      });
    } catch (e) {
      this.fail(e);
      this.setState();
      return;
    }
    if (!read) return;
    // A new stop shows the present, except while auto-step runs and the user scrubbed back:
    // the recording goes on, and what they're looking at stays put.
    if (!this.autoRunning) this.viewIndex = undefined;
    this.error = "";
    const last = this.states[this.states.length - 1];
    if (last?.cause === "crash") {
      this.host.log(`JTAG: ${last.reason}. The chip is paused where it went wrong; the Call stack tab shows how it got there. Restart starts the program over.`, "error");
    }
    this.setState();
    this.showExec(true);
    this.renderInline();
  }

  // ---- the recording ----

  /** The stop being shown: the one looked back at, else the latest. */
  private viewed(): CpuState | undefined {
    return this.viewIndex !== undefined ? this.states[this.viewIndex] : this.states[this.states.length - 1];
  }

  /** The line that just ran: the stop before's line, when this stop came from a step out of it. */
  private justRan(state: CpuState): SourceLocation | undefined {
    if (!state.stepped) return undefined;
    const i = this.states.indexOf(state);
    return i > 0 ? this.states[i - 1].where : undefined;
  }

  /** The stop just before the viewed one, to compare with. */
  private previous(): CpuState | undefined {
    const i = this.viewIndex ?? this.states.length - 1;
    return i > 0 ? this.states[i - 1] : undefined;
  }

  private get lookingBack(): boolean {
    return this.viewIndex !== undefined && this.viewIndex < this.states.length - 1;
  }

  private viewState(i: number | undefined): void {
    this.viewIndex = i === undefined || i >= this.states.length - 1 ? undefined : Math.max(0, i);
    this.render();
    this.showExec(true);
    this.renderInline();
  }

  /** A watch's value now and before, for the stop being viewed (or the latest read). */
  private valuesOf(w: Watch): { now?: Uint8Array; before?: Uint8Array } {
    if (this.lookingBack) return { now: this.viewed()?.values.get(w.key), before: this.previous()?.values.get(w.key) };
    return { now: w.bytes, before: w.prev };
  }

  // ---- watches ----

  private discoverGlobals(): void {
    if (!this.symbols.length) return;
    const byName = new Map(this.symbols.map((s) => [shortName(s.name), s]));
    const used = new Set<string>();
    for (const { model } of this.host.sources()) {
      for (const m of model.getValue().matchAll(/[A-Za-z_]\w*/g)) {
        if (byName.has(m[0])) used.add(m[0]);
      }
    }
    for (const name of [...used].slice(0, MAX_AUTO)) this.addWatch(byName.get(name)!, true);
  }

  private addWatch(sym: DataSymbol, auto = false): void {
    const key = `g:${sym.addr}`;
    if (this.watches.some((w) => w.key === key)) return;
    const name = shortName(sym.name);
    const scope = name !== sym.name ? sym.name.slice(0, -name.length - 2) : undefined;
    this.watches.push({ key, type: this.globalTypes.get(sym.addr), sym: { ...sym, name }, scope, format: "dec", history: [], changed: false, auto });
  }

  private async writeWatch(w: Watch, text: string): Promise<void> {
    const value = w.format === "float" ? Number(text) : Number(text.trim());
    if (w.stale || !Number.isFinite(value) || w.sym.size > 8) throw new Error(`Can't write "${text}" to ${w.sym.name}`);
    const bytes = new Uint8Array(w.sym.size);
    const dv = new DataView(bytes.buffer);
    if (w.format === "float" && w.sym.size === 4) dv.setFloat32(0, value, true);
    else if (w.format === "float" && w.sym.size === 8) dv.setFloat64(0, value, true);
    else {
      let v = BigInt(Math.trunc(value));
      for (let i = 0; i < bytes.length; i++, v >>= 8n) bytes[i] = Number(v & 0xffn);
    }
    const t = this.target!;
    await this.run(async () => {
      if (this.target !== t || !this.halted) throw new Error("Pause the program to change a value");
      await t.writeMemory(w.sym.addr, bytes);
    });
    this.note(`you set ${w.sym.name} to ${text}`);
    await this.snapshot("you changed a value");
  }

  // ---- the editor ----

  /** Highlight the line of the viewed stop, and fade the lines run just before it. */
  private showExec(reveal: boolean): void {
    this.clearExec();
    const state = this.viewed();
    if (!this.target || !state?.where) return;
    const loc = state.where;
    const model = this.host.sources().find((s) => s.file === loc.file)?.model;
    if (!model || loc.line > model.getLineCount()) return;
    if (reveal) this.host.showFile(loc.file);
    const past = this.lookingBack;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [{
      range: new monaco.Range(loc.line, 1, loc.line, 1),
      options: {
        isWholeLine: true,
        className: past ? "exec-line past" : "exec-line stopped",
        glyphMarginClassName: past ? "exec-glyph past" : "exec-glyph stopped",
        glyphMarginHoverMessage: { value: `${past ? `Step ${state.n} (looking back): next` : "Next"} to run — this line hasn't run yet. (${state.reason})` },
        hoverMessage: { value: "**Next to run** — this line hasn't run yet" },
        minimap: { color: "#ffcc66", position: monaco.editor.MinimapPosition.Inline },
        overviewRuler: { color: "#e2c08d", position: monaco.editor.OverviewRulerLane.Full },
      },
    }];
    // The line that just ran (when this stop came from a step): marked ✓.
    const seen = new Set([loc.line]);
    const ran = this.justRan(state);
    if (ran && ran.file === loc.file && ran.line !== loc.line && ran.line <= model.getLineCount()) {
      decorations.push({
        range: new monaco.Range(ran.line, 1, ran.line, 1),
        options: {
          isWholeLine: true, className: "exec-ran", glyphMarginClassName: "exec-ran-glyph",
          glyphMarginHoverMessage: { value: "Just ran — the step before this stop" }, hoverMessage: { value: "**Just ran** (the step before this stop)" },
        },
      });
      seen.add(ran.line);
    }
    // The trail: distinct lines of the stops before this one, newest first.
    const end = this.viewIndex ?? this.states.length - 1;
    for (let i = end - 1; i >= 0 && seen.size <= TRAIL; i--) {
      const w = this.states[i].where;
      if (!w || w.file !== loc.file || seen.has(w.line) || w.line > model.getLineCount()) continue;
      decorations.push({
        range: new monaco.Range(w.line, 1, w.line, 1),
        options: { isWholeLine: true, className: `exec-trail age-${seen.size}`, hoverMessage: { value: `Ran ${seen.size} stop${seen.size > 1 ? "s" : ""} ago` } },
      });
      seen.add(w.line);
    }
    this.execDecorations = { model, ids: model.deltaDecorations([], decorations) };
    if (reveal && this.host.editor.getModel() === model) this.host.editor.revealLineInCenterIfOutsideViewport(loc.line, monaco.editor.ScrollType.Smooth);
  }

  private clearExec(): void {
    if (this.execDecorations && !this.execDecorations.model.isDisposed()) {
      this.execDecorations.model.deltaDecorations(this.execDecorations.ids, []);
    }
    this.execDecorations = undefined;
  }

  /** The source lines a function spans, from the line table. */
  private lineSpan(funcLo: number): { file: string; first: number; last: number } | undefined {
    if (!this.spans.has(funcLo)) this.spans.set(funcLo, this.computeLineSpan(funcLo));
    return this.spans.get(funcLo);
  }

  private computeLineSpan(funcLo: number): { file: string; first: number; last: number } | undefined {
    const t = this.table;
    const fn = t && functionAt(t, funcLo);
    if (!t || !fn) return undefined;
    let first = Infinity, last = 0, file = "";
    for (let i = 0; i + 2 < t.rows.length; i += 3) {
      const [addr, line, f] = [t.rows[i], t.rows[i + 1], t.rows[i + 2]];
      if (addr < fn.start || addr >= fn.end || line <= 0 || f < 0) continue;
      file = t.files[f];
      first = Math.min(first, line);
      last = Math.max(last, line);
    }
    return last ? { file, first, last } : undefined;
  }

  /** The watch a name refers to on this line of this file: a local of the enclosing function, else a global. */
  private watchFor(name: string, file: string, line: number): Watch | undefined {
    let global: Watch | undefined;
    for (const w of this.watches) {
      if (w.sym.name !== name) continue;
      if (!w.local) global = w;
      else if (w.local.funcLo !== undefined) {
        const span = this.lineSpan(w.local.funcLo);
        if (span && span.file === file && line >= span.first && line <= span.last) return w;
      }
    }
    return global;
  }

  /** Values next to the code that uses them (like Quokka), with what they were before when that differs. */
  private renderInline(): void {
    for (const [model, ids] of this.inlineDecorations) if (!model.isDisposed()) model.deltaDecorations(ids, []);
    this.inlineDecorations.clear();
    if (!this.target) return;
    // Byte dumps (an object of a library class, say) would only clutter the code.
    const names = new Set(this.watches.filter((w) => this.readableValue(w)).map((w) => w.sym.name));
    for (const { file, model } of this.host.sources()) {
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      for (let line = 1; line <= model.getLineCount(); line++) {
        const seen = new Map<string, Watch>();
        for (const m of model.getLineContent(line).matchAll(/[A-Za-z_]\w*/g)) {
          if (!names.has(m[0])) continue;
          const w = this.watchFor(m[0], file, line);
          if (w && this.valuesOf(w).now) seen.set(m[0], w);
        }
        if (!seen.size) continue;
        let changed = false;
        const text = [...seen].map(([name, w]) => {
          const { now, before } = this.valuesOf(w);
          const differs = !!before && !sameBytes(before, now);
          if (differs) changed = true;
          // An object's whole old value would drown the line: only plain values get a "was".
          const was = differs && !this.structType(w.type) ? ` (was ${this.fmtBytes(w, before!)})` : "";
          return `${name} = ${this.inlineValue(w, now!)}${was}`;
        }).join(", ");
        const ws = [...seen.values()];
        const cls = changed ? "jt-inline changed" : ws.every((w) => w.stale) && !this.lookingBack ? "jt-inline stale" : "jt-inline";
        decorations.push({
          range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
          // showIfCollapsed: Monaco drops injected text on an empty range without it.
          options: { after: { content: `  ${text}`, inlineClassName: cls }, showIfCollapsed: true },
        });
      }
      this.inlineDecorations.set(model, model.deltaDecorations([], decorations));
    }
  }

  private hover(model: monaco.editor.ITextModel, pos: monaco.Position): monaco.languages.Hover | undefined {
    const word = model.getWordAtPosition(pos);
    if (!word) return undefined;
    const file = this.host.sources().find((s) => s.model === model)?.file ?? "";
    const w = this.watchFor(word.word, file, pos.lineNumber);
    const sym = w?.sym ?? this.symbols.find((s) => shortName(s.name) === word.word);
    if (!sym) return undefined;
    const info = this.table?.info;
    const type = w?.type !== undefined && info ? typeName(info, w.type) : "";
    const { now, before } = w ? this.valuesOf(w) : {};
    let value: string;
    if (w && now) {
      value = `\`${this.fmtBytes(w, now)}\``;
      if (before && !sameBytes(before, now)) value += ` — was \`${this.fmtBytes(w, before)}\` (${delta(before, now, w.format)})`;
      if (w.stale && !this.lookingBack) value += " _(last value; its function isn't running right now)_";
    } else value = this.target ? "_pause the program to see its value_" : "_connect to the chip to see its value_";
    const changes = w ? this.states.filter((s, i) => i > 0 && s.values.has(w.key) && !sameBytes(s.values.get(w.key), this.states[i - 1].values.get(w.key))).length : 0;
    const where = w?.local && w.local.addr === undefined ? "local variable" : `at 0x${hex(sym.addr)}`;
    return {
      range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
      contents: [{
        value: `**${sym.name}** = ${value}\n\n${type ? `\`${type}\` · ` : ""}${where} · ${sym.size} byte${sym.size === 1 ? "" : "s"}` +
          (changes ? ` · changed at ${changes} of the ${this.states.length} recorded stops` : ""),
      }],
    };
  }

  // ---- the panel ----

  private render(): void {
    this.renderStory();
    this.renderScrubber();
    for (const [t, b] of this.tabButtons) b.classList.toggle("active", t === this.tab);
    // Folded to two lines when the panel is narrow; a click shows it all (and folds it again).
    const help = el("p", `jt-help${this.helpOpen ? " open" : ""}`, TAB_HELP[this.tab]);
    help.title = this.helpOpen ? "Click to fold" : "Click to read it all";
    help.onclick = () => {
      this.helpOpen = !this.helpOpen;
      this.render();
    };
    // Patched in place, not replaced: a text selection survives updates and nothing jumps.
    morphChildren(this.body, [help, ...this.renderTab()]);
  }

  /** One plain-language sentence on what's going on, and what to do next. */
  private renderStory(): void {
    const state = this.viewed();
    const t = this.target;
    const place = (s?: CpuState) => s?.where
      ? `line ${s.where.line} of ${shortFile(s.where.file)}${s.where.func ? `, in ${s.where.func}()` : ""}`
      : s ? "system code with no source (address 0x" + hex(s.pc) + ")" : "";
    const core = (s?: CpuState) => (t && t.coreCount > 1 && s ? ` · CPU core ${s.core}` : "");
    let icon = "", title = "", detail = "", cls = "";
    if (this.connecting) {
      [icon, title, detail] = ["…", "Connecting", "Pick the ESP32-S3 in the browser's list (it shows as “USB JTAG/serial debug unit”)."];
    } else if (!t) {
      [icon, title, detail] = ["⏻", "Not connected",
        "Plug the ESP32-S3 in by its native USB port (often marked “USB”, not “UART”), upload your sketch, then press Connect."];
    } else if (this.lookingBack && state) {
      cls = "past";
      [icon, title] = ["⏪", `Looking back at step ${state.n}: before ${place(state)}`];
      detail = `This is a recording from ${new Date(state.at).toLocaleTimeString()}; ${state.reason}. The chip itself is still at step ${this.states[this.states.length - 1].n}.`;
    } else if (this.autoRunning) {
      [icon, title, detail] = ["⏯", `Auto-stepping${state ? `: now at ${place(state)}` : ""}`,
        "Every step is recorded; use the slider to look back. Press Stop to stay where it is."];
    } else if (this.stepping) {
      [icon, title, detail] = ["⏭", "Running to the next line…", "Press Stop if it takes too long."];
    } else if (!this.halted) {
      [icon, title] = ["▶", "Your program is running"];
      detail = "Press Pause to freeze it and look inside, or click left of a line number to set a breakpoint: it stops there by itself." +
        (this.live.checked ? " Watched values update about once a second." : "");
    } else if (state?.cause === "crash") {
      cls = "crash";
      [icon, title] = ["⚠", `Your program crashed${state.where ? ` at ${place(state)}` : ""}${core(state)}`];
      detail = `Why: ${state.reason.replace(/^the program crashed:? ?/, "") || "ESP-IDF stopped it"}. The Call stack tab shows which of your functions led here. Restart starts the program over.`;
    } else if (state) {
      // The marked line is the next one to run: it hasn't run yet. Say so, and which one just did.
      const ran = this.justRan(state);
      [icon, title] = ["⏸", `Paused before ${place(state)}${core(state)}`];
      detail = `That line hasn't run yet: it runs next. ${ran ? `Line ${ran.line} just ran.` : `Why it stopped: ${state.reason}.`} “Next line” runs it; “Continue” lets the program run on.`;
      if (!state.where) detail = `Why: ${state.reason}. This isn't your code; “Next line” runs until it's back in your code.`;
    } else [icon, title, detail] = ["⏸", "Paused", "Reading the chip…"];
    const head = el("div", "jt-story-title");
    head.append(el("span", "jt-story-icon", icon), el("span", "", title));
    this.story.className = `jt-story ${cls}`;
    this.story.replaceChildren(head, el("div", "jt-story-detail", detail));
    if (this.error) this.story.append(el("div", "jt-story-error", this.error));
  }

  /** Slider over the recorded stops, to look back. */
  /** The scrubber's controls, made once: re-creating the slider while it's dragged would end the drag. */
  private scrubParts?: { range: HTMLInputElement; label: HTMLElement; first: HTMLButtonElement; back: HTMLButtonElement; fwd: HTMLButtonElement; now: HTMLButtonElement };

  private renderScrubber(): void {
    const n = this.states.length;
    this.scrubber.hidden = n < 2;
    if (n < 2) return;
    if (!this.scrubParts) {
      const button = (label: string, title: string, go: () => void) => {
        const b = el("button", "small", label);
        b.title = title;
        b.onclick = go;
        return b;
      };
      const at = () => this.viewIndex ?? this.states.length - 1;
      const range = el("input", "jt-range");
      range.type = "range";
      range.min = "0";
      range.title = "Drag to look back through the recorded stops";
      range.oninput = () => this.viewState(Number(range.value));
      const parts = {
        range,
        label: el("span", "jt-scrub-label"),
        first: button("⏮", "First recorded stop", () => this.viewState(0)),
        back: button("◀", "One stop back", () => this.viewState(at() - 1)),
        fwd: button("▶", "One stop forward", () => this.viewState(at() + 1)),
        now: button("Back to now", "Show the latest stop again", () => this.viewState(undefined)),
      };
      const clear = button("Clear", "Forget the recording", () => {
        this.states = this.states.slice(-1);
        this.timeline = this.timeline.filter((e) => !e.state || e.state === this.states[0]);
        this.viewState(undefined);
      });
      this.scrubber.replaceChildren(el("span", "jt-scrub-title", "Recording"), parts.first, parts.back, range, parts.fwd, parts.label, parts.now, clear);
      this.scrubParts = parts;
    }
    const { range, label, first, back, fwd, now } = this.scrubParts;
    const index = this.viewIndex ?? n - 1;
    range.max = String(n - 1);
    range.value = String(index);
    first.disabled = back.disabled = index === 0;
    fwd.disabled = index >= n - 1;
    now.disabled = !this.lookingBack;
    const s = this.states[index];
    label.textContent = `step ${s.n} of ${this.states[n - 1].n}${s.where ? ` · line ${s.where.line}` : ""}`;
  }

  private renderTab(): HTMLElement[] {
    // Memory and Pins read the chip itself; the other tabs need the build's debug info.
    if (!this.table && this.tab !== "Memory" && this.tab !== "Pins") {
      return [el("p", "jt-empty", "Build or flash your program with this panel open, so the inspector knows your variables, lines and machine code.")];
    }
    switch (this.tab) {
      case "Variables": return this.variablesTab();
      case "Call stack": return this.stackTab();
      case "Registers": return this.registersTab();
      case "Memory": return this.memoryTab();
      case "Pins": return this.pinsTab();
      case "Program": return this.programTab();
      case "History": return this.historyTab();
    }
  }

  private variablesTab(): HTMLElement[] {
    // The search text lives in the inspector, not the input: the panel is patched in place, so
    // handlers must not hold on to elements of one particular render.
    const search = el("input", "jt-input");
    search.placeholder = "Watch another variable: type its name…";
    search.value = this.varQuery;
    search.oninput = (e) => {
      this.varQuery = (e.currentTarget as HTMLInputElement).value;
      this.render();
    };
    const results = el("div", "jt-results");
    {
      const q = this.varQuery.trim().toLowerCase();
      const locals = (q ? (this.table?.info?.vars ?? []).filter((v) => v.func && v.fbreg !== undefined && v.type >= 0 && v.name.toLowerCase().includes(q)) : []).slice(0, 15);
      const globals = (q ? this.symbols.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 30) : []);
      const entries: { label: string; add: () => void }[] = [
        ...locals.map((v) => ({ label: `${v.name}  — inside ${v.func}()`, add: () => this.addLocal(v) })),
        ...globals.map((s) => ({ label: `${s.name}  — global, ${s.size} bytes`, add: () => this.addWatch(s) })),
      ];
      results.replaceChildren(...entries.map((e) => {
        const row = el("button", "jt-result", e.label);
        row.title = "Watch this variable";
        row.onclick = () => {
          e.add();
          this.varQuery = "";
          if (this.halted && !this.lookingBack) void this.snapshot("you added a variable");
          else this.render();
        };
        return row;
      }));
    }
    const table = el("table", "jt-table jt-vars jt-fixed");
    const head = el("tr");
    for (const [label, title] of [
      ["Variable", ""], ["Now", "The value at this stop"], ["Before", "The value at the stop before"],
      ["Change", "How it moved since the stop before"], ["Recent values", "Its last values, oldest on the left"], ["", ""],
    ]) {
      const th = el("th", "", label);
      th.title = title;
      head.append(th);
    }
    table.append(head);
    const info = this.table?.info;
    for (const w of this.watches) {
      const { now, before } = this.valuesOf(w);
      const changed = !!now && !!before && !sameBytes(now, before);
      const stale = w.stale && !this.lookingBack;
      const name = el("td", "jt-name");
      const st = this.structType(w.type);
      if (st) {
        const open = this.expanded.has(w.key);
        const toggle = el("button", "jt-toggle", open ? "▾" : "▸");
        toggle.title = open ? "Hide its members" : "Show its members, with what each is for";
        toggle.onclick = () => {
          if (open) this.expanded.delete(w.key);
          else this.expanded.add(w.key);
          this.render();
        };
        const line = el("span", "");
        line.append(toggle, w.sym.name);
        name.append(line);
      } else name.append(el("span", "", w.sym.name));
      const kind = `${info && w.type !== undefined ? typeName(info, w.type) : `${w.sym.size} bytes`}${w.local?.func ? ` · in ${w.local.func}()` : w.scope ? ` · kept by ${w.scope}()` : ""}`;
      name.append(el("span", "jt-kind", kind));
      // An object reads better as its short summary; its members are one click away.
      const shown = (b: Uint8Array) => (st ? this.inlineValue(w, b) : this.fmtBytes(w, b));
      const value = el("td", changed ? "jt-value changed" : stale || w.error ? "jt-value stale" : "jt-value", now ? shown(now) : this.noValue(w));
      value.title = w.error ? `Couldn't read it: ${w.error}` : stale ? "Last value; its function isn't running right now" : this.lookingBack ? "Recorded value" : "Click to change the value on the chip";
      value.onclick = () => {
        if (this.lookingBack) return;
        const text = prompt(`New value for ${w.sym.name}`, w.bytes && w.sym.size <= 8 ? String(toNumber(w.bytes, true)) : "");
        if (text !== null && this.target && this.halted) void this.writeWatch(w, text).catch((e) => this.fail(e));
      };
      const was = el("td", "jt-before", before ? (st ? (changed ? "changed (expand ▸)" : "") : this.fmtBytes(w, before)) : "");
      const change = el("td", changed ? "jt-delta changed" : "jt-delta", now && before ? (changed ? delta(before, now, w.format) : "same") : "");
      const format = el("select", "jt-format");
      format.title = "Show as a decimal number, hexadecimal or a floating-point number";
      for (const f of ["dec", "hex", "float"] as Format[]) format.add(new Option(f, f, false, f === w.format));
      format.onchange = (e) => {
        w.format = (e.currentTarget as HTMLSelectElement).value as Format;
        this.render();
        this.renderInline();
      };
      const spark = el("td");
      spark.append(this.sparkline(this.lookingBack ? this.recordedHistory(w) : w.history));
      const mem = el("button", "small", "⌖");
      mem.title = w.sym.addr ? `Show its bytes in Memory (0x${hex(w.sym.addr)})` : "Show its bytes in Memory";
      mem.onclick = () => this.openMemory(w.sym.addr, w.sym.size);
      const remove = el("button", "small", "×");
      remove.title = "Stop watching";
      remove.onclick = () => {
        this.watches = this.watches.filter((x) => x !== w);
        this.dismissed.add(w.key);
        this.render();
        this.renderInline();
      };
      const actions = el("td", "jt-actions");
      actions.append(format, mem, remove);
      const tr = el("tr", changed ? "changed" : "");
      tr.append(name, value, was, change, spark, actions);
      table.append(tr);
      if (st && now) table.append(...this.objectRows(w, st, now, before));
    }
    const out: HTMLElement[] = [search, results, table];
    if (!this.watches.length) out.push(el("p", "jt-empty", "No variables yet. Pause the program to see the ones in use, or type a name above."));
    else if (!this.halted && this.target && !this.live.checked) out.push(el("p", "jt-empty", "Pause (or switch on Live values) to see the values. Click a value to change it."));
    return out;
  }

  /**
   * Under an object's row: the library's summary of it (when there is one), and when expanded,
   * each member with its value, what it was before, and its documentation from the source.
   */
  private objectRows(w: Watch, st: StructType, now: Uint8Array, before: Uint8Array | undefined): HTMLElement[] {
    const info = this.table!.info!;
    const rows: HTMLElement[] = [];
    const summary = this.summary(w, now);
    if (summary) {
      const tr = el("tr", "jt-summary");
      const td = el("td");
      td.colSpan = 6;
      td.append(el("span", "jt-muted", `${st.name}: `), summary.text);
      for (const s of summary.swatches ?? []) {
        const sw = el("span", "jt-swatch");
        sw.style.background = s.color;
        sw.title = s.label;
        td.append(el("span", "jt-muted", " · "), sw, el("span", "jt-muted", s.label.replace(/ \(the colour.*$/, "")));
      }
      tr.append(td);
      rows.push(tr);
    }
    if (!this.expanded.has(w.key)) return rows;
    if (st.doc) {
      const tr = el("tr", "jt-member");
      const td = el("td", "jt-muted");
      td.colSpan = 6;
      td.textContent = st.doc;
      tr.append(td);
      rows.push(tr);
    }
    for (const m of st.members) {
      const size = typeSize(info, m.type);
      const slice = (b?: Uint8Array) => b && b.length >= m.off + size ? b.subarray(m.off, m.off + size) : undefined;
      const [mNow, mBefore] = [slice(now), slice(before)];
      const text = (b?: Uint8Array) => (b ? formatTyped(info, m.type, b) : "");
      const changed = !!mNow && !!mBefore && !sameBytes(mNow, mBefore);
      const tr = el("tr", `jt-member${changed ? " changed" : ""}`);
      const name = el("td", "jt-name");
      name.append(el("span", "", m.name), el("span", "jt-kind", `${typeName(info, m.type)} · offset ${m.off}${m.doc ? ` · ${m.doc}` : ""}`));
      const value = el("td", changed ? "jt-value changed" : "jt-value", text(mNow));
      const mt = strip(info, m.type);
      if (mt?.k === "ptr" && mNow) {
        const addr = this.memberNum(m, now) ?? 0;
        const target = this.lookingBack ? undefined : w.follow?.get(m.name);
        const where = this.describe(addr);
        value.textContent = `${text(mNow)}${where ? ` ${where}` : ""}`;
        if (target) value.append(el("div", "jt-muted", `points to: ${[...target].map((b) => hex(b, 2)).join(" ")}`));
        value.title = this.explainValue(addr);
      }
      const delta = mNow && mBefore ? (changed ? (mNow.length <= 8 && mt?.k === "base" ? (() => {
        const d = (this.memberNum(m, now) ?? 0) - (this.memberNum(m, before!) ?? 0);
        return d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "changed";
      })() : "changed") : "same") : "";
      tr.append(name, value, el("td", "jt-before", text(mBefore)), el("td", changed ? "jt-delta changed" : "jt-delta", delta), el("td"), el("td"));
      rows.push(tr);
    }
    return rows;
  }

  /** A watch's recorded values up to the stop being viewed. */
  private recordedHistory(w: Watch): number[] {
    const end = (this.viewIndex ?? this.states.length - 1) + 1;
    return this.states.slice(Math.max(0, end - HISTORY), end).map((s) => s.values.get(w.key)).filter((b): b is Uint8Array => !!b && b.length <= 8).map((b) => toNumber(b, true));
  }

  /** What a value did over the last stops, as a tiny line chart. */
  private sparkline(h: number[]): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "jt-spark");
    svg.setAttribute("viewBox", "0 0 80 16");
    if (h.length > 1) {
      const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
      const line = document.createElementNS(ns, "polyline");
      line.setAttribute("points", h.map((v, i) => `${(i / (h.length - 1)) * 80},${15 - ((v - min) / span) * 14}`).join(" "));
      svg.append(line);
      const title = document.createElementNS(ns, "title");
      title.textContent = `${h.length} values, from ${min} to ${max}`;
      svg.append(title);
    }
    return svg;
  }

  private openMemory(addr: number, size: number): void {
    this.memory.addr = addr >>> 0;
    this.memory.length = Math.max(16, Math.min(512, Math.ceil(size / 16) * 16));
    this.memory.bytes = this.memory.prev = undefined;
    this.memory.words = undefined;
    this.memory.from = undefined;
    this.tab = "Memory";
    const t = this.target;
    if (t && this.halted) {
      void this.run(async () => {
        if (this.target === t && this.halted) await this.readMemoryView(t);
      }).then(() => this.render()).catch((e) => this.fail(e));
    } else this.render();
  }

  /**
   * Read what the Memory tab shows. For a peripheral, the registers of that block, one by one,
   * leaving out the ones whose reading would change the hardware's state (a receive FIFO).
   */
  private async readMemoryView(t: DebugTarget): Promise<void> {
    const per = regionAt(this.memory.addr)?.kind === "peripheral" ? peripheralAt(this.memory.addr) : undefined;
    if (per) {
      const prev = this.memory.words;
      this.memory.words = await this.readWords(t, per.regs.map((r) => r.addr));
      this.memory.prevWords = prev;
      this.memory.bytes = this.memory.prev = undefined;
      return;
    }
    this.memory.words = undefined;
    this.memory.prev = this.memory.bytes;
    try {
      this.memory.bytes = await t.readMemory(this.memory.addr, this.memory.length);
    } catch (e) {
      this.memory.bytes = this.memory.prev = undefined;
      throw e;
    }
  }

  /**
   * Read 32-bit words at these (word-aligned) addresses: contiguous runs in one go, registers
   * with read side effects skipped, and a run that fails retried word by word so one bad
   * address doesn't hide the rest.
   */
  private async readWords(t: DebugTarget, addrs: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const sorted = [...new Set(addrs)].filter((a) => safeToRead(a)).sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 4) j++;
      const put = (b: Uint8Array, from: number) => {
        const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        for (let k = 0; k * 4 < b.length; k++) out.set(from + k * 4, dv.getUint32(k * 4, true));
      };
      try {
        put(await t.readMemory(sorted[i], (j - i + 1) * 4), sorted[i]);
      } catch {
        for (let k = i; k <= j; k++) await t.readMemory(sorted[k], 4).then((b) => put(b, sorted[k])).catch(() => {});
      }
      i = j + 1;
    }
    return out;
  }

  /** Places worth a look, for someone who doesn't know the memory map yet: the suggestions shown before anything is typed. */
  private memoryPlaces(): MemoryPlace[] {
    return [
      { label: "Your variables", kind: "RAM", detail: "The RAM where your global variables are", go: () => this.openMemory(this.symbols.find((s) => this.globalTypes.has(s.addr))?.addr ?? 0x3fc88000, 128), addr: this.symbols.find((s) => this.globalTypes.has(s.addr))?.addr ?? 0x3fc88000 },
      ...([
        ["GPIO", 0x60004000, "Pin output/input/enable registers"], ["IO MUX", 0x60009000, "Per-pin configuration: function, pull-ups, drive strength"],
        ["UART0", 0x60000000, "Serial port 0"], ["Timer group 0", 0x6001f000, "Hardware timers and the task watchdog"],
        ["System timer", 0x60023000, "The 16 MHz clock behind millis()"], ["LEDC (PWM)", 0x60019000, "analogWrite's PWM channels"],
        ["RTC control", 0x60008000, "Power, sleep, reset reasons"], ["eFuse", 0x60007000, "Factory data: MAC address, chip revision"],
      ] as [string, number, string][]).map(([label, addr, detail]) => ({ label, kind: "peripheral", detail, addr, go: () => this.openPeripheral(addr, "") })),
    ];
  }

  /**
   * Everything matching a search, best first: an address, then names that are the search, start
   * with it or contain it (peripherals, registers, variables, memory regions), then things whose
   * description mentions it.
   */
  private searchMemory(q: string): MemoryPlace[] {
    const ql = q.toLowerCase().trim();
    if (!ql) return this.memoryPlaces();
    const found: (MemoryPlace & { score: number })[] = [];
    const n = Number(ql);
    if (/^(0x)?[0-9a-f]+$/.test(ql) && Number.isFinite(n) && ql.length >= 3) {
      const a = (ql.startsWith("0x") ? n : parseInt(ql, 16)) >>> 0;
      found.push({ label: `0x${hex(a)}`, kind: "address", detail: regionAt(a)?.name ?? "not mapped", addr: a, go: () => this.openMemory(a, this.memory.length), score: 100 });
    }
    // How well a name matches: whole name, start of the name or of a word in it, anywhere.
    const nameScore = (name: string) => {
      const nl = name.toLowerCase().replace(/_reg$/, "");
      if (nl === ql) return 90;
      if (nl.startsWith(ql)) return 80;
      if (new RegExp(`(^|[_ (])${ql.replace(/[^a-z0-9]/g, "")}`).test(nl)) return 60;
      return nl.includes(ql) ? 50 : 0;
    };
    const descScore = (text?: string) => (text?.toLowerCase().includes(ql) ? 20 : 0);
    for (const p of soc()?.peripherals ?? []) {
      const score = Math.max(nameScore(p.title) + 5, descScore(p.intro));
      if (score > 5) found.push({ label: p.title, kind: "peripheral", detail: p.intro || `registers at 0x${hex(p.base)}`, addr: p.base, go: () => this.openPeripheral(p.base, ""), score });
    }
    for (const r of REGIONS) {
      const score = Math.max(nameScore(r.name), descScore(r.explain));
      if (r.kind !== "peripheral" && score) found.push({ label: r.name, kind: "memory", detail: `0x${hex(r.lo)}–0x${hex(r.hi - 1)}`, addr: r.lo, go: () => this.openMemory(r.lo, this.memory.length), score });
    }
    for (const s of this.symbols) {
      const score = nameScore(shortName(s.name));
      if (score) found.push({ label: shortName(s.name), kind: "variable", detail: `${s.size} bytes at 0x${hex(s.addr)}`, addr: s.addr, go: () => this.openMemory(s.addr, s.size), score: score - 2 });
    }
    for (const p of soc()?.peripherals ?? []) {
      for (const r of p.regs) {
        const score = Math.max(nameScore(r.name), descScore(r.desc));
        if (score) found.push({ label: r.name.replace(/_REG$/, ""), kind: p.title, detail: r.desc, addr: r.addr, go: () => this.openPeripheral(p.base, r.name.replace(/_REG$/, "")), score: score - 1 });
      }
    }
    found.sort((x, y) => y.score - x.score);
    return found;
  }

  private memoryTab(): HTMLElement[] {
    const current = `0x${hex(this.memory.addr)}`;
    const typing = this.memory.query !== "" && this.memory.query !== current;
    const search = el("input", "jt-input jt-search");
    search.value = typing ? this.memory.query : current;
    search.placeholder = "Search: an address, a peripheral, a register, a variable…";
    search.title = "Type an address (0x…), or words to search all peripherals, registers (names and descriptions), memory regions and variables";
    const results = this.searchMemory(typing ? this.memory.query : "");
    search.oninput = (e) => {
      this.memory.query = (e.currentTarget as HTMLInputElement).value;
      this.render();
    };
    search.onkeydown = (e) => {
      if (e.key === "Enter" && results[0]) {
        this.memory.query = "";
        results[0].go();
      } else if (e.key === "Escape") {
        this.memory.query = "";
        this.render();
      }
    };
    const bar = el("div", "jt-memory-bar");
    bar.append(search);
    if (this.memory.from) {
      const from = this.memory.from;
      const back = el("button", "small", `← Back to ${from}`);
      back.onclick = () => {
        this.memory.from = undefined;
        this.tab = from;
        this.render();
      };
      bar.prepend(back);
    }
    // Suggestions before anything's typed (the one being shown highlighted), matches while typing.
    const jumps = el("div", typing ? "jt-search-results" : "jt-jumps");
    // Matches: the best ones, and how many there are in all.
    const shown = typing ? results.slice(0, SEARCH_SHOWN) : results;
    if (typing && results.length) {
      jumps.append(el("div", "jt-search-count", results.length > shown.length
        ? `${results.length} matches; the best ${shown.length} first. Type more to narrow it down (e.g. “gpio_out”, “uart0”, an address).`
        : `${results.length} match${results.length === 1 ? "" : "es"}`));
    }
    for (const r of shown) {
      const active = !typing && r.addr !== undefined && (r.addr === this.memory.addr || (r.kind === "peripheral" && peripheralAt(this.memory.addr)?.base === r.addr && regionAt(this.memory.addr)?.kind === "peripheral"));
      const b = el("button", `${typing ? "jt-result" : "small"}${active ? " active" : ""}`);
      if (typing) b.append(el("span", "", r.label), el("span", "jt-kind", ` ${r.kind} · ${r.detail}`));
      else b.textContent = r.label;
      b.title = `${r.detail}${r.addr !== undefined ? ` (0x${hex(r.addr)})` : ""}`;
      b.onclick = () => {
        this.memory.query = "";
        r.go();
      };
      jumps.append(b);
    }
    if (typing && !results.length) jumps.append(el("p", "jt-empty", "Nothing matches."));
    const out: HTMLElement[] = [bar, jumps, this.regionCard(this.memory.addr)];
    const words = this.memory.words;
    const per = regionAt(this.memory.addr)?.kind === "peripheral" ? peripheralAt(this.memory.addr) : undefined;
    if (per) out.push(...this.registerTable(per, words));
    else out.push(this.wordTable());
    return out;
  }

  /** What this part of the address space is, in a few sentences. */
  private regionCard(addr: number): HTMLElement {
    const card = el("div", "jt-card");
    const region = regionAt(addr);
    if (!region) {
      card.append(el("b", "", "Nothing here"), el("p", "", "This address isn't mapped to any memory or peripheral on the ESP32-S3: reading it would fail."));
      return card;
    }
    const per = region.kind === "peripheral" ? peripheralAt(addr) : undefined;
    card.append(el("b", "", per ? `${per.title} — peripheral registers at 0x${hex(per.base)}` : `${region.name}: 0x${hex(region.lo)}–0x${hex(region.hi - 1)}`));
    card.append(el("p", "", per?.intro || region.explain));
    if (per) card.append(el("p", "jt-muted", region.explain));
    if (region.alias) {
      const other = (addr + region.alias.delta) >>> 0;
      const p = el("p", "jt-muted", `The same bytes also appear at 0x${hex(other)} (${region.alias.name}). `);
      const link = el("a", "jt-link", "Show there");
      link.onclick = () => this.openMemory(other, this.memory.length);
      p.append(link);
      card.append(p);
    }
    if (region.wordOnly) card.append(el("p", "jt-muted", "On this bus the CPU can only read whole, aligned 32-bit words."));
    if (!soc() && region.kind === "peripheral") card.append(el("p", "jt-muted", "Loading the register descriptions…"));
    return card;
  }

  /** Memory as 32-bit words, each explained: a number, a pointer to something, text. */
  private wordTable(): HTMLElement {
    const bytes = this.memory.bytes;
    const box = el("div", "jt-words");
    if (!bytes) {
      box.append(el("p", "jt-empty", this.halted ? "Press Show." : "Pause the program, then press Show."));
      return box;
    }
    const table = el("table", "jt-table jt-wordtable jt-fixed");
    const head = el("tr");
    for (const [h, title] of [["Address", ""], ["Bytes", "As stored in memory: the lowest address first (little-endian)"], ["As a 32-bit number", "The four bytes read as one number (the ESP32-S3 is little-endian, so the last byte is the most significant)"], ["Means", "What the number could be: a pointer to something, or text"], ["Variable", "The variable stored here"]]) {
      const th = el("th", "", h);
      th.title = title;
      head.append(th);
    }
    table.append(head);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let o = 0; o + 4 <= bytes.length; o += 4) {
      const at = this.memory.addr + o;
      const v = dv.getUint32(o, true);
      const changed = this.memory.prev && this.memory.prev.length === bytes.length && new DataView(this.memory.prev.buffer, this.memory.prev.byteOffset).getUint32(o, true) !== v;
      const tr = el("tr", changed ? "changed" : "");
      const raw = [...bytes.subarray(o, o + 4)].map((b) => hex(b, 2)).join(" ");
      const text = [...bytes.subarray(o, o + 4)].every((b) => b >= 32 && b < 127) ? ` "${String.fromCharCode(...bytes.subarray(o, o + 4))}"` : "";
      const owner = this.symbols.find((s) => at >= s.addr && at < s.addr + s.size);
      // Inside an object: which member, and what the library's source says it's for.
      const st = owner && this.structType(this.globalTypes.get(owner.addr));
      const member = st?.members.filter((m) => m.off <= at - owner!.addr && !m.name.startsWith("(")).pop();
      // The members that live in these four bytes (small ones are packed together).
      const off0 = owner ? at - owner.addr : 0;
      const inWord = st?.members.filter((m) => !m.name.startsWith("(") && m.off >= off0 && m.off < off0 + 4) ?? [];
      const num = el("td", "jt-byte", `0x${hex(v)}`);
      num.title = `${v} unsigned, ${v | 0} signed${changed ? `; was 0x${hex(new DataView(this.memory.prev!.buffer, this.memory.prev!.byteOffset).getUint32(o, true))}` : ""}`;
      const info = this.table?.info;
      const memberValues = info && inWord.length && !(inWord.length === 1 && strip(info, inWord[0].type)?.k === "ptr")
        ? inWord.map((m) => `${m.name} = ${formatTyped(info, m.type, bytes.subarray(o + m.off - off0, o + m.off - off0 + typeSize(info, m.type)))}`).join(", ")
        : "";
      const means = memberValues || this.describe(v, true) || (v < 0x10000 ? `${v}` : "") + text;
      const meansCell = el("td", "jt-owner", means);
      meansCell.title = this.explainValue(v);
      tr.append(el("td", "jt-addr", hex(at)), el("td", "jt-muted", raw), num, meansCell,
        (() => {
          if (!owner) return el("td");
          const off = at - owner.addr;
          const names = inWord.length ? inWord.map((m) => m.name).join(", ") : member ? `${member.name}${off !== member.off ? ` + ${off - member.off}` : ""}` : "";
          const td = el("td", "", names ? `${shortName(owner.name)}.${names}` : `${shortName(owner.name)}${off ? ` + ${off}` : ""}`);
          for (const m of inWord.length ? inWord : member ? [member] : []) if (m.doc) td.append(el("div", "jt-kind", `${m.name}: ${m.doc}`));
          return td;
        })());
      table.append(tr);
    }
    box.append(table);
    return box;
  }

  /** A peripheral's registers with their values, decoded into fields, and what to watch out for. */
  private registerTable(per: Peripheral, words: Map<number, number> | undefined): HTMLElement[] {
    if (!words) return [el("p", "jt-empty", this.halted ? "Press Show to read the registers." : "Pause the program, then press Show.")];
    const filter = el("input", "jt-input");
    filter.placeholder = `Filter ${per.regs.length} registers…`;
    filter.value = this.memory.filter;
    const table = el("table", "jt-table jt-regtable jt-fixed");
    const head = el("tr");
    for (const h of ["Register", "Value", "What it says", ""]) head.append(el("th", "", h));
    const fill = () => {
      const q = filter.value.trim().toUpperCase();
      this.memory.filter = filter.value;
      table.replaceChildren(head);
      for (const reg of per.regs) {
        if (q && !reg.name.includes(q) && !reg.desc.toUpperCase().includes(q)) continue;
        const value = words.get(reg.addr);
        const before = this.memory.prevWords?.get(reg.addr);
        const changed = value !== undefined && before !== undefined && before !== value;
        const tr = el("tr", changed ? "changed" : "");
        const name = el("td", "jt-name");
        name.append(el("span", "", reg.name.replace(/_REG$/, "")), el("span", "jt-kind", `0x${hex(reg.addr)} · ${reg.desc}`));
        const notes = registerNotes(reg);
        const val = el("td", changed ? "jt-byte changed" : "jt-byte", value === undefined ? "not read" : `0x${hex(value)}`);
        if (changed) val.title = `was 0x${hex(before!)}`;
        const says = el("td", "jt-fields");
        if (value !== undefined) {
          const decoded = decodeRegister(reg, value, (a) => words.get(a));
          // Single-field registers: just the value; otherwise the fields that aren't 0 (all on hover).
          const shown = decoded.length <= 1 ? decoded : decoded.filter((d) => d.value !== 0 || d.field.name === "baud rate");
          for (const d of shown.slice(0, 8)) {
            const f = el("div", "jt-field");
            // Drop the peripheral's prefix (UART_CLKDIV_FRAG → CLKDIV_FRAG), not a field's own first word (MCU_SEL).
            const prefix = `${reg.name.split("_")[0]}_`;
            const fname = d.field.name.startsWith(prefix) && !reg.name.startsWith("IO_MUX_") ? d.field.name.slice(prefix.length) : d.field.name;
            f.append(el("span", "jt-fname", fname), el("span", "", ` = ${d.text}`));
            f.title = `${d.field.name} (bits ${d.field.hi === d.field.lo ? d.field.lo : `${d.field.hi}:${d.field.lo}`}, ${accessMeaning(d.field.access)})${d.field.desc ? `\n${d.field.desc}` : ""}`;
            says.append(f);
          }
          if (shown.length > 8) says.append(el("div", "jt-muted", `… ${shown.length - 8} more (hover the register)`));
          if (!shown.length && decoded.length) says.append(el("span", "jt-muted", "all fields 0"));
          says.title = decoded.map((d) => `${d.field.name} = ${d.text}`).join("\n");
        } else if (readSideEffect(reg)) says.append(el("span", "jt-warn", `Not read: ${readSideEffect(reg)}.`));
        const info = el("td", "jt-note");
        if (notes.length || reg.fields.some((f) => f.access !== "R/W")) {
          const access = [...new Set(reg.fields.map((f) => f.access))].map((a) => `${a}: ${accessMeaning(a)}`).join("\n");
          info.textContent = "ⓘ";
          info.title = [...notes, access && `Access types:\n${access}`].filter(Boolean).join("\n\n");
          if (notes.length) info.classList.add("has-notes");
        }
        tr.append(name, val, says, info);
        table.append(tr);
      }
    };
    filter.oninput = (e) => {
      this.memory.filter = (e.currentTarget as HTMLInputElement).value;
      this.render();
    };
    fill();
    const legend = el("p", "jt-muted", "ⓘ marks registers that don't simply hold a setting: write-only shortcuts that read as 0, snapshots that need a refresh, flags the hardware sets or clears by itself. Hover it for details; hover a field for its bit range and meaning.");
    return [filter, table, legend];
  }

  /** What a 32-bit value is, as a full sentence (tooltips). */
  private explainValue(value: number): string {
    const short = this.describe(value, false);
    const region = regionAt(value >>> 0);
    const reg = region?.kind === "peripheral" ? registerAt(value) : undefined;
    const parts = [`0x${hex(value)} = ${value >>> 0} (unsigned) = ${value | 0} (signed)`];
    if (/return address/.test(short)) {
      parts.push(`As a return address: the top two bits (${value >>> 30}) say it was a CALL${(value >>> 30) * 4} (the Xtensa windowed call ABI); the code address is 0x${hex(((value & 0x3fffffff) | 0x40000000) >>> 0)}. ${short.replace(/^→ return address,? ?/, "").replace(/^\(CALL\d+\) /, "")}`);
    } else if (short === "not an address") parts.push("Not an address on the ESP32-S3: just a number.");
    else if (short) parts.push(`As an address: ${short.replace(/^→ /, "")}.`);
    if (reg) parts.push(`${reg.name}: ${reg.desc}`);
    else if (region && !/return address/.test(short)) parts.push(`That's ${region.name}: ${region.explain}`);
    return parts.join("\n");
  }

  /**
   * What a 32-bit value points at, in a few words: a line of code, a variable, a register, or the
   * kind of memory. `pointerOnly`: say nothing for values that don't look like an address.
   */
  private describe(value: number, pointerOnly = true): string {
    const table = this.table;
    const top = value >>> 30;
    // Xtensa return addresses carry the call size (CALL4/8/12) in their top 2 bits.
    const code = table && top !== 0 && locateExact(table, ((value & 0x3fffffff) | 0x40000000) >>> 0);
    if (code) return `→ ${top >= 2 ? "return address, " : ""}${code.func ? code.func + "() " : ""}line ${code.line}`;
    const sym = this.symbols.find((s) => value >= s.addr && value < s.addr + s.size);
    if (sym) return `→ variable ${shortName(sym.name)}${value !== sym.addr ? ` + ${value - sym.addr}` : ""}`;
    // A return address of a CALL8/CALL12 into code without source (a library, the system).
    const ra = ((value & 0x3fffffff) | 0x40000000) >>> 0;
    if (top >= 2 && regionAt(ra)?.kind !== "peripheral" && (ra >= 0x42000000 || (ra >= 0x40000000 && ra < 0x403e0000))) {
      return `→ return address (CALL${top * 4}) into ${ra >= 0x42000000 ? "library or system code" : "ROM or IRAM code"}`;
    }
    const region = regionAt(value >>> 0);
    if (!region) return pointerOnly ? "" : "not an address";
    if (region.kind === "peripheral") {
      const reg = registerAt(value);
      return reg ? `→ register ${reg.name.replace(/_REG$/, "")}` : `→ ${peripheralAt(value)?.title ?? "peripheral"} registers`;
    }
    if (region.kind === "ram") {
      const sp = this.viewed()?.ar[1];
      if (sp !== undefined && value >= sp && value < sp + 0x2000) return "→ on this task's stack";
      if (value >= 0x40000000) return "→ code in RAM (IRAM)";
      // Statics (.data/.bss) come first in RAM; above the last one is the heap, where ESP-IDF
      // also allocates each task's stack.
      const staticEnd = Math.max(0, ...this.symbols.filter((s) => s.addr >= 0x3fc88000 && s.addr < 0x3fd00000).map((s) => s.addr + s.size));
      return value < staticEnd ? "→ RAM: static data" : "→ RAM: the heap (malloc/new, task stacks)";
    }
    if (region.kind === "flash") return value >= 0x42000000 ? "→ code in flash (not yours: a library or the system)" : "→ constant data in flash";
    if (region.kind === "rom") return "→ boot ROM";
    return "→ RTC memory (kept in deep sleep)";
  }

  // ---- the program ----

  /** A name for an address in the disassembly: a function (+ offset) or a variable. */
  private nameOf(addr: number): string | undefined {
    const f = this.program && funcAt(this.program, addr);
    if (f) return addr === f.addr ? f.name : `${f.name}+${addr - f.addr}`;
    const sym = this.symbols.find((s) => addr >= s.addr && addr < s.addr + s.size);
    return sym ? `${shortName(sym.name)}${addr !== sym.addr ? `+${addr - sym.addr}` : ""}` : undefined;
  }

  private programTab(): HTMLElement[] {
    const p = this.program;
    if (!p) return [el("p", "jt-empty", "Build the sketch (with the inspector open) to see its machine code.")];
    const pc = this.viewed()?.pc;
    const at = this.programAt ?? pc;
    const out: HTMLElement[] = [];

    // Find a function by name, or an address.
    const bar = el("div", "jt-memory-bar");
    const find = el("input", "jt-input");
    find.placeholder = "Show a function (name) or an address (0x…)";
    find.value = this.programQuery;
    find.oninput = (e) => {
      this.programQuery = (e.currentTarget as HTMLInputElement).value;
      this.render();
    };
    const list = el("div", "jt-results");
    {
      const q = this.programQuery.trim().toLowerCase();
      const hits = q.length < 2 ? [] : p.funcs.filter((f) => f.name.toLowerCase().includes(q)).slice(0, 20);
      list.replaceChildren(...hits.map((f) => {
        const b = el("button", "jt-result", `${f.name}  ${hex(f.addr)} · ${f.size} bytes`);
        b.onclick = () => {
          this.programAt = f.addr;
          this.programQuery = "";
          this.render();
        };
        return b;
      }));
    }
    find.onkeydown = (e) => {
      const v = Number((e.currentTarget as HTMLInputElement).value.trim());
      if (e.key === "Enter" && Number.isFinite(v)) {
        this.programQuery = "";
        this.programAt = v >>> 0;
        this.render();
      }
    };
    bar.append(find);
    if (this.programAt !== undefined && pc !== undefined) {
      const back = el("button", "small", "Back to where the CPU is");
      back.onclick = () => {
        this.programAt = undefined;
        this.render();
      };
      bar.append(back);
    }
    out.push(bar, list, this.fileMap(p, pc, at));

    if (at === undefined) {
      out.push(el("p", "jt-empty", "Pause the program to see where it is, or pick a function above."));
      return out;
    }
    const section = codeAt(p, at);
    const fn = funcAt(p, at);
    if (!section) {
      out.push(el("p", "jt-empty", `0x${hex(at)} isn't in the program's code${regionAt(at) ? ` (it's in ${regionAt(at)!.name})` : ""}. Code from the boot ROM isn't part of app.bin.`));
      return out;
    }
    // A whole function (from its start, so instructions line up); a window around `at` otherwise.
    const start = fn ? fn.addr : Math.max(section.addr, at - 96);
    const end = fn ? Math.min(fn.addr + fn.size, start + 6000) : Math.min(section.addr + section.size, at + 160);
    const ctx = { word: (a: number) => wordAt(p, a), name: (a: number) => this.nameOf(a), describe: (v: number) => this.addressMeaning(v) };
    const insns = disassemble(section.data, section.addr, start, end, ctx);
    const user = fn && this.table && functionAt(this.table, fn.addr);
    out.push(el("div", "jt-section jt-asm-head", fn
      ? `${fn.name}() — ${insns.length} instructions, ${fn.size} bytes at 0x${hex(fn.addr)} in ${section.name}${user ? " · your code" : " · not your code (a library or the system)"}`
      : `Code around 0x${hex(at)} in ${section.name} (not in a known function)`));
    out.push(this.asmTable(p, insns, pc));
    return out;
  }

  /** app.bin as a strip of its segments, with where the CPU (and the shown code) is in it. */
  private fileMap(p: Program, pc: number | undefined, at: number | undefined): HTMLElement {
    const card = el("div", "jt-card");
    if (!p.segments.length) {
      card.append(el("p", "", "The file layout isn't known for this build."));
      return card;
    }
    const where = pc === undefined ? undefined : fileOffsetOf(p, pc);
    const head = el("p");
    head.append(el("b", "", "app.bin"), ` — ${p.appSize.toLocaleString()} bytes, written to flash at 0x${hex(p.flashOffset)}. `);
    if (pc !== undefined) {
      head.append(where
        ? `The CPU is at 0x${hex(pc)}, which is byte 0x${hex(where.offset)} (${where.offset.toLocaleString()}) of the file — flash address 0x${hex(p.flashOffset + where.offset)} — in segment ${where.segment + 1}.`
        : `The CPU is at 0x${hex(pc)}, which isn't in the file (${regionAt(pc)?.name ?? "unknown memory"}: the boot ROM, or code ESP-IDF copied elsewhere).`);
    }
    card.append(head);
    const strip = el("div", "jt-filemap");
    const total = p.segments.reduce((n, s) => n + s.length, 0) || 1;
    p.segments.forEach((s, i) => {
      const region = regionAt(s.load);
      const kind = region?.kind === "flash" ? (s.load >= 0x42000000 ? "code in flash" : "constants in flash") : region?.kind === "ram" ? (s.load >= 0x40000000 ? "code copied to RAM" : "data copied to RAM") : region?.name ?? "other";
      const seg = el("div", `jt-seg ${region?.kind ?? ""} ${s.load >= 0x40000000 && region?.kind !== "rtc" ? "code" : ""}`);
      seg.style.flexGrow = String(Math.max(s.length / total, 0.02));
      seg.append(el("span", "", `${i + 1}`));
      seg.title = `Segment ${i + 1}: ${kind}\nloaded at 0x${hex(s.load)}–0x${hex(s.load + s.length)}\nfile bytes 0x${hex(s.fileOffset)}–0x${hex(s.fileOffset + s.length)} (${s.length.toLocaleString()} bytes)\n${region?.explain ?? ""}`;
      for (const [addr, cls] of [[pc, "pc"], [at !== pc ? at : undefined, "shown"]] as const) {
        if (addr === undefined || addr < s.load || addr >= s.load + s.length) continue;
        const mark = el("div", `jt-seg-mark ${cls}`);
        mark.style.left = `${((addr - s.load) / s.length) * 100}%`;
        mark.title = cls === "pc" ? `The CPU: 0x${hex(addr)}` : `Shown below: 0x${hex(addr)}`;
        seg.append(mark);
      }
      strip.append(seg);
    });
    card.append(strip, el("p", "jt-muted", "Each block is a segment of the file: hover for where it's loaded. Flash segments are read in place through the cache; RAM segments are copied to RAM by the bootloader at start-up."));
    return card;
  }

  /** What a value is if it's an address, in words: a function, a variable, a hardware register, a kind of memory. */
  private addressMeaning(v: number): string | undefined {
    const p = this.program;
    const f = p && funcAt(p, v);
    if (f) return v === f.addr ? `the address of function ${f.name}` : `an address inside function ${f.name}`;
    const reg = regionAt(v)?.kind === "peripheral" ? registerAt(v) : undefined;
    if (reg) return `the address of hardware register ${reg.name} (${reg.desc}) of ${reg.peripheral.title}`;
    const sym = this.symbols.find((s) => v >= s.addr && v < s.addr + s.size);
    if (sym) return `the address of variable ${shortName(sym.name)}${v !== sym.addr ? ` + ${v - sym.addr}` : ""}`;
    const region = regionAt(v);
    return region && v >= 0x3c000000 ? `an address in ${region.name}` : undefined;
  }

  /** Where to look at an address: the Program view for code, the Memory tab for the rest. */
  private showAddress(v: number): void {
    const p = this.program;
    if (p && codeAt(p, v)) {
      this.programAt = v;
      this.render();
      return;
    }
    const reg = regionAt(v)?.kind === "peripheral" ? registerAt(v) : undefined;
    if (reg) return this.openPeripheral(reg.peripheral.base, reg.name.replace(/_REG$/, ""));
    this.memory.from = undefined;
    const from = this.tab;
    this.openMemory(v, 64);
    this.memory.from = from;
    this.render();
  }

  /**
   * Follow constants through straight-line code, to say which address a load or store touches
   * ("a8 + 0 = 0x60004010, GPIO_OUT1_REG"): L32R/MOVI/MOV/ADDI set a register to a known value,
   * anything else that writes it (or a branch target, or a call) forgets it. A small,
   * conservative version of what a compiler's constant propagation does.
   */
  private constantAddresses(insns: Insn[]): Map<number, number> {
    const p = this.program!;
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
        const v = wordAt(p, i.literal);
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

  /** The instructions, with the source line each belongs to as a heading where it changes. */
  private asmTable(p: Program, insns: Insn[], pc: number | undefined): HTMLElement {
    const table = el("table", "jt-table jt-asm");
    const head = el("tr");
    for (const [h, t] of [["Address", "Where the instruction is on the chip"], ["File", "Its position in app.bin"], ["Bytes", "The instruction as stored (2 or 3 bytes; 4 for vector instructions)"], ["Instruction", "Xtensa assembly"], ["What it does", ""]]) {
      const th = el("th", "", h);
      th.title = t;
      head.append(th);
    }
    table.append(head);
    const sources = new Map(this.host.sources().map((s) => [s.file, s.model]));
    const touched = this.constantAddresses(insns);
    // Register values per instruction: at the stop being viewed (the instruction about to run),
    // and for earlier stops of the recording at an instruction of this list (before it ran).
    const viewedIndex = this.viewIndex ?? this.states.length - 1;
    const viewed = this.states[viewedIndex];
    const recorded = new Map<number, number>();
    for (let k = 0; k <= viewedIndex; k++) recorded.set(this.states[k].pc, k);
    const justRanPc = viewed?.stepped && viewedIndex > 0 ? this.states[viewedIndex - 1].pc : undefined;
    let lastLine = "";
    for (const i of insns) {
      const loc = this.table && locateExact(this.table, i.addr);
      const key = loc ? `${loc.file}:${loc.line}` : "";
      if (loc && key !== lastLine) {
        const model = sources.get(loc.file);
        const text = model && loc.line <= model.getLineCount() ? model.getLineContent(loc.line).trim() : "";
        const tr = el("tr", "jt-asm-src");
        const td = el("td", "", `${shortFile(loc.file)}:${loc.line}   ${text}`);
        td.colSpan = 5;
        tr.append(td);
        table.append(tr);
      }
      lastLine = key;
      const tr = el("tr", i.addr === pc ? "current" : i.addr === justRanPc ? "just-ran" : "");
      const off = fileOffsetOf(p, i.addr);
      const ins = el("td", "jt-asm-ins");
      ins.append(el("span", "jt-asm-mn", i.mnemonic), " ");
      if (i.target !== undefined && codeAt(p, i.target)) {
        const link = el("a", "jt-link", i.operands);
        link.title = "Show this destination";
        link.onclick = () => {
          this.programAt = i.target;
          this.render();
        };
        ins.append(link);
      } else ins.append(i.operands);
      tr.append(
        (() => {
          const td = el("td", "jt-addr", `${i.addr === pc ? "▶ " : i.addr === justRanPc ? "✓ " : ""}${hex(i.addr)}`);
          if (i.addr === pc) td.title = "Next to run: this instruction hasn't run yet";
          else if (i.addr === justRanPc) td.title = "Just ran: the instruction(s) before this stop";
          return td;
        })(),
        el("td", "jt-muted", off ? hex(off.offset, 5) : ""),
        el("td", "jt-muted", i.bytes.map((b) => hex(b, 2)).join(" ")),
        ins,
        this.explainCell(p, i, touched.get(i.addr), this.registerValues(i, recorded.get(i.addr), viewedIndex)),
      );
      tr.title = `${loc ? `${shortFile(loc.file)} line ${loc.line} · ` : ""}file offset ${off ? `0x${hex(off.offset, 5)}` : "—"} · bytes ${i.bytes.map((x) => hex(x, 2)).join(" ")}`;
      if (loc) {
        tr.onmouseenter = () => this.highlightSource(loc.file, loc.line);
        tr.onmouseleave = () => this.highlightSource();
      }
      table.append(tr);
    }
    return table;
  }

  /**
   * The explanation of an instruction, with the address it uses (an L32R constant, or the address
   * a load/store touches) spelled out and linked to where it can be looked at.
   */
  /**
   * The values of the registers an instruction uses, from a recorded stop at it: before it ran,
   * and (when the next stop is one instruction later) what it changed.
   */
  private registerValues(i: Insn, k: number | undefined, viewedIndex: number): HTMLElement | undefined {
    if (k === undefined) return undefined;
    const regs = [...new Set(i.operands.match(/\ba(?:1[0-5]|[0-9])\b/g) ?? [])];
    if (!regs.length) return undefined;
    const state = this.states[k];
    const val = (v: number) => {
      const short = v < 0x10000 ? String(v) : `0x${hex(v)}`;
      const means = this.describe(v);
      return `${short}${means ? ` ${means}` : ""}`;
    };
    const box = el("div", "jt-asm-regs");
    const when = k === viewedIndex ? "now, before it runs" : `at step ${state.n}, before it ran`;
    box.append(el("span", "jt-muted", `${when}: `), regs.map((r) => `${r} = ${val(state.ar[Number(r.slice(1))])}`).join(" · "));
    const next = this.states[k + 1];
    if (next && k + 1 <= viewedIndex && next.stepped && next.reason === "one instruction ran") {
      const changed = [...Array(16).keys()].filter((n) => next.ar[n] !== state.ar[n]);
      if (changed.length) box.append(el("div", "", `then: ${changed.map((n) => `a${n} = ${val(next.ar[n])}`).join(" · ")}`));
    }
    return box;
  }

  private explainCell(p: Program, i: Insn, touches: number | undefined, regs?: HTMLElement): HTMLElement {
    const td = el("td", "jt-asm-explain", i.explain);
    if (regs) td.append(regs);
    const value = i.literal !== undefined ? wordAt(p, i.literal) : undefined;
    const addr = touches ?? (value !== undefined && this.addressMeaning(value) ? value : undefined);
    if (touches !== undefined) {
      const store = /^s/.test(i.mnemonic);
      const meaning = this.addressMeaning(touches);
      td.append(el("div", "jt-asm-note", `${store ? "Writes to" : "Reads"} 0x${hex(touches)}${meaning ? `: ${meaning.replace(/^the address of /, "")}` : ""}${regionAt(touches)?.kind === "peripheral" ? (store ? " — this changes what the hardware does" : " — the hardware's current state") : ""}.`));
    }
    if (addr !== undefined) {
      const link = el("a", "jt-link", regionAt(addr)?.kind === "peripheral" ? "Show this register" : codeAt(p, addr) ? "Show this code" : "Show this memory");
      link.onclick = () => this.showAddress(addr);
      td.append(" ", link);
    }
    return td;
  }

  /** Mark a source line in the editor while an instruction of it is hovered (no argument: clear). */
  private highlightSource(file?: string, line?: number): void {
    if (this.asmHover && !this.asmHover.model.isDisposed()) this.asmHover.model.deltaDecorations(this.asmHover.ids, []);
    this.asmHover = undefined;
    if (!file || !line) return;
    const model = this.host.sources().find((s) => s.file === file)?.model;
    if (!model || line > model.getLineCount()) return;
    if (this.host.editor.getModel() !== model) this.host.showFile(file);
    this.asmHover = {
      model,
      ids: model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "jt-asm-source", overviewRuler: { color: "#4fc1ff", position: monaco.editor.OverviewRulerLane.Full } } }]),
    };
    this.host.editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
  }

  // ---- pins ----

  private pins?: { words: Map<number, number>; prev?: Map<number, number>; samples: PinSample[] };

  /** The registers the Pins tab needs: GPIO matrix bitmasks, each pin's output routing and pad setup. */
  private pinAddresses(): number[] {
    const db = soc();
    if (!db) return [];
    const addrs = [...PIN_LEVEL_REGS, SYSCLK_CONF, CPU_PER_CONF];
    for (const g of GPIOS) {
      addrs.push(0x60004554 + 4 * g); // GPIO_FUNCg_OUT_SEL_CFG_REG
      const pad = db.iomux[String(g)];
      if (pad) addrs.push(0x60009000 + pad.off);
    }
    return addrs;
  }

  /**
   * Read the pins. `levelsOnly` (Live values): just the six bitmask registers, so the pause stays
   * short. Every read is also a sample for the pins' history, stamped with the CPU's cycle counter.
   */
  /** The level of a pin in a sample: what it's driven to if it's an output, else what it reads. */
  private pinLevel(s: PinSample, g: number): number | undefined {
    const hi = g < 32 ? 0 : 1, b = g & 31;
    const [out, en, inp] = [s.levels[hi], s.levels[2 + hi], s.levels[4 + hi]];
    if (en === undefined) return undefined;
    const v = (en >>> b) & 1 ? out : inp;
    return v === undefined ? undefined : (v >>> b) & 1;
  }

  /** A pin's levels over the recorded samples; each sample says when it was taken, in clock cycles. */
  private pinSparkline(g: number): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "jt-pinspark");
    svg.setAttribute("viewBox", "0 0 120 14");
    const samples = this.pins?.samples ?? [];
    const width = 120 / PIN_HISTORY;
    const first = samples[0]?.cycles;
    // Looking back: outline the sample of the viewed stop, dim the ones after it.
    const viewedN = this.lookingBack ? this.viewed()?.n : undefined;
    const viewedAt = viewedN === undefined ? -1 : samples.findIndex((x) => x.state === viewedN);
    samples.forEach((s, i) => {
      const level = this.pinLevel(s, g);
      const rect = document.createElementNS(ns, "rect");
      if (i === viewedAt) rect.classList.add("viewed");
      else if (viewedAt >= 0 && i > viewedAt) rect.classList.add("later");
      if (s.state !== undefined) {
        rect.classList.add("stop");
        (rect as unknown as { onclick: () => void }).onclick = () => this.viewState(this.states.findIndex((x) => x.n === s.state));
      }
      rect.setAttribute("x", String(120 - (samples.length - i) * width));
      rect.setAttribute("width", String(width - 0.4));
      rect.setAttribute("y", level ? "1" : "11");
      rect.setAttribute("height", level ? "12" : "2");
      rect.classList.add(level === undefined ? "unknown" : level ? "high" : "low");
      const title = document.createElementNS(ns, "title");
      const p = samples[i - 1];
      const parts = [`GPIO${g} ${level === undefined ? "not read" : level ? "high" : "low"}`];
      if (s.cycles !== undefined) {
        parts.push(`at CPU cycle ${s.cycles.toLocaleString()} (CCOUNT${first !== undefined ? `, ${((s.cycles - first) >>> 0).toLocaleString()} after the first sample` : ""})`);
        if (p?.cycles !== undefined) {
          const d = (s.cycles - p.cycles) >>> 0;
          parts.push(`${d.toLocaleString()} cycles after the sample before${s.hz ? ` = ${(d / s.hz * 1000).toFixed(3)} ms at ${s.hz / 1e6} MHz` : ""}`);
        }
      }
      parts.push(`${s.state !== undefined ? `step ${s.state} (click to look back at it) · ` : "a Live values read · "}${new Date(s.at).toLocaleTimeString()}`);
      title.textContent = parts.join("\n");
      rect.append(title);
      svg.append(rect);
    });
    return svg;
  }

  /** Show a peripheral's registers in the Memory tab, filtered (to a channel, say). */
  private openPeripheral(base: number, filter: string): void {
    const from = this.tab;
    this.memory.filter = filter;
    this.openMemory(base, 64);
    this.memory.from = from === "Memory" ? undefined : from;
    this.render();
  }

  private async readPins(t: DebugTarget, levelsOnly = false): Promise<PinSample> {
    if (!soc()) await loadSoc();
    const fresh = await this.readWords(t, levelsOnly ? PIN_LEVEL_REGS : this.pinAddresses());
    const words = new Map([...(this.pins?.words ?? []), ...fresh]);
    const cycles = await t.readCycleCount().catch(() => undefined);
    const sample: PinSample = { at: Date.now(), cycles, hz: cpuHz(words.get(SYSCLK_CONF), words.get(CPU_PER_CONF)), levels: PIN_LEVEL_REGS.map((a) => words.get(a)) };
    const samples = [...(this.pins?.samples ?? []), sample].slice(-PIN_HISTORY);
    this.pins = { words, prev: this.pins?.words, samples };
    return sample;
  }

  private pinsTab(): HTMLElement[] {
    const db = soc();
    if (!db) return [el("p", "jt-empty", "Loading the pin descriptions…")];
    if (!this.pins) {
      const read = el("button", "dbg", "Read the pins");
      read.disabled = !this.halted;
      read.onclick = () => {
        const t = this.target;
        if (!t) return;
        void this.run(async () => {
          if (this.target === t && this.halted) await this.readPins(t);
        }).then(() => this.render()).catch((e) => this.fail(e));
      };
      return [el("p", "jt-empty", this.halted ? "" : "Pause the program to read the pins."), read];
    }
    // Looking back: the levels from the sample taken at that stop (the pins' setup rarely changes,
    // so that part stays the latest read).
    const viewedN = this.lookingBack ? this.viewed()?.n : undefined;
    const samples = this.pins.samples;
    const vs = viewedN === undefined ? undefined : samples.find((x) => x.state === viewedN);
    const asMap = (x?: PinSample) => new Map(PIN_LEVEL_REGS.flatMap((a, i) => (x?.levels[i] === undefined ? [] : [[a, x.levels[i]!] as [number, number]])));
    const w = vs ? new Map([...this.pins.words, ...asMap(vs)]) : this.pins.words;
    const prev = vs ? asMap(samples[samples.indexOf(vs) - 1]) : this.pins.prev;
    const note = viewedN === undefined ? undefined
      : vs ? el("p", "jt-muted", `Pin levels as recorded at step ${viewedN}; “changed” compares with the read before it.`)
      : el("p", "jt-warn", `The pins weren't read at step ${viewedN}, so these are the latest levels. Stops are recorded with the pins while this tab is open.`);
    const bit = (m: Map<number, number> | undefined, lo: number, hi: number, g: number) => {
      const v = m?.get(g < 32 ? lo : hi);
      return v === undefined ? undefined : (v >>> (g & 31)) & 1;
    };
    const table = el("table", "jt-table jt-pins jt-fixed");
    const head = el("tr");
    for (const [h, title] of [
      ["GPIO", "Click a number for the pin's own configuration registers (IO MUX)"],
      ["Direction", "Output: the chip drives the pin (GPIO_ENABLE). Input: its level is read (IO MUX FUN_IE). Driven by a peripheral: through the GPIO matrix (FUNCn_OUT_SEL) or straight from the IO MUX (MCU_SEL); click its name for its registers. Plus the internal pull resistor (IO MUX FUN_PU/FUN_PD, about 45 kΩ)"],
      ["History", "The level at each read of the pins (each stop, or every Live values update), oldest left. Hover a sample for when it was taken, in CPU clock cycles"],
      ["Level", "Driven: what GPIO_OUT asks for. Reads: GPIO_IN, the level actually on the pin"],
      ["Drive", "Output drive strength (IO MUX FUN_DRV)"], ["Note", ""],
    ]) {
      const th = el("th", "", h);
      th.title = title;
      head.append(th);
    }
    table.append(head);
    for (const g of GPIOS) {
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
      // Direction, with what drives the pin and its pull resistor: "output from RMT_SIG_OUT0", "input, pull-up".
      const pull = pu ? "pull-up" : pd ? "pull-down" : "";
      const peripheral = !viaMatrix ? func : connected !== "GPIO" ? connected : undefined;
      const dirWord = !viaMatrix ? "set by" : oe ? (peripheral ? "output from" : "output") : ie ? "input" : "off";
      let level = "";
      if (oe && viaMatrix && (sig === 256 || sig === undefined)) level = `driven ${out ? "high" : "low"}`;
      else if (oe) level = "driven by the peripheral";
      if (ie && inp !== undefined) level += `${level ? ", " : ""}reads ${inp ? "high" : "low"}`;
      const conflict = oe && ie && (sig === 256) && out !== undefined && inp !== undefined && out !== inp;
      const changed = (inBefore !== undefined && inBefore !== inp) || (outBefore !== undefined && outBefore !== out);
      const tr = el("tr", `${changed ? "changed" : ""}${!oe && !ie && viaMatrix ? " off" : ""}`);
      const num = el("td", "jt-addr jt-link", String(g));
      num.title = `Show GPIO${g}'s pad register (IO MUX)`;
      num.onclick = () => this.openPeripheral(0x60009000, `GPIO${g}_`);
      const dirCell = el("td");
      dirCell.title = connectedTitle;
      dirCell.append(dirWord);
      if (peripheral) {
        const target = signalPeripheral(peripheral);
        dirCell.append(" ");
        if (target) {
          const a = el("a", "jt-link", peripheral);
          a.onclick = () => this.openPeripheral(target.base, target.filter);
          a.title = `${connectedTitle}\nClick to see the registers of ${target.label}${target.filter ? ` (${target.filter})` : ""}.`;
          dirCell.append(a);
        } else dirCell.append(peripheral);
      }
      if (pull) dirCell.append(`, ${pull}`);
      const lvl = el("td", conflict ? "jt-warn" : "", conflict ? `${level} — it should read ${out ? "high" : "low"}: shorted, or overloaded?` : level || "—");
      lvl.prepend(el("span", `jt-dot ${(oe ? out : inp) ? "high" : "low"}`));
      const hist = el("td");
      hist.append(this.pinSparkline(g));
      tr.append(num, dirCell, hist, lvl,
        el("td", "jt-muted", mux === undefined || !oe ? "" : DRIVE_LABEL[(mux >>> 10) & 3]),
        el("td", "jt-muted", pinNote(g)));
      table.append(tr);
    }
    const reread = el("button", "small", "Read again");
    reread.onclick = () => {
      const t = this.target;
      if (t && this.halted) void this.run(() => this.readPins(t)).then(() => this.render()).catch((e) => this.fail(e));
    };
    return note ? [note, table, reread] : [table, reread];
  }

  private stackTab(): HTMLElement[] {
    const state = this.viewed();
    const table = this.table!;
    if (!state) return [el("p", "jt-empty", "Pause the program to see the call stack.")];
    const out: HTMLElement[] = [];
    const frame = (label: string, pc: number, cls = "") => {
      const loc = locateExact(table, pc);
      const row = el("div", `jt-frame ${cls}`);
      row.append(el("span", "jt-frame-name", loc ? `${loc.func ?? "?"}()` : label), el("span", "jt-muted", loc ? `${shortFile(loc.file)} line ${loc.line}` : `0x${hex(pc)}`));
      if (loc) {
        row.classList.add("jt-link");
        row.title = "Show this line";
        row.onclick = () => {
          this.host.showFile(loc.file);
          this.host.editor.revealLineInCenter(loc.line);
          this.host.editor.setPosition({ lineNumber: loc.line, column: 1 });
        };
      }
      return row;
    };
    out.push(el("div", "jt-section", "Where it is, and how it got there"));
    out.push(frame("system code", state.pc, "current"));
    // Callers from the unwinder (return addresses, so look up the call just before them).
    // Runs of frames without source collapse into one "system code" row.
    let system = false;
    for (const ra of (state.calls ?? []).slice(1)) {
      if (locateExact(table, ra - 3)) {
        out.push(frame("", ra - 3, "caller"));
        system = false;
      } else if (!system) {
        out.push(frame("system code (Arduino, ESP-IDF or a library)", ra - 3, "caller"));
        system = true;
      }
    }
    if (!state.stack) return [...out, el("p", "jt-empty", "The stack memory couldn't be read at this stop.")];

    // Stack memory, compared with the stop before and with the whole recording (by address).
    const prev = this.previous();
    const prevAt = new Map<number, number>();
    prev?.stack?.words.forEach((v, i) => prevAt.set(prev.stack!.base + i * 4, v));
    const end = this.viewIndex ?? this.states.length - 1;
    out.push(el("div", "jt-section", `Stack memory, from the stack pointer 0x${hex(state.stack.base)}${prev?.stack && prev.stack.base !== state.stack.base ? ` (it moved by ${state.stack.base - prev.stack.base} bytes since the stop before)` : ""}`));
    const grid = el("table", "jt-table jt-stack");
    const head = el("tr");
    for (const h of ["Address", "Now", "Before", "Means", "Changes in the recording"]) head.append(el("th", "", h));
    grid.append(head);
    state.stack.words.forEach((w, i) => {
      const addr = state.stack!.base + i * 4;
      const before = prevAt.get(addr);
      const changed = before !== undefined && before !== w;
      // How often this word changed across the recorded stops up to this one.
      let changes = 0, lastChange = 0, last: number | undefined;
      for (let s = Math.max(0, end - 200); s <= end; s++) {
        const st = this.states[s].stack;
        if (!st || addr < st.base || addr >= st.base + st.words.length * 4) { last = undefined; continue; }
        const v = st.words[(addr - st.base) / 4];
        if (last !== undefined && v !== last) { changes++; lastChange = this.states[s].n; }
        last = v;
      }
      const tr = el("tr", changed ? "changed" : "");
      tr.append(
        el("td", "jt-addr", `${hex(addr)}${i === 0 ? " ← sp" : ""}`),
        el("td", changed ? "jt-byte changed" : "jt-byte", hex(w)),
        el("td", "jt-before", changed ? hex(before!) : ""),
        (() => {
          const td = el("td", "jt-owner", this.describe(w));
          td.title = this.explainValue(w);
          return td;
        })(),
        el("td", "jt-muted", changes ? `${changes}× · last at step ${lastChange}` : ""),
      );
      grid.append(tr);
    });
    out.push(grid);
    return out;
  }

  private registersTab(): HTMLElement[] {
    const state = this.viewed();
    if (!state) return [el("p", "jt-empty", "Pause the program to see the registers.")];
    const prev = this.previous();
    const end = this.viewIndex ?? this.states.length - 1;
    const recent = this.states.slice(Math.max(0, end - 15), end + 1);
    const grid = el("div", "jt-regs");
    const regs: [string, (s: CpuState) => number][] = [["pc", (s) => s.pc], ...state.ar.map((_, i) => [`a${i}`, (s: CpuState) => s.ar[i]] as [string, (s: CpuState) => number])];
    for (const [name, get] of regs) {
      const value = get(state);
      const before = prev && get(prev);
      const changed = before !== undefined && before !== value;
      const cell = el("div", changed ? "jt-reg changed" : "jt-reg");
      const top = el("div", "jt-reg-top");
      top.append(el("span", "jt-regname", name), el("span", "jt-role", ROLE_SHORT[name] ?? ""), el("span", changed ? "jt-byte changed" : "jt-byte", hex(value)));
      if (value < 1e6) top.append(el("span", "jt-muted", `= ${value}`));
      else if ((value | 0) < 0 && (value | 0) > -1e6) top.append(el("span", "jt-muted", `= ${value | 0}`));
      cell.append(top);
      const means = this.describe(value);
      const sub = el("div", "jt-reg-sub", changed ? `was ${hex(before!)}${means ? "  " + means : ""}` : means);
      cell.append(sub);
      // The register's recent values, one cell per stop; a mark where it changed.
      const strip = el("div", "jt-strip");
      recent.forEach((s, i) => {
        const v = get(s);
        const moved = i > 0 && get(recent[i - 1]) !== v;
        const c = el("span", moved ? "moved" : "");
        c.title = `step ${s.n}: ${hex(v)}`;
        c.onclick = () => this.viewState(this.states.indexOf(s));
        strip.append(c);
      });
      cell.append(strip);
      cell.title = `${name}: ${REGISTER_ROLES[name] ?? "working register: holds whatever the code is busy with"}\n\n${this.explainValue(value)}`;
      grid.append(cell);
    }
    const out: HTMLElement[] = [grid];

    // The trace: per stop, the line and the registers that changed.
    if (this.states.length > 1) {
      out.push(el("div", "jt-section", "What changed at each recorded stop"));
      const table = el("table", "jt-table jt-trace");
      const head = el("tr");
      for (const h of ["Step", "Line", "Registers that changed"]) head.append(el("th", "", h));
      table.append(head);
      for (let i = end; i > Math.max(0, end - 40); i--) {
        const s = this.states[i], p = this.states[i - 1];
        const diffs = regs.filter(([n, get]) => n !== "pc" && get(s) !== get(p)).map(([n, get]) => `${n} ${hex(get(p))}→${hex(get(s))}`);
        const tr = el("tr", i === end ? "current jt-link" : "jt-link");
        tr.onclick = () => this.viewState(i);
        tr.append(
          el("td", "", String(s.n)),
          el("td", "", s.where ? `${s.where.func ?? ""} ${s.where.line}` : hex(s.pc)),
          el("td", "jt-muted", diffs.join(", ") || "—"),
        );
        table.append(tr);
      }
      out.push(table);
    }
    return out;
  }

  private historyTab(): HTMLElement[] {
    if (!this.timeline.length) return [el("p", "jt-empty", "Every stop and every change of a watched variable is recorded here.")];
    const viewed = this.viewed();
    return [...this.timeline].reverse().slice(0, 500).map((entry) => {
      const row = el("div", entry.state ? `jt-entry stop${entry.state === viewed ? " current" : ""}` : "jt-entry");
      const where = entry.loc ? `line ${entry.loc.line}${entry.loc.func ? ` in ${entry.loc.func}()` : ""}` : "";
      row.append(
        el("span", "jt-time", new Date(entry.at).toLocaleTimeString()),
        el("span", "jt-step", entry.state ? `step ${entry.state.n}` : ""),
        el("span", "", entry.text),
        el("span", "jt-muted", where),
      );
      const loc = entry.loc;
      if (entry.state || loc) {
        row.classList.add("jt-link");
        row.title = entry.state ? "Look back at this moment" : "Show this line";
        row.onclick = () => {
          const i = entry.state ? this.states.indexOf(entry.state) : -1;
          if (i >= 0) return this.viewState(i);
          if (!loc) return;
          this.host.showFile(loc.file);
          this.host.editor.revealLineInCenter(loc.line);
        };
      }
      return row;
    });
  }
}
