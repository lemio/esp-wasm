import "./styles.css";
import { CompileError, CompilerClient } from "./compiler/client";
import type { FlashPart } from "./compiler/types";
import { ARDUINO_SOURCE, CH32V003_SOURCE, IDF_SOURCE } from "./editor/default-sketch";
import {
  type TextModel, createEditor, disposeModel, fileModel, languageFor, setDiagnostics,
} from "./editor/editor";
import { FLASH_OFFSETS } from "./image/flash-layout";
import { Flasher, isWebSerialSupported } from "./flasher/flasher";
import { SerialMonitor } from "./flasher/monitor";
import { Ch32Iap } from "./flasher/ch32-iap";
import { FunprogHid, webHidSupported } from "./flasher/funprog-hid";
import { type Ch32Program, Ch32Target } from "./debug/ch32-target";
import { ch32v003 } from "./debug/jtag/chip-ch32v003";
import { loadProgram } from "./debug/jtag/program";
import type { LineTable } from "./debug/line-table";
import { BUILDS, dbRequest } from "./libraries/db";
import { Debugger, TraceFilter } from "./debug/trace-view";
import { JtagInspector } from "./debug/jtag/inspector";
import { XtensaOcd } from "./debug/jtag/xtensa-ocd";
import { isWebUsbSupported } from "./debug/jtag/usb-jtag";
import { Console } from "./ui/console";
import { type Example, ExamplesPanel } from "./ui/examples";
import { libraryFiles, listLibraries, removeLibrary } from "./libraries/store";
import { librarySuggestion, missingHeaders, onlyMissingHeaders } from "./libraries/suggest";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const out = new Console($("console"));
const status = $("status");
const btnBuild = $<HTMLButtonElement>("btn-build");
const btnConnect = $<HTMLButtonElement>("btn-connect");
const btnFlash = $<HTMLButtonElement>("btn-flash");
const btnBoot = $<HTMLButtonElement>("btn-boot");
const btnReset = $<HTMLButtonElement>("btn-reset");
const btnMonitor = $<HTMLButtonElement>("btn-monitor");
const btnDisconnect = $<HTMLButtonElement>("btn-disconnect");
const inputBins = $<HTMLInputElement>("input-bins");
const selectMode = $<HTMLSelectElement>("select-mode");
// CH32V003: flash over its UART bootloader, or over SWIO with a funprog programmer (e.g. an ESP32-S3).
const selectCh32Via = $<HTMLSelectElement>("select-ch32-via");
/** The CH32V003's inspector (debugging over SWIO through a funprog programmer); made once the editor exists. */
let ch32Inspector: JtagInspector | undefined;
/** The program last flashed to the CH32V003 over SWIO: the inspector writes breakpoints into flash from it. */
let ch32Flashed: Ch32Program | undefined;
const btnExamples = $<HTMLButtonElement>("btn-examples");
const tabsEl = $("tabs");
const chkTrace = $<HTMLInputElement>("chk-trace");
const btnJtag = $<HTMLButtonElement>("btn-jtag");
// The single-step tools (Build, Connect, Boot mode, Monitor, Flash .bin…) are for troubleshooting.
$("debug-tools").hidden = !new URLSearchParams(location.search).has("tools");
const debugBar = $("debug-bar");
const dbgPause = $<HTMLButtonElement>("dbg-pause");
const dbgOver = $<HTMLButtonElement>("dbg-over");
const dbgInto = $<HTMLButtonElement>("dbg-into");
const dbgOut = $<HTMLButtonElement>("dbg-out");
const dbgWhere = $("dbg-where");

// Project types. The first two link against the ESP32-S3 sysroot: an Arduino
// sketch provides setup()/loop(), an ESP-IDF program provides app_main().
// ch32v003: a ch32fun program (main()) for the WCH CH32V003, a RISC-V chip.
// `store`: where the main file is kept, when it differs from its build path.
const MODES = {
  arduino: { file: "sketch.ino", language: "cpp", source: ARDUINO_SOURCE, store: "sketch.ino", chip: "ESP32-S3" },
  idf: { file: "main.c", language: "c", source: IDF_SOURCE, store: "main.c", chip: "ESP32-S3" },
  ch32v003: { file: "main.c", language: "c", source: CH32V003_SOURCE, store: "ch32v003/main.c", chip: "CH32V003" },
} as const;
type Mode = keyof typeof MODES;
const isMode = (m: string | null): m is Mode => !!m && m in MODES;

const storage = {
  get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const editor = createEditor($("editor"));
const savedMode = storage.get("esp-wasm:mode");
let mode: Mode = isMode(savedMode) ? savedMode : "arduino";

/** A file of the current project: its path in the build and its editor model. */
interface ProjectFile {
  path: string;
  model: TextModel;
}

/** The main file of a project type; its contents are kept in localStorage. */
function mainFile(m: Mode): ProjectFile {
  const { file, language, source, store } = MODES[m];
  const key = `esp-wasm:${store}`;
  const fresh = !savedModels.has(store);
  const model = fileModel(store, language, () => storage.get(key) ?? source);
  if (fresh) {
    model.onDidChangeContent(() => storage.set(key, model.getValue()));
    savedModels.add(store);
  }
  return { path: file, model };
}
const savedModels = new Set<string>();

// Extra files of the Arduino project (an example's .h/.cpp files), kept in localStorage.
const EXTRAS_KEY = "esp-wasm:arduino-extras";
const PRISTINE_KEY = "esp-wasm:arduino-pristine";
let extras: ProjectFile[] = [];

function extraModel(path: string, content: string): ProjectFile {
  const model = fileModel(`arduino/${path}`, languageFor(path), () => content);
  model.onDidChangeContent(saveExtras);
  return { path, model };
}
function saveExtras() {
  storage.set(EXTRAS_KEY, JSON.stringify(extras.map((f) => ({ path: f.path, content: f.model.getValue() }))));
}
try {
  const saved = JSON.parse(storage.get(EXTRAS_KEY) ?? "[]") as { path: string; content: string }[];
  extras = saved.map((f) => extraModel(f.path, f.content));
} catch { /* corrupt entry: start without extra files */ }

// The CH32V003 project's other files (an example's funconfig.h, .c and .h files).
const CH32_EXTRAS_KEY = "esp-wasm:ch32v003-extras";
const CH32_PRISTINE_KEY = "esp-wasm:ch32v003-pristine";
let ch32Extras: ProjectFile[] = [];
function ch32ExtraModel(path: string, content: string): ProjectFile {
  const model = fileModel(`ch32v003/${path}`, languageFor(path), () => content);
  model.onDidChangeContent(saveCh32Extras);
  return { path, model };
}
function saveCh32Extras() {
  storage.set(CH32_EXTRAS_KEY, JSON.stringify(ch32Extras.map((f) => ({ path: f.path, content: f.model.getValue() }))));
}
try {
  const saved = JSON.parse(storage.get(CH32_EXTRAS_KEY) ?? "[]") as { path: string; content: string }[];
  ch32Extras = saved.map((f) => ch32ExtraModel(f.path, f.content));
} catch { /* corrupt entry: start without extra files */ }
const ch32Text = () => [mainFile("ch32v003"), ...ch32Extras].map((f) => f.model.getValue()).join("\0");

/** All files of the current project, main file first. */
const projectFiles = (): ProjectFile[] =>
  mode === "arduino" ? [mainFile("arduino"), ...extras]
  : mode === "ch32v003" ? [mainFile("ch32v003"), ...ch32Extras]
  : [mainFile("idf")];
/** The Arduino project's contents, to tell whether it changed since it was opened. */
const arduinoText = () => [mainFile("arduino"), ...extras].map((f) => f.model.getValue()).join("\0");

/** Show a project file in the editor, with tabs when the project has more than one. */
function show(file: ProjectFile) {
  editor.setModel(file.model);
  const files = projectFiles();
  tabsEl.hidden = files.length < 2;
  tabsEl.replaceChildren(...files.map((f) => {
    const tab = document.createElement("button");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(f.path === file.path));
    tab.textContent = f.path;
    tab.onclick = () => show(f);
    return tab;
  }));
}

const targetLabel = document.querySelector<HTMLElement>(".toolbar .target");
function setMode(m: Mode) {
  mode = m;
  selectMode.value = m;
  storage.set("esp-wasm:mode", m);
  show(projectFiles()[0]);
  // The CH32V003 flashes over its UART bootloader; the ESP32-S3's trace, inspector and reset don't apply.
  const ch32 = m === "ch32v003";
  if (targetLabel) targetLabel.textContent = MODES[m].chip;
  btnFlash.title = !ch32
    ? "Compile, put the chip in download mode, flash and reset"
    : selectCh32Via.value === "funprog"
      ? "Compile and flash over SWIO with a funprog programmer (e.g. an ESP32-S3 running the funprog example), with WebHID"
      : "Compile and flash over the board's USB-serial port (needs WCH's USART IAP bootloader on the chip)";
  for (const el of [chkTrace.closest("label"), btnReset]) if (el) (el as HTMLElement).hidden = ch32;
  // Inspect: the ESP32-S3's inspector over USB-JTAG, or the CH32V003's over SWIO (each in its own panel).
  btnJtag.disabled = ch32 ? !webHidSupported() : !isWebUsbSupported();
  btnJtag.title = ch32
    ? "Hardware inspector: debug the CH32V003 over SWIO through a funprog programmer (variables, pins, memory, stack, stepping)"
    : "Hardware inspector: debug the chip over USB-JTAG (memory, variables, stack, stepping)";
  $("jtag-panel").hidden ||= ch32;
  $("ch32-panel").hidden ||= !ch32;
  selectCh32Via.hidden = !ch32;
  // While the CH32V003's inspector is connected, Reset restarts its program.
  if (ch32 && ch32Inspector?.connected) btnReset.hidden = false;
  if (!ch32 && ch32Inspector?.connected) void ch32Inspector.release();
}
selectCh32Via.value = storage.get("esp-wasm:ch32-via") === "funprog" ? "funprog" : "iap";
setMode(mode);
selectMode.onchange = () => setMode(selectMode.value as Mode);
selectCh32Via.onchange = () => {
  storage.set("esp-wasm:ch32-via", selectCh32Via.value);
  setMode(mode);
};

/** Replace the CH32V003 project with a ch32fun example (asks first if it was changed). */
function openCh32Example(ex: Example) {
  const changed = ch32Text() !== (storage.get(CH32_PRISTINE_KEY) ?? CH32V003_SOURCE);
  if (changed && !confirm(`Replace your CH32V003 program with the example "${ex.title}"? Your changes will be lost.`)) return;
  for (const f of ch32Extras) disposeModel(`ch32v003/${f.path}`);
  const [main, ...rest] = ex.files;
  mainFile("ch32v003").model.setValue(main.content);
  ch32Extras = rest.map((f) => ch32ExtraModel(f.path, f.content));
  saveCh32Extras();
  setMode("ch32v003");
  storage.set(CH32_PRISTINE_KEY, ch32Text());
  out.log(`Opened example ${ex.library} › ${ex.path}${rest.length ? ` (${ex.files.length} files)` : ""}`, "muted");
  setStatus(`Example: ${ex.title}`);
}

/** Replace the Arduino project with an example (asks first if the current sketch was changed). */
function openExample(ex: Example) {
  if (ex.kind === "ch32v003") return openCh32Example(ex);
  const changed = arduinoText() !== (storage.get(PRISTINE_KEY) ?? ARDUINO_SOURCE);
  if (changed &&
      !confirm(`Replace your sketch with the example "${ex.title}"? Your changes will be lost.`)) {
    return;
  }
  for (const f of extras) disposeModel(`arduino/${f.path}`);
  const [main, ...rest] = ex.files;
  mainFile("arduino").model.setValue(main.content);
  extras = rest.map((f) => extraModel(f.path, f.content));
  saveExtras();
  setMode("arduino");
  storage.set(PRISTINE_KEY, arduinoText());
  out.log(`Opened example ${ex.library} › ${ex.path}${rest.length ? ` (${ex.files.length} files)` : ""}`, "muted");
  if (ex.status && !ex.status.ok) {
    out.log(`Note: this example doesn't build here (${ex.status.stage}): ${ex.status.error}`, "warn");
  }
  setStatus(`Example: ${ex.title}`);
}

const examples = new ExamplesPanel($("examples-panel"), openExample);

/** Show the installed libraries in the examples panel. */
async function refreshInstalled() {
  examples.setInstalled(await listLibraries(), async (id) => {
    if (!confirm(`Remove the library ${id} from this browser?`)) return;
    await removeLibrary(id);
    out.log(`Removed library ${id}.`, "muted");
    await refreshInstalled();
  });
}
void refreshInstalled();
btnExamples.onclick = async () => {
  const open = !examples.visible;
  btnExamples.setAttribute("aria-expanded", String(open));
  await examples.toggle(open);
};

const compiler = new CompilerClient((text, level) => out.log(text, level));
const flasher = new Flasher(out.asTerminal());
// Trace builds: the monitor's stream carries the running address; the debugger
// sends pause/step/continue and breakpoints back over the same port.
const debug = new Debugger(
  editor,
  (file) => projectFiles().find((f) => `/src/${f.path}` === file)?.model,
  (model) => {
    const f = projectFiles().find((p) => p.model === model);
    return f && `/src/${f.path}`;
  },
  (command) => monitor.write(command),
  (d, loc) => {
    debugBar.hidden = d.state === "off" || d.hardware;
    const stopped = d.state === "stopped";
    dbgPause.textContent = stopped ? "Continue" : "Pause";
    for (const b of [dbgOver, dbgInto, dbgOut]) b.disabled = !stopped || !d.controllable;
    dbgPause.disabled = !d.controllable;
    const where = loc ? `${loc.func ? `${loc.func}() · ` : ""}${loc.file.replace("/src/", "")}:${loc.line}` : "";
    dbgWhere.textContent = !d.controllable && d.state !== "off"
      ? `${where ? `▶ ${where} · ` : ""}tracing only (pause/step need an Arduino sketch)`
      : `${stopped ? "⏸ Paused at" : "▶"} ${where}`;
    if (d.hardware) setStatus(mode === "ch32v003" ? "Inspecting over SWIO" : "Inspecting over JTAG");
    else if (loc) setStatus(`${stopped ? "⏸" : "▶"} ${where}`);
    // Show the file it stopped in.
    if (stopped && loc) {
      const f = projectFiles().find((p) => `/src/${p.path}` === loc.file);
      if (f && editor.getModel() !== f.model) show(f);
    }
  },
);
// Hardware inspector: debugging over the chip's USB-JTAG, drawn into the editor.
const inspector = new JtagInspector(
  $("jtag-panel"),
  {
    editor,
    sources: () => projectFiles().map((f) => ({ file: `/src/${f.path}`, model: f.model })),
    showFile: (file) => {
      const f = projectFiles().find((p) => `/src/${p.path}` === file);
      if (f && editor.getModel() !== f.model) show(f);
    },
    breakpoints: (table) => debug.breakpointAddresses(table),
    log: (text, level) => out.log(text, level),
    connectionChanged: (connected) => debug.setHardware(connected),
    // After a reset from JTAG the chip's USB serial side starts over and the open port goes
    // quiet: reopen it, as the Monitor button would.
    chipRestarted: () => void (async () => {
      if (!monitor.running) return;
      await monitor.stop();
      await monitor.start(await flasher.pickPort()).catch((e) => out.log(`Serial monitor failed to restart: ${(e as Error).message}`, "error"));
    })(),
  },
  () => new XtensaOcd(),
);
// The CH32V003's: the same panel, over SWIO through a funprog programmer (WebHID).
ch32Inspector = new JtagInspector(
  $("ch32-panel"),
  {
    editor,
    sources: () => projectFiles().map((f) => ({ file: `/src/${f.path}`, model: f.model })),
    showFile: (file) => {
      const f = projectFiles().find((p) => `/src/${p.path}` === file);
      if (f && editor.getModel() !== f.model) show(f);
    },
    breakpoints: (table) => debug.breakpointAddresses(table),
    log: (text, level) => out.log(text, level),
    connectionChanged: (connected) => {
      debug.setHardware(connected);
      setMode(mode); // Reset restarts its program while connected
    },
  },
  () => new Ch32Target({
    print: (text) => out.serial(text), // ch32fun's printf, over SWIO
    log: (text) => out.log(text, "muted"),
    program: () => ch32Flashed,
  }),
  ch32v003,
);
$("ch32-panel").hidden ||= mode !== "ch32v003";
debug.onBreakpointsChanged = () => {
  inspector.breakpointsChanged();
  ch32Inspector?.breakpointsChanged();
};
// Best effort: take the breakpoints out of the CH32V003's flash when the page goes away.
window.addEventListener("pagehide", () => void ch32Inspector?.release());
// For poking at the inspector from the browser's console while developing.
if (import.meta.env.DEV) Object.assign(window, { inspector, ch32Inspector, editor, debug, openCh32Example });
btnJtag.disabled = mode !== "ch32v003" && !isWebUsbSupported();
btnJtag.onclick = () => {
  if (mode === "ch32v003" && ch32Inspector) {
    if (ch32Inspector.visible) ch32Inspector.hide();
    else ch32Inspector.show();
    return;
  }
  if (inspector.visible) inspector.hide();
  else inspector.show();
};
const traceFilter = new TraceFilter((key, value) => debug.marker(key, value));
const run = (action: () => Promise<void>) => () => void action().catch((e) => out.log(`Debugger: ${(e as Error).message}`, "error"));
dbgPause.onclick = run(() => (debug.state === "stopped" ? debug.continue() : debug.pause()));
dbgOver.onclick = run(() => debug.stepOver());
dbgInto.onclick = run(() => debug.stepInto());
dbgOut.onclick = run(() => debug.stepOut());
window.addEventListener("keydown", (e) => {
  if (debug.state === "off") return;
  const key = e.key + (e.shiftKey ? "+shift" : "");
  const actions: Record<string, () => void> = {
    F5: run(() => debug.continue()), F6: run(() => debug.pause()), F10: run(() => debug.stepOver()),
    F11: run(() => debug.stepInto()), "F11+shift": run(() => debug.stepOut()),
  };
  if (actions[key]) {
    e.preventDefault();
    actions[key]();
  }
}, true);
chkTrace.checked = storage.get("esp-wasm:trace") === "1";
chkTrace.onchange = () => storage.set("esp-wasm:trace", chkTrace.checked ? "1" : "0");
/** Line table of the last successful build (Trace builds only). */
let builtLineTable: LineTable | undefined;

const monitor = new SerialMonitor({
  data: (text) => {
    const shown = traceFilter.feed(text);
    inspector.serialText(shown); // it explains crashes from ESP-IDF's panic message
    out.serial(shown);
  },
  info: (message, level = "muted") => out.log(message, level),
  portChanged: (port) => flasher.usePort(port),
  stopped: () => {
    debug.detach();
    refreshButtons();
  },
});

const setStatus = (text: string) => (status.textContent = text);
const allButtons = [btnFlash, btnBuild, btnConnect, btnBoot, btnReset, btnMonitor];
let busy = false;

const refreshButtons = () => {
  btnConnect.textContent = flasher.connected ? `Disconnect (${flasher.chip})` : "Connect";
  btnMonitor.textContent = monitor.running ? "Stop monitor" : "Monitor";
  for (const b of allButtons) b.disabled = busy;
  // Only while the page holds the port: the monitor runs, or an esptool session is open.
  btnDisconnect.disabled = busy || !(monitor.running || flasher.connected);
  if (!isWebSerialSupported()) {
    btnFlash.disabled = btnConnect.disabled = btnBoot.disabled = btnReset.disabled = btnMonitor.disabled = true;
  }
};

/** Run one action at a time; every button is disabled while it runs. */
async function exclusive(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  refreshButtons();
  try {
    await action();
  } finally {
    busy = false;
    refreshButtons();
  }
}

if (!isWebSerialSupported()) {
  out.log("Web Serial isn't supported in this browser, so flashing is disabled. Use Chrome or Edge.", "error");
}

/** Compile the editor contents. Returns the flash parts, or undefined if the build failed. */
/**
 * Compile the project (with any installed libraries). If a header is missing,
 * suggest libraries that provide it; `retry` repeats the action after one is installed.
 */
/** A fingerprint of the project's sources (and mode): a saved build is only reused for exactly these. */
function sourcesKey(): string {
  let h = 0x811c9dc5;
  for (const ch of `${mode}\0${projectFiles().map((f) => `${f.path}\0${f.model.getValue()}`).join("\0")}`) {
    h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface SavedBuild {
  sources: string;
  lineTable?: LineTable;
  elf?: Uint8Array;
  app?: FlashPart;
  instrumented: boolean;
}

/** Keep the build's debug info, so a page reload doesn't leave the inspector without it. */
function saveBuild(saved: SavedBuild): void {
  void dbRequest(BUILDS, "readwrite", (s) => s.put(saved, "last")).catch(() => { /* best effort */ });
}

/** A CH32V003 build: its debug info, and the image (from the start of flash). */
interface Ch32Build {
  sources: string;
  lineTable?: LineTable;
  elf?: Uint8Array;
  image: Uint8Array;
}
let ch32Built: Ch32Build | undefined;

/** The CH32V003 now runs this build: the inspector knows its lines and variables, and writes breakpoints from its image. */
function ch32Attach(b: Ch32Build): void {
  ch32Flashed = { image: b.image, funcs: b.elf ? loadProgram(b.elf).funcs : [] };
  ch32Inspector?.attach(b.lineTable, b.elf, { data: b.image, address: 0x08000000, mapped: 0 });
}

/** After a reload: the last build again, if the sources are still the ones it was made from. */
async function restoreBuild(): Promise<void> {
  const ch32 = await dbRequest<Ch32Build | undefined>(BUILDS, "readonly", (s) => s.get("last-ch32")).catch(() => undefined);
  if (ch32 && ch32.sources === sourcesKey()) ch32Attach(ch32);
  const saved = await dbRequest<SavedBuild | undefined>(BUILDS, "readonly", (s) => s.get("last")).catch(() => undefined);
  if (!saved || saved.sources !== sourcesKey() || !saved.lineTable) return;
  builtLineTable = saved.instrumented ? saved.lineTable : undefined;
  if (saved.instrumented) debug.attach(saved.lineTable);
  inspector.attach(saved.lineTable, saved.elf, saved.app);
}

async function build(retry?: () => void): Promise<FlashPart[] | undefined> {
  setStatus("Building…");
  const files = projectFiles();
  for (const f of files) setDiagnostics(f.model, [], f.path);
  // Arduino's Serial: the native USB port when flashing over it, otherwise UART0.
  // (esp_wasm/hwcdc_serial.cpp in the sysroot provides the native USB object.)
  const defines = mode === "arduino" ? [`ARDUINO_USB_CDC_ON_BOOT=${flasher.usesNativeUsb ? 1 : 0}`] : [];
  try {
    if (mode === "ch32v003") {
      // ch32fun program: no Arduino libraries, trace hooks or JTAG inspector (those are ESP32-S3 only).
      const result = await compiler.build(files.map((f) => ({ path: f.path, content: f.model.getValue() })), { target: "ch32v003" });
      for (const f of files) setDiagnostics(f.model, result.diagnostics, f.path);
      ch32Built = { sources: sourcesKey(), lineTable: result.lineTable, elf: result.elf, image: result.parts[0].data };
      out.log(`Build OK in ${(result.durationMs / 1000).toFixed(1)}s, app.bin ${result.parts[0].data.length} bytes (CH32V003)`, "ok");
      setStatus("Build OK");
      return result.parts;
    }
    const trace = chkTrace.checked;
    // With the inspector open, the code is built for it: debug info, no trace hooks.
    const debugInfo = inspector.visible;
    const libraries = await Promise.all((await listLibraries()).map(async (lib) => ({
      id: lib.id, version: lib.version, includeDirs: lib.includeDirs, files: await libraryFiles(lib),
    })));
    const result = await compiler.build(
      files.map((f) => ({ path: f.path, content: f.model.getValue() })),
      { defines, trace, debugInfo, libraries },
    );
    // The serial tracer only for builds that carry its hooks; the inspector for any with debug info.
    builtLineTable = result.instrumented ? result.lineTable : undefined;
    if (import.meta.env.DEV) Object.assign(window, { lastElf: result.elf });
    inspector.attach(result.lineTable, result.elf, result.parts.find((p) => p.name === "app.bin"));
    saveBuild({ sources: sourcesKey(), lineTable: result.lineTable, elf: result.elf, app: result.parts.find((p) => p.name === "app.bin"), instrumented: result.instrumented });
    for (const f of files) setDiagnostics(f.model, result.diagnostics, f.path);
    const app = result.parts.find((p) => p.name === "app.bin")!;
    out.log(`Build OK in ${(result.durationMs / 1000).toFixed(1)}s, app.bin ${app.data.length} bytes${result.instrumented ? " (with line tracing)" : debugInfo ? " (with debug info for the inspector)" : ""}`, "ok");
    setStatus("Build OK");
    return result.parts;
  } catch (e) {
    if (e instanceof CompileError) {
      for (const f of files) setDiagnostics(f.model, e.diagnostics, f.path);
      // Jump to the first file with an error.
      const bad = files.find((f) => e.diagnostics.some((d) => d.severity === "error" && d.file === `/src/${f.path}`));
      if (bad && editor.getModel() !== bad.model) show(bad);

      // A missing header: suggest a library instead of showing the compiler's error.
      const missing = missingHeaders(e.diagnostics);
      if (missing.length && onlyMissingHeaders(e.diagnostics)) {
        for (const header of missing) {
          out.appendElement(librarySuggestion(header, (name) => {
            out.log(`Installed ${name}; it's kept in this browser for later builds.`, "ok");
            void refreshInstalled();
            retry?.();
          }));
        }
        setStatus("Library missing");
        return undefined;
      }
      if (e.output) out.log(e.output, "error");

      // An installed library that doesn't compile here: offer to remove it, which
      // (on the rebuild) brings back the suggestions for its header.
      const failedLib = /^Compiling library (.+?) \(/.exec(e.message)?.[1];
      if (failedLib) {
        const box = document.createElement("div");
        box.className = "lib-suggest";
        const remove = document.createElement("button");
        remove.className = "secondary";
        remove.textContent = "Remove and show alternatives";
        remove.onclick = async () => {
          remove.disabled = true;
          await removeLibrary(failedLib);
          await refreshInstalled();
          out.log(`Removed ${failedLib}.`, "muted");
          retry?.();
        };
        box.append(`The library ${failedLib} doesn't compile here; it may not support Arduino-ESP32 3.x / ESP-IDF 6. `, remove);
        out.appendElement(box);
      }
    }
    out.log(`Build failed: ${(e as Error).message}`, "error");
    setStatus("Build failed");
    return undefined;
  }
}

/**
 * Write images to the chip: connect if needed (esptool-js resets the chip into
 * download mode over DTR/RTS), flash, then hand the port to the serial monitor,
 * which resets the chip into the app and shows what it prints.
 */
async function flash(parts: FlashPart[], lineTable?: LineTable) {
  await monitor.stop(); // it holds the port
  debug.attach(undefined);
  // A core halted by the debugger stays halted through the reset into download mode, and the
  // flasher then can't reach the ROM loader: let the chip run and drop JTAG first (and come
  // back once the new program runs).
  const hadJtag = inspector.connected;
  await inspector.release();
  let flashed = false;
  try {
    if (!flasher.connected) {
      setStatus("Entering download mode…");
      const chip = await flasher.connect();
      out.log(`Connected to ${chip}`, "ok");
    }
    await flasher.flash(parts, (pct, name) => setStatus(`Flashing ${name}: ${pct}%`), { reset: false });
    out.log("Flash complete, resetting into the app.", "ok");
    setStatus("Flashed ✓ — monitoring");
    flashed = true;
  } catch (e) {
    out.log(`Flash failed: ${(e as Error).message}`, "error");
    out.log("If the board has no auto-reset circuit: hold BOOT, tap RESET, release BOOT, then press Flash again.", "muted");
    setStatus("Flash failed");
  }
  const port = flasher.currentPort;
  await flasher.disconnect().catch(() => {});
  if (!flashed || !port) return;
  // The build now on the chip; with a line table, its running line gets highlighted.
  debug.attach(lineTable);
  try {
    // Reading starts before the reset, so the boot log shows up too.
    await monitor.start(port, { reset: true });
  } catch (e) {
    out.log(`Serial monitor failed to start: ${(e as Error).message}`, "error");
  }
  if (hadJtag) void inspector.reconnect();
}

/** Save build outputs as files (CH32V003: there's no in-browser flasher for it). */
function downloadLinks(parts: FlashPart[]) {
  const row = document.createElement("div");
  row.append("Download: ");
  for (const p of parts) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([p.data as BlobPart], { type: "application/octet-stream" }));
    a.download = p.name.replace("app", "ch32v003");
    a.textContent = a.download;
    a.className = "download-link";
    row.append(a, " ");
  }
  out.appendElement(row);
}

/**
 * CH32V003: flash over its UART (the board's USB-serial chip) with WCH's USART IAP
 * bootloader, then show what the program prints. The serial port is the CH32's own,
 * remembered separately from the ESP32-S3's.
 */
let ch32Port: SerialPort | undefined;
async function flashCh32() {
  if (selectCh32Via.value === "funprog") return flashCh32Funprog();
  try {
    const known = await navigator.serial.getPorts();
    if (!ch32Port || !known.includes(ch32Port)) {
      setStatus("Select the CH32V003 board's serial port…");
      ch32Port = await navigator.serial.requestPort();
    }
  } catch (e) {
    out.log(`No serial port selected: ${(e as Error).message}`, "error");
    return;
  }
  const parts = await build(() => btnFlash.click());
  if (!parts) return;
  downloadLinks(parts);
  await monitor.stop(); // it holds the port
  const iap = new Ch32Iap(ch32Port, (t) => out.log(t, "ok"));
  try {
    await iap.open();
    setStatus("Waiting for the CH32V003 bootloader…");
    out.log("Looking for the USART IAP bootloader (460800 baud)… If it doesn't answer, reset the board into it now.", "muted");
    if (!(await iap.detect(20000))) {
      throw new Error("The bootloader didn't answer. It has to be installed once with a WCH-LinkE (WCH's USART_IAP " +
        "example), and running: right after power-up or reset, before it starts the app (or with PC0 high, in its " +
        "PC0 mode). The downloads above work with minichlink or WCH-LinkUtility.");
    }
    await iap.flash(parts[0].data, (pct, stage) => setStatus(`${stage}: ${pct}%`));
    setStatus("Flashed: running");
    if (ch32Built) ch32NowRuns(ch32Built);
  } catch (e) {
    out.log(`Flash failed: ${(e as Error).message}`, "error");
    setStatus("Flash failed");
    return;
  } finally {
    await iap.close();
  }
  // ch32fun's UART printf (FUNCONF_USE_UARTPRINTF) uses 115200 baud, as the monitor does.
  await monitor.start(ch32Port).catch((e) => out.log(`Serial monitor failed: ${(e as Error).message}`, "error"));
}

/**
 * CH32V003 over SWIO, through a funprog programmer (ch32fun's programmer firmware,
 * e.g. the ESP32-S3 example funprog › CH32V003_Programmer) with WebHID: what
 * minichlink -w does. Needs no bootloader on the chip.
 */
async function flashCh32Funprog() {
  let prog: FunprogHid;
  try {
    // Pick the device first: Chrome only shows the picker during the click.
    setStatus("Select the funprog programmer…");
    prog = await FunprogHid.pick((t) => out.log(t, "muted"));
  } catch (e) {
    out.log(`No programmer selected: ${(e as Error).message}. Flash the ESP32-S3 example funprog › CH32V003_Programmer ` +
      "and connect its native USB port.", "error");
    return;
  }
  const parts = await build(() => btnFlash.click());
  if (!parts) return;
  downloadLinks(parts);
  // The inspector holds the programmer, and its breakpoints are in the old program's flash.
  await ch32Inspector?.release();
  try {
    await prog.open();
    setStatus("Connecting to the CH32V003…");
    await prog.connect();
    await prog.flash(parts[0].data, (pct, stage) => setStatus(`${stage}: ${pct}%`));
    await prog.run();
    out.log(`Flashed ${parts[0].data.length} bytes over SWIO and started the program.`, "ok");
    setStatus("Flashed: running");
  } catch (e) {
    out.log(`Flash failed: ${(e as Error).message}`, "error");
    setStatus("Flash failed");
    return;
  } finally {
    await prog.close();
  }
  if (ch32Built) ch32NowRuns(ch32Built);
  // Connected right away: the program's printf comes over SWIO, and it can be paused and stepped.
  void ch32Inspector?.reconnect();
}

/** A CH32V003 build was flashed: the inspector follows it (kept for a page reload too). */
function ch32NowRuns(b: Ch32Build): void {
  ch32Attach(b);
  void dbRequest(BUILDS, "readwrite", (st) => st.put(b, "last-ch32")).catch(() => { /* best effort */ });
}

// One click: compile → download mode → flash → reset.
btnFlash.onclick = () =>
  exclusive(async () => {
    if (mode === "ch32v003") return flashCh32();
    try {
      // Pick the port first: Chrome only shows the picker during the click, and
      // the first build may spend a while downloading the toolchain.
      setStatus("Select the ESP32-S3's serial port…");
      await flasher.pickPort();
    } catch (e) {
      out.log(`No serial port selected: ${(e as Error).message}`, "error");
      return;
    }
    const parts = await build(() => btnFlash.click());
    if (parts) await flash(parts, builtLineTable);
  });

// ---- Debug tools: the same steps one at a time ----

btnBuild.onclick = () => exclusive(async () => void (await build(() => btnBuild.click())));

btnConnect.onclick = () =>
  exclusive(async () => {
    await monitor.stop();
    try {
      if (flasher.connected) {
        await flasher.disconnect();
        setStatus("Disconnected");
      } else {
        setStatus("Connecting…");
        const chip = await flasher.connect();
        out.log(`Connected to ${chip}`, "ok");
        setStatus(`Connected: ${chip}`);
      }
    } catch (e) {
      out.log(`Connection failed: ${(e as Error).message}`, "error");
      setStatus("Idle");
    }
  });

// Drive BOOT/RESET through the serial DTR/RTS lines (see flasher/reset.ts).
const signalCommand = (label: string, run: () => Promise<void>, done: string) =>
  exclusive(async () => {
    try {
      await run();
      const via = flasher.usesNativeUsb ? "native USB-Serial/JTAG" : "DTR/RTS auto-reset";
      out.log(`${done} (${via})`, "ok");
      setStatus(done);
    } catch (e) {
      out.log(`${label} failed: ${(e as Error).message}`, "error");
    }
  });

btnBoot.onclick = () =>
  signalCommand("Boot mode", async () => {
    await monitor.stop(); // a chip in download mode prints nothing useful
    await flasher.enterBootMode();
  }, "Chip is in download mode");
// While monitoring, reset through the monitor's open port so the boot log shows up.
btnDisconnect.onclick = () =>
  exclusive(async () => {
    await monitor.stop();
    await flasher.disconnect().catch(() => {});
    out.log("Disconnected; the serial port is free.", "muted");
    setStatus("Disconnected");
  });

btnReset.onclick = () => {
  if (mode === "ch32v003" && ch32Inspector?.connected) {
    void ch32Inspector.restartProgram().then(() => out.log("CH32V003 restarted.", "muted"), (e) => out.log(`Restart failed: ${(e as Error).message}`, "error"));
    return;
  }
  signalCommand("Reset", () => (monitor.running ? monitor.reset() : flasher.reset()), "Chip reset, app running");
};

/** Whether the serial monitor was on, so a page reload turns it back on. */
const MONITOR_KEY = "esp-wasm:monitor";

btnMonitor.onclick = () =>
  exclusive(async () => {
    if (monitor.running) {
      await monitor.stop();
      storage.set(MONITOR_KEY, "");
      out.log("Serial monitor stopped.", "muted");
      return;
    }
    try {
      await flasher.disconnect(); // the monitor needs the port to itself
      await monitor.start(await flasher.pickPort());
      storage.set(MONITOR_KEY, "1");
    } catch (e) {
      out.log(`Serial monitor failed to start: ${(e as Error).message}`, "error");
    }
  });

// Flash user-supplied binaries, placed by file name (e.g. an `idf.py build` output).
inputBins.onchange = async () => {
  const files = [...(inputBins.files ?? [])];
  inputBins.value = "";
  const parts: FlashPart[] = [];
  for (const f of files) {
    const data = new Uint8Array(await f.arrayBuffer());
    const address = /bootloader/i.test(f.name) ? FLASH_OFFSETS.bootloader
      : /partition/i.test(f.name) ? FLASH_OFFSETS.partitionTable
      : FLASH_OFFSETS.app;
    parts.push({ name: f.name, address, data });
    out.log(`${f.name} → 0x${address.toString(16)}`, "muted");
  }
  if (parts.length) await exclusive(() => flash(parts));
};

$("btn-clear").onclick = () => out.clear();

out.log("esp-wasm: ESP32-S3 compiler and flasher that runs entirely in your browser.", "muted");
refreshButtons();
// After a reload: give the inspector the last build back (if the sources haven't changed since).
void restoreBuild();
// After a reload: the serial monitor was on, so turn it back on, if the port can be had without
// asking (the one this page was allowed before). Opening it leaves the chip running.
if (storage.get(MONITOR_KEY) && "serial" in navigator) {
  void navigator.serial.getPorts().then((ports) => {
    if (ports.length !== 1 || monitor.running) return;
    return exclusive(async () => {
      if (!monitor.running) await monitor.start(await flasher.pickPort());
    });
  }).catch((e) => out.log(`Serial monitor failed to start: ${(e as Error).message}`, "error"));
}
