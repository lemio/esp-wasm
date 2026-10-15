/**
 * Page side of Trace builds: reads the debug runtime's markers from the serial
 * stream (src/debug/trace-runtime.cpp), highlights the running line, and drives
 * pause / step / continue and breakpoints.
 */
import * as monaco from "monaco-editor";
import {
  type LineTable, type SourceLocation, formatRanges, locate, rangesForLine, rangesOfLineAt,
} from "./line-table";

const MARKER = /\x1b_esp-wasm:([a-z]+)=([0-9a-z,]+)\x1b\\/g;
const PREFIX = "\x1b_esp-wasm:";
const MAX_MARKER = 600; // a "hits" list of up to 48 addresses
/** The start of a marker, cut off: ESC _ and any beginning of "esp-wasm:key=value", not followed by its end. */
const BROKEN_MARKER = /\x1b_(?:esp-wasm:[a-z]*(?:=[0-9a-z,]*)?|e(?:s(?:p(?:-(?:w(?:a(?:s(?:m)?)?)?)?)?)?)?)(?!\x1b\\)/g;

/** How long a line keeps glowing after it last ran, and in how many steps it fades. */
const TRAIL_MS = 1500;
const TRAIL_STEPS = 4;
const TRAIL_MINIMAP = ["#d7ba7dc0", "#d7ba7d90", "#d7ba7d60", "#d7ba7d30"];

/** Removes the runtime's markers from serial text, reporting each one. Handles markers split across chunks. */
export class TraceFilter {
  private pending = "";

  constructor(private readonly onMarker: (key: string, value: string) => void) {}

  feed(chunk: string): string {
    let text = this.pending + chunk;
    this.pending = "";
    text = text.replace(MARKER, (_, key: string, value: string) => {
      this.onMarker(key, value);
      return "";
    });
    // Hold back an unfinished marker at the end of the chunk. Complete markers are
    // gone by now, so a remaining "ESC _esp-wasm:" start is one (a lone trailing ESC may be).
    let hold = -1;
    const start = text.lastIndexOf("\x1b_");
    const tail = start >= 0 ? text.slice(start) : "";
    // only while it still looks like a marker: after a reset the rest never comes, and other text follows instead
    if (tail && tail.length < MAX_MARKER && (PREFIX.startsWith(tail) || /^\x1b_esp-wasm:[a-z]*(?:=[0-9a-z,]*)?\x1b?$/.test(tail))) hold = start;
    else if (text.endsWith("\x1b")) hold = text.length - 1;
    if (hold >= 0) {
      this.pending = text.slice(hold);
      text = text.slice(0, hold);
    }
    // A marker the chip never finished (it was reset halfway, e.g. "ESC _esp-w" then "ESP-ROM:…"): drop the
    // fragment, so it doesn't end up glued to the boot log.
    return text.replace(BROKEN_MARKER, "");
  }
}

export type DebugState = "off" | "running" | "stopped";

/** A session with a Trace build on the chip. */
export class Debugger {
  private table?: LineTable;
  private canControl = false; // the runtime takes commands (Arduino sketches)
  private stoppedAt?: number;
  private last?: SourceLocation;
  private execDecoration?: { model: monaco.editor.ITextModel; ids: string[] };
  /** Breakpoints per compiled file ("/src/sketch.ino"): requested line → decoration ids. */
  private readonly breakpoints = new Map<string, Set<number>>();
  private readonly bpDecorations = new Map<monaco.editor.ITextModel, string[]>();
  /** Trail: "file:line" → when it last ran. */
  private readonly trail = new Map<string, number>();
  private readonly trailDecorations = new Map<monaco.editor.ITextModel, string[]>();
  private trailTimer?: number;
  state: DebugState = "off";

  constructor(
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    /** Model for a compiled path like "/src/sketch.ino", if it's part of the project. */
    private readonly modelFor: (file: string) => monaco.editor.ITextModel | undefined,
    /** Compiled path of a model, for breakpoints set in the editor. */
    private readonly fileOf: (model: monaco.editor.ITextModel) => string | undefined,
    private readonly send: (command: string) => Promise<void>,
    private readonly onChange: (d: Debugger, loc: SourceLocation | undefined) => void,
  ) {
    // Click in the gutter: toggle a breakpoint.
    editor.onMouseDown((e) => {
      const t = e.target;
      if (t.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          t.type !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return;
      if (t.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS && !e.event.altKey) return;
      const model = editor.getModel();
      const file = model && this.fileOf(model);
      if (file && t.position) this.toggleBreakpoint(file, t.position.lineNumber);
    });
    editor.onDidChangeModel(() => this.renderBreakpoints());
  }

  /** Can pause/step/breakpoints be used right now? */
  get controllable(): boolean {
    return this.state !== "off" && this.canControl;
  }

  /** The build now on the chip (undefined: not a Trace build). */
  attach(table: LineTable | undefined): void {
    this.table = table;
    this.canControl = false;
    this.stoppedAt = undefined;
    this.state = table ? "running" : "off";
    this.last = undefined;
    this.clearExec();
    this.clearTrail();
    this.renderBreakpoints();
    this.onChange(this, undefined);
  }

  /** The monitor stopped: nothing is running as far as we can see. */
  detach(): void {
    this.state = "off";
    this.canControl = false;
    this.clearExec();
    this.clearTrail();
    this.onChange(this, undefined);
  }

  marker(key: string, value: string): void {
    if (!this.table) return;
    if (this.state === "off") this.state = "running"; // e.g. the monitor was restarted by hand
    if (key === "boot") {
      // The chip (re)started: running, and with no breakpoints yet.
      this.canControl = value === "debug";
      this.state = "running";
      this.stoppedAt = undefined;
      void this.sendBreakpoints();
      this.onChange(this, this.last);
    } else if (key === "hello") {
      // Sent at boot and every 5 s; it says what the build can do, not its state.
      const first = !this.canControl && value === "debug";
      this.canControl = value === "debug";
      if (first) void this.sendBreakpoints();
      this.onChange(this, this.last);
    } else if (key === "hits" && this.state !== "stopped") {
      const now = performance.now();
      for (const hex of value.split(",")) {
        const loc = locate(this.table, parseInt(hex, 16));
        if (loc) this.trail.set(`${loc.file}:${loc.line}`, now);
      }
      this.renderTrail();
    } else if (key === "pc" && this.state !== "stopped") {
      this.showExec(parseInt(value, 16), false);
    } else if (key === "stop") {
      this.state = "stopped";
      this.stoppedAt = parseInt(value, 16);
      this.last = undefined;
      this.showExec(this.stoppedAt, true);
    } else if (key === "run") {
      this.state = "running";
      this.stoppedAt = undefined;
      this.onChange(this, this.last);
    }
  }

  // ---- commands ----

  pause(): Promise<void> {
    return this.command("p");
  }
  continue(): Promise<void> {
    return this.command(`c ${this.currentLineRanges()}`);
  }
  stepOver(): Promise<void> {
    return this.command(`o ${this.currentLineRanges()}`);
  }
  stepInto(): Promise<void> {
    return this.command(`i ${this.currentLineRanges()}`);
  }
  stepOut(): Promise<void> {
    return this.command("u");
  }

  private currentLineRanges(): string {
    return this.table && this.stoppedAt !== undefined ? formatRanges(rangesOfLineAt(this.table, this.stoppedAt)) : "";
  }

  private async command(cmd: string): Promise<void> {
    if (!this.controllable) return;
    await this.send(`\x1b_esp-wasm:${cmd}\x1b\\`);
  }

  // ---- breakpoints ----

  toggleBreakpoint(file: string, line: number): void {
    const set = this.breakpoints.get(file) ?? new Set<number>();
    this.breakpoints.set(file, set);
    // With a line table, snap to the line that has code (and toggle that one).
    const snapped = this.table ? rangesForLine(this.table, file, line)?.line ?? line : line;
    if (set.has(line)) set.delete(line);
    else if (set.has(snapped)) set.delete(snapped);
    else set.add(snapped);
    this.renderBreakpoints();
    void this.sendBreakpoints();
  }

  private async sendBreakpoints(): Promise<void> {
    if (!this.table || !this.controllable) return;
    const ranges: [number, number][] = [];
    for (const [file, lines] of this.breakpoints) {
      for (const line of lines) ranges.push(...(rangesForLine(this.table, file, line)?.ranges ?? []));
    }
    await this.send(`\x1b_esp-wasm:b ${formatRanges(ranges.slice(0, 64))}\x1b\\`);
  }

  private renderBreakpoints(): void {
    for (const [model, ids] of this.bpDecorations) {
      if (!model.isDisposed()) model.deltaDecorations(ids, []);
    }
    this.bpDecorations.clear();
    for (const [file, lines] of this.breakpoints) {
      const model = this.modelFor(file);
      if (!model || model.isDisposed()) continue;
      const ids = model.deltaDecorations([], [...lines].filter((l) => l <= model.getLineCount()).map((l) => ({
        range: new monaco.Range(l, 1, l, 1),
        options: {
          glyphMarginClassName: "bp-glyph",
          minimap: { color: "#e51400", position: monaco.editor.MinimapPosition.Gutter },
          overviewRuler: { color: "#e51400", position: monaco.editor.OverviewRulerLane.Left },
          glyphMarginHoverMessage: { value: "Breakpoint (click to remove)" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      })));
      this.bpDecorations.set(model, ids);
    }
  }

  // ---- the running / stopped line ----

  private showExec(pc: number, stopped: boolean): void {
    if (!this.table) return;
    const loc = locate(this.table, pc);
    if (!loc) return; // in code without line info (core, libraries): keep the last user line
    if (!stopped && this.last && loc.file === this.last.file && loc.line === this.last.line) return;
    this.last = loc;
    const model = this.modelFor(loc.file);
    this.clearExec();
    if (model && loc.line <= model.getLineCount()) {
      const ids = model.deltaDecorations([], [{
        range: new monaco.Range(loc.line, 1, loc.line, 1),
        options: {
          isWholeLine: true,
          className: stopped ? "exec-line stopped" : "exec-line",
          glyphMarginClassName: stopped ? "exec-glyph stopped" : "exec-glyph",
          glyphMarginHoverMessage: { value: `${stopped ? "Paused" : "Running"}${loc.func ? ` in \`${loc.func}()\`` : ""}` },
          overviewRuler: { color: stopped ? "#e2c08d" : "#d7ba7d80", position: monaco.editor.OverviewRulerLane.Full },
          minimap: { color: stopped ? "#ffcc66" : "#d7ba7d", position: monaco.editor.MinimapPosition.Inline },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }]);
      this.execDecoration = { model, ids };
      // Running: never scroll (the minimap shows where it is). Stopped: bring the
      // line into view if it's off-screen, so a step or breakpoint shows its line.
      if (stopped && this.editor.getModel() === model) {
        this.editor.revealLineInCenterIfOutsideViewport(loc.line, monaco.editor.ScrollType.Smooth);
      }
    }
    this.onChange(this, loc);
  }

  // ---- the trail: lines that ran recently, fading out ----

  private renderTrail(): void {
    const now = performance.now();
    const byModel = new Map<monaco.editor.ITextModel, monaco.editor.IModelDeltaDecoration[]>();
    for (const [key, at] of this.trail) {
      const age = now - at;
      if (age >= TRAIL_MS) {
        this.trail.delete(key);
        continue;
      }
      const sep = key.lastIndexOf(":");
      const model = this.modelFor(key.slice(0, sep));
      const line = Number(key.slice(sep + 1));
      if (!model || model.isDisposed() || line > model.getLineCount()) continue;
      const step = Math.min(TRAIL_STEPS, 1 + Math.floor((age / TRAIL_MS) * TRAIL_STEPS));
      const list = byModel.get(model) ?? [];
      list.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: `trail-${step}`,
          minimap: { color: TRAIL_MINIMAP[step - 1], position: monaco.editor.MinimapPosition.Inline },
        },
      });
      byModel.set(model, list);
    }
    for (const [model, ids] of this.trailDecorations) {
      if (!byModel.has(model) && !model.isDisposed()) model.deltaDecorations(ids, []);
    }
    for (const [model, decorations] of byModel) {
      this.trailDecorations.set(model, model.deltaDecorations(this.trailDecorations.get(model) ?? [], decorations));
    }
    for (const model of [...this.trailDecorations.keys()]) if (!byModel.has(model)) this.trailDecorations.delete(model);
    // Keep fading while anything glows; stop the timer when the trail is empty.
    if (this.trail.size && this.trailTimer === undefined) {
      this.trailTimer = window.setInterval(() => this.renderTrail(), 100);
    } else if (!this.trail.size && this.trailTimer !== undefined) {
      clearInterval(this.trailTimer);
      this.trailTimer = undefined;
    }
  }

  private clearTrail(): void {
    this.trail.clear();
    this.renderTrail();
  }

  private clearExec(): void {
    if (this.execDecoration && !this.execDecoration.model.isDisposed()) {
      this.execDecoration.model.deltaDecorations(this.execDecoration.ids, []);
    }
    this.execDecoration = undefined;
  }

  /** Where it's stopped, for switching to that file's tab. */
  get stoppedLocation(): SourceLocation | undefined {
    return this.table && this.stoppedAt !== undefined ? locate(this.table, this.stoppedAt) : undefined;
  }
}
