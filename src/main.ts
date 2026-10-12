import "./styles.css";
import { CompileError, CompilerClient } from "./compiler/client";
import type { FlashPart } from "./compiler/types";
import { ARDUINO_SOURCE, IDF_SOURCE } from "./editor/default-sketch";
import {
  type TextModel, createEditor, disposeModel, fileModel, languageFor, setDiagnostics,
} from "./editor/editor";
import { FLASH_OFFSETS } from "./image/flash-layout";
import { Flasher, isWebSerialSupported } from "./flasher/flasher";
import { SerialMonitor } from "./flasher/monitor";
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
const btnExamples = $<HTMLButtonElement>("btn-examples");
const tabsEl = $("tabs");
const chkTrace = $<HTMLInputElement>("chk-trace");
// The single-step tools (Build, Connect, Boot mode, Monitor, Flash .bin…) are for troubleshooting.
$("debug-tools").hidden = !new URLSearchParams(location.search).has("tools");
const debugBar = $("debug-bar");
const dbgPause = $<HTMLButtonElement>("dbg-pause");
const dbgOver = $<HTMLButtonElement>("dbg-over");
const dbgInto = $<HTMLButtonElement>("dbg-into");
const dbgOut = $<HTMLButtonElement>("dbg-out");
const dbgWhere = $("dbg-where");

// Project types. Both link against the same sysroot: an Arduino sketch
// provides setup()/loop(), an ESP-IDF program provides app_main().
const MODES = {
  arduino: { file: "sketch.ino", language: "cpp", source: ARDUINO_SOURCE },
  idf: { file: "main.c", language: "c", source: IDF_SOURCE },
} as const;
type Mode = keyof typeof MODES;

const storage = {
  get: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const editor = createEditor($("editor"));
let mode: Mode = storage.get("esp-wasm:mode") === "idf" ? "idf" : "arduino";

/** A file of the current project: its path in the build and its editor model. */
interface ProjectFile {
  path: string;
  model: TextModel;
}

/** The main file of a project type; its contents are kept in localStorage. */
function mainFile(m: Mode): ProjectFile {
  const { file, language, source } = MODES[m];
  const key = `esp-wasm:${file}`;
  const fresh = !savedModels.has(file);
  const model = fileModel(file, language, () => storage.get(key) ?? source);
  if (fresh) {
    model.onDidChangeContent(() => storage.set(key, model.getValue()));
    savedModels.add(file);
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

/** All files of the current project, main file first. */
const projectFiles = (): ProjectFile[] => (mode === "arduino" ? [mainFile("arduino"), ...extras] : [mainFile("idf")]);
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

function setMode(m: Mode) {
  mode = m;
  selectMode.value = m;
  storage.set("esp-wasm:mode", m);
  show(projectFiles()[0]);
}
setMode(mode);
selectMode.onchange = () => setMode(selectMode.value as Mode);

/** Replace the Arduino project with an example (asks first if the current sketch was changed). */
function openExample(ex: Example) {
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
    if (d.hardware) setStatus("Inspecting over JTAG");
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
debug.onBreakpointsChanged = () => inspector.breakpointsChanged();
// For poking at the inspector from the browser's console while developing.
if (import.meta.env.DEV) Object.assign(window, { inspector, editor, debug });
const btnJtag = $<HTMLButtonElement>("btn-jtag");
btnJtag.disabled = !isWebUsbSupported();
btnJtag.onclick = () => {
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

/** After a reload: the last build again, if the sources are still the ones it was made from. */
async function restoreBuild(): Promise<void> {
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

// One click: compile → download mode → flash → reset.
btnFlash.onclick = () =>
  exclusive(async () => {
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

btnReset.onclick = () =>
  signalCommand("Reset", () => (monitor.running ? monitor.reset() : flasher.reset()), "Chip reset, app running");

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
