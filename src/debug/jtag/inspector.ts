/**
 * The hardware inspector: a DevTools-style panel under the editor, driven over
 * USB-JTAG, that also draws into the Monaco editor itself — the running line,
 * live values next to the code that uses them, and values on hover.
 */
import * as monaco from "monaco-editor";
import {
  type DataSymbol, type LineTable, type SourceLocation,
  dataSymbols, functionAt, locateExact,
} from "../line-table";
import type { DebugTarget, Registers } from "./target";

type Format = "dec" | "hex" | "float";

interface Watch {
  sym: DataSymbol;
  format: Format;
  /** Last values, oldest first (at most HISTORY). */
  history: number[];
  bytes?: Uint8Array;
  changed: boolean;
  auto: boolean;
}

interface TimelineEntry {
  at: number;
  text: string;
  loc?: SourceLocation;
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
}

const HISTORY = 40;
/** Live mode: longest intended pause, shortest gap between pauses, and gap as a multiple of the last pause. */
const LIVE_BUDGET_MS = 100;
const LIVE_MIN_GAP_MS = 1000;
const LIVE_DUTY = 20;
const MAX_AUTO = 16;
const STACK_WORDS = 48;
const MAX_STEPS = 4000;
const TABS = ["Variables", "Memory", "Stack", "Registers", "Timeline"] as const;
type Tab = (typeof TABS)[number];

const hex = (n: number, width = 8) => (n >>> 0).toString(16).padStart(width, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function formatValue(w: Watch): string {
  const b = w.bytes;
  if (!b) return "—";
  if (b.length > 8) return [...b.subarray(0, 16)].map((x) => hex(x, 2)).join(" ") + (b.length > 16 ? " …" : "");
  if (w.format === "hex") return "0x" + [...b].reverse().map((x) => hex(x, 2)).join("");
  if (w.format === "float" && (b.length === 4 || b.length === 8)) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const f = b.length === 4 ? dv.getFloat32(0, true) : dv.getFloat64(0, true);
    return Number(f.toPrecision(7)).toString();
  }
  return String(toNumber(b, true));
}

export class JtagInspector {
  private target?: DebugTarget;
  private table?: LineTable;
  private symbols: DataSymbol[] = [];
  private watches: Watch[] = [];
  private halted = false;
  private regs?: Registers;
  private stack?: { base: number; words: number[]; prev?: number[] };
  private memory = { addr: 0x3fc88000, length: 128, bytes: undefined as Uint8Array | undefined, prev: undefined as Uint8Array | undefined };
  private timeline: TimelineEntry[] = [];
  private where?: SourceLocation;
  private tab: Tab = "Variables";
  private queue: Promise<unknown> = Promise.resolve();
  private polling = false;
  private execDecoration?: { model: monaco.editor.ITextModel; ids: string[] };
  private readonly inlineDecorations = new Map<monaco.editor.ITextModel, string[]>();

  private readonly status = el("span", "jt-status", "Not connected");
  private readonly buttons: Record<string, HTMLButtonElement> = {};
  private readonly body = el("div", "jt-body");
  private readonly tabButtons = new Map<Tab, HTMLButtonElement>();
  private readonly live = el("input");
  private readonly verbose = el("input");

  constructor(private readonly root: HTMLElement, private readonly host: InspectorHost, private readonly createTarget: () => DebugTarget) {
    root.classList.add("jtag-panel");
    const bar = el("div", "jt-bar");
    const add = (id: string, label: string, title: string, action: () => Promise<void>) => {
      const b = el("button", "dbg", label);
      b.title = title;
      b.onclick = () => void action().catch((e) => this.fail(e));
      this.buttons[id] = b;
      bar.append(b);
    };
    add("connect", "Connect JTAG", "Connect to the ESP32-S3's native USB port over WebUSB", () => this.toggleConnection());
    add("pause", "Pause", "Halt the CPU, or continue after a stop", () => (this.halted ? this.resume() : this.pause()));
    add("line", "Step", "Run to the next source line, also inside calls to your own functions", () => this.stepLine(false));
    add("over", "Step over", "Run to the next source line without stopping inside calls", () => this.stepLine(true));
    add("insn", "Step instruction", "Execute exactly one machine instruction", () => this.stepInstruction());
    this.live.type = "checkbox";
    const liveLabel = el("label", "check");
    liveLabel.title = "Briefly pause the CPU (under 100 ms, at most every second) to refresh watched variables while the program runs; pauses are kept short";
    liveLabel.append(this.live, " Live");
    this.live.onchange = () => void this.livePoll();
    this.verbose.type = "checkbox";
    this.verbose.checked = true;
    const verboseLabel = el("label", "check");
    verboseLabel.title = "Log every USB transfer, TAP scan and debug-register access to the browser's developer console (for bug reports)";
    verboseLabel.append(this.verbose, " Verbose");
    const close = el("button", "small", "×");
    close.title = "Close the hardware inspector";
    close.onclick = () => (root.hidden = true);
    bar.append(liveLabel, verboseLabel, this.status, close);
    bar.title = "Drag the toolbar to the left, right or bottom edge of the editor to dock the panel there";
    bar.classList.add("jt-drag");
    bar.onpointerdown = (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("button, label, input")) return;
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
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    };
    const tabs = el("div", "jt-tabs");
    for (const t of TABS) {
      const b = el("button", "jt-tab", t);
      b.onclick = () => {
        this.tab = t;
        this.render();
      };
      this.tabButtons.set(t, b);
      tabs.append(b);
    }
    root.append(bar, tabs, this.body);
    this.render();

    for (const language of ["c", "cpp"]) {
      monaco.languages.registerHoverProvider(language, { provideHover: (model, pos) => this.hover(model, pos) });
    }
    host.editor.onDidChangeModel(() => this.renderInline());
  }

  show(): void {
    this.root.hidden = false;
  }

  /** The symbols of the build now on the chip. */
  attach(table: LineTable | undefined): void {
    this.table = table;
    this.symbols = table ? dataSymbols(table) : [];
    this.watches = [];
    this.timeline = [];
    this.memory.bytes = this.memory.prev = undefined;
    this.stack = undefined;
    this.discoverGlobals();
    this.render();
  }

  get connected(): boolean {
    return !!this.target;
  }

  // ---- connection and run control ----

  private fail(e: unknown): void {
    const message = (e as Error).message ?? String(e);
    this.status.textContent = message;
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
      this.target = undefined;
      this.halted = false;
      await this.run(() => t.disconnect().catch(() => {}));
      this.clearExec();
      this.setState("Not connected");
      return;
    }
    const target = this.createTarget();
    const start = performance.now();
    target.setTrace((line) => {
      if (this.verbose.checked) console.log(`[jtag ${((performance.now() - start) / 1000).toFixed(3)}] ${line}`);
    });
    this.status.textContent = "Connecting…";
    await target.connect();
    this.target = target;
    this.host.log(`JTAG connected: ${target.name}`, "ok");
    await this.run(async () => {
      this.halted = await target.isHalted();
    });
    if (this.halted) await this.snapshot();
    else void this.pollForStop();
    this.setState(this.halted ? "Paused" : "Running");
  }

  private setState(text: string): void {
    this.status.textContent = text;
    this.buttons.connect.textContent = this.target ? "Disconnect JTAG" : "Connect JTAG";
    this.buttons.pause.textContent = this.halted ? "Continue" : "Pause";
    for (const id of ["pause", "line", "over", "insn"]) this.buttons[id].disabled = !this.target;
    for (const id of ["line", "over", "insn"]) this.buttons[id].disabled = !this.target || !this.halted;
    this.render();
  }

  private async pause(): Promise<void> {
    await this.run(async () => this.target!.halt());
    this.halted = true;
    await this.snapshot();
  }

  private async resume(): Promise<void> {
    const t = this.target!;
    await this.run(async () => {
      t.setBreakpoints(this.hardwareBreakpoints());
      await t.resume();
    });
    this.halted = false;
    this.clearExec();
    this.setState("Running");
    void this.pollForStop();
  }

  private hardwareBreakpoints(): number[] {
    return this.table ? this.host.breakpoints(this.table) : [];
  }

  /** Called when the gutter breakpoints change: they take effect at the next resume. */
  breakpointsChanged(): void {
    if (this.target && !this.halted) {
      // While running, stop briefly to program the new breakpoints.
      void this.run(async () => {
        const t = this.target!;
        await t.halt();
        t.setBreakpoints(this.hardwareBreakpoints());
        await t.resume();
      }).catch((e) => this.fail(e));
    }
  }

  /** Watch for the program hitting a breakpoint. */
  private async pollForStop(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      while (this.target && !this.halted) {
        await sleep(100);
        const t = this.target;
        if (!t || this.halted) break;
        const stopped = await this.run(() => t.isHalted());
        if (stopped && this.target === t && !this.halted) {
          this.halted = true;
          await this.snapshot();
        }
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.polling = false;
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
      if (!this.halted && this.watches.length) {
        const t = this.target;
        try {
          let paused = 0;
          await this.run(async () => {
            const start = performance.now();
            await t.halt();
            const budgetEnd = start + LIVE_BUDGET_MS;
            for (let n = 0; n < this.watches.length && (n === 0 || performance.now() < budgetEnd); n++) {
              const w = this.watches[(next + n) % this.watches.length];
              await this.readWatch(t, w);
              next = (next + n + 1) % this.watches.length;
            }
            t.setBreakpoints(this.hardwareBreakpoints());
            await t.resume();
            paused = performance.now() - start;
          });
          gap = Math.max(LIVE_MIN_GAP_MS, paused * LIVE_DUTY);
          if (paused > LIVE_BUDGET_MS * 2) this.host.log(`JTAG live: pausing took ${Math.round(paused)} ms; the interrupt watchdog may trip. Watch fewer variables.`, "muted");
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
    await this.run(async () => {
      const t = this.target!;
      t.setBreakpoints(this.hardwareBreakpoints());
      await t.stepInstruction();
    });
    await this.snapshot();
  }

  /** Step to the next source line. Calls into code without line info are run through. */
  private async stepLine(over: boolean): Promise<void> {
    const t = this.target!;
    const table = this.table;
    if (!table) return this.stepInstruction();
    this.status.textContent = "Stepping…";
    await this.run(async () => {
      let pc = await t.readPc();
      const start = locateExact(table, pc);
      const startFn = functionAt(table, pc);
      for (let n = 0; n < MAX_STEPS; n++) {
        const before = pc;
        t.setBreakpoints(this.hardwareBreakpoints());
        await t.stepInstruction();
        pc = await t.readPc();
        const loc = locateExact(table, pc);
        const insideStart = startFn && pc >= startFn.start && pc < startFn.end;
        const entered = await this.enteredCall(t, before, pc);
        if (entered !== undefined && (over || !loc)) {
          // Run until the call returns, then keep stepping.
          t.setBreakpoints([entered, ...this.hardwareBreakpoints()].slice(0, 2));
          await t.resume();
          const deadline = Date.now() + 30000;
          while (!(await t.isHalted())) {
            if (this.target !== t || Date.now() > deadline) {
              if (this.target === t) await t.halt();
              throw new Error("The called function didn't return; the CPU was paused");
            }
            await sleep(50);
          }
          pc = await t.readPc();
          if (pc !== entered) break; // stopped at a user breakpoint instead
          continue;
        }
        if (loc && (loc.line !== start?.line || loc.file !== start?.file || !insideStart)) break;
      }
    });
    await this.snapshot();
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

  // ---- reading the chip ----

  /** Read everything the panels show; the CPU must be halted. */
  private async read(): Promise<void> {
    const t = this.target!;
    this.regs = await t.readRegisters();
    const sp = this.regs.ar[1];
    const raw = await t.readMemory(sp, STACK_WORDS * 4);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const words = Array.from({ length: STACK_WORDS }, (_, i) => dv.getUint32(i * 4, true));
    this.stack = { base: sp, words, prev: this.stack?.base === sp ? this.stack.words : undefined };
    for (const w of this.watches) await this.readWatch(t, w);
    if (this.tab === "Memory" || this.memory.bytes) {
      this.memory.prev = this.memory.bytes;
      this.memory.bytes = await t.readMemory(this.memory.addr, this.memory.length);
    }
    this.where = this.table ? locateExact(this.table, this.regs.pc) : undefined;
  }

  private async readWatch(t: DebugTarget, w: Watch): Promise<void> {
    const bytes = await t.readMemory(w.sym.addr, Math.min(w.sym.size, 64));
    const before = w.bytes;
    w.changed = !!before && before.some((x, i) => x !== bytes[i]);
    w.bytes = bytes;
    if (w.sym.size <= 8) w.history = [...w.history, toNumber(bytes, true)].slice(-HISTORY);
    if (w.changed && before) this.note(`${w.sym.name}: ${formatValue({ ...w, bytes: before })} → ${formatValue(w)}`);
  }

  private note(text: string): void {
    this.timeline.push({ at: Date.now(), text, loc: this.where });
    if (this.timeline.length > 500) this.timeline.shift();
  }

  /** A stop: read the chip, show where it is, update every view. */
  private async snapshot(): Promise<void> {
    try {
      await this.run(() => this.read());
    } catch (e) {
      this.fail(e);
      return;
    }
    const pc = this.regs!.pc;
    this.note(`stopped at ${this.where ? `${this.where.file.replace("/src/", "")}:${this.where.line}` : "0x" + hex(pc)}`);
    this.setState(`Paused at ${this.where ? `${this.where.func ? this.where.func + "() · " : ""}${this.where.file.replace("/src/", "")}:${this.where.line}` : "0x" + hex(pc)}`);
    this.showExec();
    this.renderInline();
  }

  // ---- watches ----

  private discoverGlobals(): void {
    if (!this.symbols.length) return;
    const byName = new Map(this.symbols.map((s) => [s.name, s]));
    const used = new Set<string>();
    for (const { model } of this.host.sources()) {
      for (const m of model.getValue().matchAll(/[A-Za-z_]\w*/g)) {
        if (byName.has(m[0])) used.add(m[0]);
      }
    }
    for (const name of [...used].slice(0, MAX_AUTO)) this.addWatch(byName.get(name)!, true);
  }

  private addWatch(sym: DataSymbol, auto = false): void {
    if (this.watches.some((w) => w.sym.addr === sym.addr)) return;
    this.watches.push({ sym, format: "dec", history: [], changed: false, auto });
  }

  private async writeWatch(w: Watch, text: string): Promise<void> {
    const value = w.format === "float" ? Number(text) : Number(text.trim());
    if (!Number.isFinite(value) || w.sym.size > 8) throw new Error(`Can't write "${text}" to ${w.sym.name}`);
    const bytes = new Uint8Array(w.sym.size);
    const dv = new DataView(bytes.buffer);
    if (w.format === "float" && w.sym.size === 4) dv.setFloat32(0, value, true);
    else if (w.format === "float" && w.sym.size === 8) dv.setFloat64(0, value, true);
    else {
      let v = BigInt(Math.trunc(value));
      for (let i = 0; i < bytes.length; i++, v >>= 8n) bytes[i] = Number(v & 0xffn);
    }
    await this.run(() => this.target!.writeMemory(w.sym.addr, bytes));
    await this.snapshot();
  }

  // ---- the editor ----

  private showExec(): void {
    this.clearExec();
    const loc = this.where;
    if (!loc) return;
    const model = this.host.sources().find((s) => s.file === loc.file)?.model;
    if (!model || loc.line > model.getLineCount()) return;
    this.host.showFile(loc.file);
    const ids = model.deltaDecorations([], [{
      range: new monaco.Range(loc.line, 1, loc.line, 1),
      options: {
        isWholeLine: true,
        className: "exec-line stopped",
        glyphMarginClassName: "exec-glyph stopped",
        minimap: { color: "#ffcc66", position: monaco.editor.MinimapPosition.Inline },
        overviewRuler: { color: "#e2c08d", position: monaco.editor.OverviewRulerLane.Full },
      },
    }]);
    this.execDecoration = { model, ids };
    this.host.editor.revealLineInCenterIfOutsideViewport(loc.line, monaco.editor.ScrollType.Smooth);
  }

  private clearExec(): void {
    if (this.execDecoration && !this.execDecoration.model.isDisposed()) {
      this.execDecoration.model.deltaDecorations(this.execDecoration.ids, []);
    }
    this.execDecoration = undefined;
  }

  /** Values next to the code that uses them, so the program reads as its own state. */
  private renderInline(): void {
    for (const [model, ids] of this.inlineDecorations) if (!model.isDisposed()) model.deltaDecorations(ids, []);
    this.inlineDecorations.clear();
    if (!this.target) return;
    const byName = new Map(this.watches.filter((w) => w.bytes).map((w) => [w.sym.name, w]));
    for (const { model } of this.host.sources()) {
      const decorations: monaco.editor.IModelDeltaDecoration[] = [];
      for (let line = 1; line <= model.getLineCount(); line++) {
        const seen = new Map<string, Watch>();
        for (const m of model.getLineContent(line).matchAll(/[A-Za-z_]\w*/g)) {
          const w = byName.get(m[0]);
          if (w) seen.set(m[0], w);
        }
        if (!seen.size) continue;
        const text = [...seen].map(([name, w]) => `${name} = ${formatValue(w)}`).join(", ");
        const changed = [...seen.values()].some((w) => w.changed);
        decorations.push({
          range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
          options: { after: { content: `  ${text}`, inlineClassName: changed ? "jt-inline changed" : "jt-inline" } },
        });
      }
      this.inlineDecorations.set(model, model.deltaDecorations([], decorations));
    }
  }

  private hover(model: monaco.editor.ITextModel, pos: monaco.Position): monaco.languages.Hover | undefined {
    const word = model.getWordAtPosition(pos);
    const sym = word && this.symbols.find((s) => s.name === word.word);
    if (!word || !sym) return undefined;
    const w = this.watches.find((x) => x.sym.addr === sym.addr);
    const value = w?.bytes ? `\`${formatValue(w)}\`` : this.target ? "_pause to read_" : "_connect JTAG to read_";
    return {
      range: new monaco.Range(pos.lineNumber, word.startColumn, pos.lineNumber, word.endColumn),
      contents: [{ value: `**${sym.name}** = ${value}\n\n\`0x${hex(sym.addr)}\` · ${sym.size} byte${sym.size === 1 ? "" : "s"}` }],
    };
  }

  // ---- the panel ----

  private render(): void {
    for (const [t, b] of this.tabButtons) b.classList.toggle("active", t === this.tab);
    this.body.replaceChildren(...this.renderTab());
  }

  private renderTab(): HTMLElement[] {
    if (!this.table) return [el("p", "jt-empty", "Build with Trace enabled so the inspector knows your variables and lines.")];
    switch (this.tab) {
      case "Variables": return this.variablesTab();
      case "Memory": return this.memoryTab();
      case "Stack": return this.stackTab();
      case "Registers": return this.registersTab();
      case "Timeline": return this.timelineTab();
    }
  }

  private variablesTab(): HTMLElement[] {
    const search = el("input", "jt-input");
    search.placeholder = "Search all variables in the firmware…";
    const results = el("div", "jt-results");
    search.oninput = () => {
      const q = search.value.trim().toLowerCase();
      results.replaceChildren(...(q ? this.symbols.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 30) : []).map((s) => {
        const row = el("button", "jt-result", `${s.name}  0x${hex(s.addr)}  ${s.size}B`);
        row.title = "Watch this variable";
        row.onclick = () => {
          this.addWatch(s);
          if (this.halted) void this.snapshot();
          else this.render();
        };
        return row;
      }));
    };
    const table = el("table", "jt-table");
    table.append(this.row(["Variable", "Address", "Value", "History", ""], "th"));
    for (const w of this.watches) {
      const value = el("td", w.changed ? "jt-value changed" : "jt-value", formatValue(w));
      value.title = "Click to change the value on the chip";
      value.onclick = () => {
        const text = prompt(`New value for ${w.sym.name}`, w.bytes && w.sym.size <= 8 ? String(toNumber(w.bytes, true)) : "");
        if (text !== null && this.target && this.halted) void this.writeWatch(w, text).catch((e) => this.fail(e));
      };
      const format = el("select", "jt-format");
      for (const f of ["dec", "hex", "float"] as Format[]) format.add(new Option(f, f, false, f === w.format));
      format.onchange = () => {
        w.format = format.value as Format;
        this.render();
        this.renderInline();
      };
      const remove = el("button", "small", "×");
      remove.onclick = () => {
        this.watches = this.watches.filter((x) => x !== w);
        this.render();
        this.renderInline();
      };
      const tr = el("tr");
      const name = el("td", "", w.sym.name);
      name.title = `${w.sym.size} bytes`;
      const mem = el("td", "jt-link", "0x" + hex(w.sym.addr));
      mem.title = "Show in Memory";
      mem.onclick = () => this.openMemory(w.sym.addr, w.sym.size);
      const fmtCell = el("td");
      fmtCell.append(this.sparkline(w), format);
      const last = el("td");
      last.append(remove);
      tr.append(name, mem, value, fmtCell, last);
      table.append(tr);
    }
    const hint = el("p", "jt-empty", this.halted ? "" : "Pause to read values. Click a value to change it.");
    return [search, results, table, hint];
  }

  private row(cells: string[], tag: "th" | "td"): HTMLTableRowElement {
    const tr = el("tr");
    for (const c of cells) tr.append(el(tag, "", c));
    return tr;
  }

  /** What a variable did over the last stops, as a tiny line chart. */
  private sparkline(w: Watch): SVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "jt-spark");
    svg.setAttribute("viewBox", "0 0 80 16");
    const h = w.history;
    if (h.length > 1) {
      const min = Math.min(...h), max = Math.max(...h), span = max - min || 1;
      const line = document.createElementNS(ns, "polyline");
      line.setAttribute("points", h.map((v, i) => `${(i / (h.length - 1)) * 80},${15 - ((v - min) / span) * 14}`).join(" "));
      svg.append(line);
    }
    return svg;
  }

  private openMemory(addr: number, size: number): void {
    this.memory.addr = addr;
    this.memory.length = Math.max(16, Math.min(256, Math.ceil(size / 16) * 16));
    this.memory.bytes = this.memory.prev = undefined;
    this.tab = "Memory";
    if (this.halted) void this.run(() => this.read()).then(() => this.render()).catch((e) => this.fail(e));
    else this.render();
  }

  private memoryTab(): HTMLElement[] {
    const addr = el("input", "jt-input");
    addr.value = "0x" + hex(this.memory.addr);
    addr.title = "Address (0x…) or variable name";
    const go = el("button", "dbg", "Read");
    go.onclick = () => {
      const text = addr.value.trim();
      const sym = this.symbols.find((s) => s.name === text);
      const value = sym ? sym.addr : Number(text);
      if (!Number.isFinite(value) || value < 0) return this.fail(new Error(`"${text}" isn't an address or a variable`));
      this.openMemory(value >>> 0, sym?.size ?? this.memory.length);
    };
    const bar = el("div", "jt-memory-bar");
    bar.append(addr, go);
    const grid = el("div", "jt-hex");
    const bytes = this.memory.bytes;
    if (!bytes) grid.textContent = this.halted ? "Press Read." : "Pause the CPU, then press Read.";
    else {
      for (let o = 0; o < bytes.length; o += 16) {
        const line = el("div", "jt-hex-row");
        line.append(el("span", "jt-addr", hex(this.memory.addr + o)));
        let ascii = "";
        for (let i = o; i < Math.min(o + 16, bytes.length); i++) {
          const changed = this.memory.prev && this.memory.prev[i] !== bytes[i];
          line.append(el("span", changed ? "jt-byte changed" : "jt-byte", hex(bytes[i], 2)));
          ascii += bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : ".";
        }
        line.append(el("span", "jt-ascii", ascii));
        const owner = this.symbolAt(this.memory.addr + o);
        if (owner) line.append(el("span", "jt-owner", owner.name));
        grid.append(line);
      }
    }
    return [bar, grid];
  }

  private symbolAt(addr: number): DataSymbol | undefined {
    return this.symbols.find((s) => addr + 16 > s.addr && addr < s.addr + s.size);
  }

  private stackTab(): HTMLElement[] {
    if (!this.regs || !this.stack || !this.table) return [el("p", "jt-empty", "Pause the CPU to see the stack.")];
    const table = this.table;
    const out: HTMLElement[] = [];
    const frame = (label: string, pc: number, cls = "") => {
      const loc = locateExact(table, pc);
      const row = el("div", `jt-frame ${cls}`);
      row.append(el("span", "jt-addr", hex(pc)), el("span", "", loc ? `${loc.func ?? "?"}()  ${loc.file.replace("/src/", "")}:${loc.line}` : label));
      if (loc) {
        row.classList.add("jt-link");
        row.onclick = () => {
          this.host.showFile(loc.file);
          this.host.editor.revealLineInCenter(loc.line);
          this.host.editor.setPosition({ lineNumber: loc.line, column: 1 });
        };
      }
      return row;
    };
    out.push(el("div", "jt-section", "Call stack"));
    out.push(frame("current instruction", this.regs.pc, "current"));
    // Return addresses are found by looking for stack words that point into user code
    // (the windowed ABI keeps them in spilled register windows, so this is a scan, not an unwind).
    for (const w of this.stack.words) {
      const pc = (w & 0x3fffffff) | (this.regs.pc & 0xc0000000);
      if (locateExact(table, pc >>> 0)) out.push(frame("", pc >>> 0));
    }
    out.push(el("div", "jt-section", `Stack memory from sp = 0x${hex(this.stack.base)}`));
    this.stack.words.forEach((w, i) => {
      const changed = this.stack!.prev && this.stack!.prev[i] !== w;
      const row = el("div", changed ? "jt-hex-row changed" : "jt-hex-row");
      row.append(el("span", "jt-addr", hex(this.stack!.base + i * 4)), el("span", "jt-byte", hex(w)));
      const sym = this.symbols.find((s) => w >= s.addr && w < s.addr + s.size);
      if (sym) row.append(el("span", "jt-owner", `→ ${sym.name}`));
      out.push(row);
    });
    return out;
  }

  private registersTab(): HTMLElement[] {
    if (!this.regs) return [el("p", "jt-empty", "Pause the CPU to see the registers.")];
    const grid = el("div", "jt-regs");
    const entries: [string, number][] = [["pc", this.regs.pc], ...this.regs.ar.map((v, i) => [`a${i}`, v] as [string, number])];
    for (const [name, value] of entries) {
      const cell = el("div", "jt-reg");
      cell.append(el("span", "jt-regname", name), el("span", "jt-byte", hex(value)));
      const loc = this.table && locateExact(this.table, value);
      if (loc) cell.title = `${loc.func ?? ""} ${loc.file}:${loc.line}`;
      grid.append(cell);
    }
    return [grid];
  }

  private timelineTab(): HTMLElement[] {
    if (!this.timeline.length) return [el("p", "jt-empty", "Every stop and every change of a watched variable is recorded here.")];
    return [...this.timeline].reverse().map((entry) => {
      const row = el("div", "jt-entry");
      row.append(el("span", "jt-time", new Date(entry.at).toLocaleTimeString()), el("span", "", entry.text));
      const loc = entry.loc;
      if (loc) {
        row.classList.add("jt-link");
        row.title = `${loc.file}:${loc.line}`;
        row.onclick = () => {
          this.host.showFile(loc.file);
          this.host.editor.revealLineInCenter(loc.line);
        };
      }
      return row;
    });
  }
}
