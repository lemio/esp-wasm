/**
 * One Arduino project inside someone else's page (see public/embed.js): an editor, Check and
 * Upload, and what the board prints. The same compiler, flasher and monitor as the full IDE.
 *
 * The page passes the project in the URL fragment: #code=<base64url>&board=<id>&id=<key>&theme=light|dark&buttons=upload,check,download.
 * It talks to the host page with postMessage (all messages carry source: "esp-wasm" and the id):
 *   out → { type: "height", px }                      size the iframe to its content
 *   out → { type: "status", state, text }             idle | building | built | failed | uploading | running | error
 *   out → { type: "serial", text }                    what the board prints
 *   in  ← { source: "esp-wasm-host", type: "check" | "upload" | "reset" | "set-code" | "send" | "connect", code?, text? }
 *         send: text to the running sketch (its Serial.read()); connect: listen to a board that already runs the sketch
 */
import "./embed.css";
import { CompileError, CompilerClient } from "../compiler/client";
import type { FlashPart } from "../compiler/types";
import { createEditor, fileModel, setDiagnostics } from "../editor/editor";
import { Flasher, isWebSerialSupported } from "../flasher/flasher";
import { SerialMonitor } from "../flasher/monitor";
import { Console } from "../ui/console";
import { FLASH_OFFSETS } from "../image/flash-layout";
import { Debugger, TraceFilter } from "../debug/trace-view";
import { boardFor } from "./boards";
import { variantFor } from "../compiler/variant";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.hash.slice(1));
const fromBase64Url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

const original = params.has("code") ? fromBase64Url(params.get("code")!) : "void setup() {\n}\n\nvoid loop() {\n}\n";
const board = boardFor(params.get("board"));
// Files from the page that the sketch uses but the reader doesn't see (data-file blocks): built like an installed library.
const pageFiles: { path: string; content: string }[] = params.has("files") ? JSON.parse(fromBase64Url(params.get("files")!)) : [];
const pageLibrary = pageFiles.length ? [{
  id: "page", includeDirs: ["."], files: pageFiles,
  // compiled objects are cached by version: a change to the files gets a new one
  version: (pageFiles.reduce((a, f) => [...f.path + f.content].reduce((x, c) => Math.imul(x ^ c.charCodeAt(0), 0x01000193), a), 0x811c9dc5) >>> 0).toString(16),
}] : [];
const theme = params.get("theme");
if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
const dark = theme === "dark" || (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);

// Edits are kept per project, so a reload doesn't lose them; "Reset code" brings the example back.
let h = 0x811c9dc5;
for (const ch of original) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
const projectId = params.get("id") ?? (h >>> 0).toString(16);
const KEY = `esp-wasm:embed:${projectId}`;
const storage = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const post = (msg: Record<string, unknown>) => parent !== window && parent.postMessage({ source: "esp-wasm", id: projectId, ...msg }, "*");

const statusEl = $("status");
const btnCheck = $<HTMLButtonElement>("btn-check");
const btnUpload = $<HTMLButtonElement>("btn-upload");
const btnDownload = $<HTMLButtonElement>("btn-download");
const btnDisconnect = $<HTMLButtonElement>("btn-disconnect");
const btnReset = $<HTMLButtonElement>("btn-reset");
const btnRevert = $<HTMLButtonElement>("btn-revert");
const btnDetails = $<HTMLButtonElement>("btn-details");
const serialEl = $("serial");
const logEl = $("log");
// Two outputs: what the sketch prints (shown as soon as it prints), and the build/upload log (only via Details).
const serial = new Console(serialEl);
const out = new Console(logEl);
// Buttons besides Upload, only if the page asked for them (simulate isn't available here)
const wanted = new Set((params.get("buttons") ?? "upload").toLowerCase().split(/[\s,]+/));
btnCheck.hidden = !(wanted.has("check") || wanted.has("build") || wanted.has("verify"));
btnDownload.hidden = !wanted.has("download");
// Reset appears after an upload: by default, or when the page's buttons list names it; reset="off" leaves it out
const resetWanted = (params.has("buttons") ? wanted.has("reset") : true) && !/^(off|false|0|no)$/i.test(params.get("reset") ?? "");
// Line highlighting (a Trace build): on by default, the running line glows in the editor. trace="off" turns it off.
const tracing = !/^(off|false|0|no)$/i.test(params.get("trace") ?? "");
// serial=off: the host page shows the board's output its own way (it still gets "serial" messages)
const serialShown = !/^(off|false|0|no)$/i.test(params.get("serial") ?? "");

function setStatus(state: string, text: string) {
  statusEl.textContent = text;
  statusEl.className = `status ${state === "built" || state === "running" ? "ok" : state === "failed" || state === "error" ? "error" : ""}`;
  post({ type: "status", state, text });
}
function showLog(open: boolean) {
  logEl.hidden = !open;
  btnDetails.hidden = false;
  btnDetails.setAttribute("aria-expanded", String(open));
  btnDetails.textContent = open ? "Hide details" : "Details";
  resize();
}
btnDetails.onclick = () => showLog(logEl.hidden !== false);

// ---- the editor: as tall as its code, so the host page scrolls, not the editor
const editorEl = $("editor");
const editor = createEditor(editorEl, {
  theme: dark ? "vs-dark" : "vs",
  minimap: { enabled: false },
  glyphMargin: false,
  fontSize: 13,
  lineNumbersMinChars: 3,
  folding: false,
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  padding: { top: 10, bottom: 10 },
  scrollbar: { alwaysConsumeMouseWheel: false, vertical: "hidden" },
});
const model = fileModel("sketch.ino", "cpp", () => storage.get(KEY) ?? original);
editor.setModel(model);
const sync = () => {
  const changed = model.getValue() !== original;
  storage.set(KEY, changed ? model.getValue() : null);
  btnRevert.hidden = !changed;
};
model.onDidChangeContent(sync);
sync();
btnRevert.onclick = () => model.setValue(original);

function resize() {
  const lines = Math.min(Math.max(editor.getContentHeight(), 120), 640);
  editorEl.style.height = `${lines}px`;
  editor.layout();
  post({ type: "height", px: document.querySelector(".embed")!.getBoundingClientRect().height + 2 });
}
editor.onDidContentSizeChange(resize);
new ResizeObserver(resize).observe(document.querySelector(".embed")!);
resize();

// ---- compile, upload, monitor: as in the full IDE (main.ts), without the extras
const compiler = new CompilerClient((text, level) => out.log(text, level));
const flasher = new Flasher(out.asTerminal());
// What the sketch prints, without the chip's own boot messages (ROM banner, bootloader, ESP-IDF info lines)
// (ESP-IDF's own log lines look like "W (270) spi_flash: …", at any level and possibly coloured)
const BOOT_LINE = /^(?:\x1b\[[0-9;]*m)?(?:ESP-ROM:|Build:|rst:0x|boot:0x|SPIWP:|mode:|load:0x|entry 0x|ets |[EWIDV] \(\d+\) [\w.-]+:|Saved PC:|clk_drv|q_drv|d_drv|cs0_drv|hd_drv|wp_drv)/;
let partial = "";
function sketchOutput(chunk: string): string {
  const lines = (partial + chunk).split("\n");
  partial = lines.pop() ?? "";
  return lines.filter((l) => !BOOT_LINE.test(l.replace(/\r$/, ""))).map((l) => l + "\n").join("");
}
let debug: Debugger;   // set below, once the editor exists (it is)
const traceFilter = new TraceFilter((key, value) => debug.marker(key, value));
const monitor = new SerialMonitor({
  data: (text) => {
    const shown = sketchOutput(traceFilter.feed(text));
    if (shown) {
      if (serialShown && serialEl.hidden) { serialEl.hidden = false; resize(); }
      if (serialShown) serial.serial(shown);
      post({ type: "serial", text: shown });
    }
  },
  info: (message, level = "muted") => out.log(message, level),
  portChanged: (port) => flasher.usePort(port),
  stopped: () => { btnDisconnect.hidden = btnReset.hidden = true; debug.detach(); resize(); },
});
// the running line, and a fading trail of the lines that just ran (as in the IDE's Trace)
debug = new Debugger(editor, (file) => (file === "/src/sketch.ino" ? model : undefined), (m) => (m === model ? "/src/sketch.ino" : undefined),
  (command) => monitor.write(command), () => {});
let lineTable: import("../debug/line-table").LineTable | undefined;
// ---- one board, many embeds: a serial port can only be open in one place at a time. The embeds on a page
// (all from this origin, so in every tab too) share it: before uploading, an embed asks the others to let go.
const usb = "BroadcastChannel" in window ? new BroadcastChannel("esp-wasm-usb") : null;
const me = `${projectId}:${Math.random().toString(36).slice(2, 8)}`;
const holding = () => monitor.running || flasher.connected;
/** Let go of the board, because another embed wants it. */
async function release() {
  await monitor.stop();
  await flasher.disconnect().catch(() => {});
  debug.detach();
  btnDisconnect.hidden = btnReset.hidden = true;
  setStatus("idle", "The board is now used by another example on this page");
  resize();
}
usb?.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.from === me) return;
  if (m.type === "claim") {
    // mid-upload: say so, and keep the board; otherwise give it up
    if (busy) { usb.postMessage({ type: "ack", to: m.from, from: me, busy: true }); return; }
    const had = holding();
    usb.postMessage({ type: "ack", to: m.from, from: me, holding: had });
    if (had) void release().then(() => usb.postMessage({ type: "released", to: m.from, from: me }));
  }
});
/** Ask the other embeds for the board; resolves false if one of them is in the middle of an upload. */
function claimBoard(): Promise<boolean> {
  if (!usb) return Promise.resolve(true);
  return new Promise((resolve) => {
    const waiting = new Set<string>(); let refused = false, settled = false;
    const done = (ok: boolean) => { if (settled) return; settled = true; usb.removeEventListener("message", on); resolve(ok); };
    const on = (e: MessageEvent) => {
      const m = e.data; if (!m || m.to !== me) return;
      if (m.type === "ack" && m.busy) refused = true;
      if (m.type === "ack" && m.holding) waiting.add(m.from);
      if (m.type === "released") { waiting.delete(m.from); if (!waiting.size) setTimeout(() => done(true), 250); }   // the port needs a moment to close
    };
    usb.addEventListener("message", on);
    usb.postMessage({ type: "claim", from: me });
    // replies come within a few ms; whoever holds the port answers "released" once it is closed
    setTimeout(() => { if (refused) done(false); else if (!waiting.size) done(true); }, 150);
    setTimeout(() => done(!refused), 3000);
  });
}
/** The board's port: the one this page already granted (shared by every embed), else ask. */
async function boardPort(): Promise<SerialPort> {
  if (!flasher.currentPort && "serial" in navigator) {
    const granted = await navigator.serial.getPorts();
    if (granted.length === 1) flasher.usePort(granted[0]);
  }
  return flasher.pickPort();
}

let busy = false;
const refresh = () => {
  btnCheck.disabled = btnDownload.disabled = btnReset.disabled = busy;
  btnUpload.disabled = busy || !isWebSerialSupported();
  btnUpload.title = isWebSerialSupported() ? "Compile and upload to the board over USB" : "Uploading needs Chrome or Edge (Web Serial)";
};
async function exclusive(action: () => Promise<void>) {
  if (busy) return;
  busy = true; refresh();
  try { await action(); } finally { busy = false; refresh(); }
}

/** forBoard: a build that will run on the board gets the line-highlighting hooks; Check and Download don't need them. */
async function build(forBoard = false): Promise<FlashPart[] | undefined> {
  setStatus("building", "Compiling…");
  setDiagnostics(model, [], "sketch.ino");
  try {
    const result = await compiler.build([{ path: "sketch.ino", content: model.getValue() }], {
      defines: [`ARDUINO_USB_CDC_ON_BOOT=${flasher.usesNativeUsb === false ? 0 : 1}`],
      boardHeader: board.header,
      libraries: pageLibrary,
      trace: tracing && forBoard,
    });
    lineTable = tracing && forBoard ? result.lineTable : undefined;
    setDiagnostics(model, result.diagnostics, "sketch.ino");
    setStatus("built", `Compiled in ${(result.durationMs / 1000).toFixed(1)} s`);
    return result.parts;
  } catch (e) {
    if (e instanceof CompileError) {
      setDiagnostics(model, e.diagnostics, "sketch.ino");
      const first = e.diagnostics.find((d) => d.severity === "error");
      if (e.output) out.log(e.output, "error");
      setStatus("failed", first ? `Line ${first.line}: ${first.message}` : "Didn't compile");
      if (first) editor.revealLineInCenterIfOutsideViewport(first.line);
    } else {
      out.log((e as Error).message, "error");
      setStatus("failed", (e as Error).message);
    }
    btnDetails.hidden = false;   // the full compiler output, if wanted
    resize();
    return undefined;
  }
}

async function upload() {
  try {
    // Chrome only shows the port picker during the click: pick it before compiling (no picker if it was chosen before).
    setStatus("uploading", "Choose the board's USB port…");
    await boardPort();
  } catch {
    setStatus("idle", "No board chosen");
    return;
  }
  // another example on the page may have the board open: ask it to let go
  if (!holding() && !(await claimBoard())) {
    setStatus("idle", "Another example is uploading — try again in a moment");
    return;
  }
  const parts = await build(true);
  if (!parts) return;
  await monitor.stop();
  debug.attach(undefined);
  let flashed = false;
  try {
    if (!flasher.connected) { setStatus("uploading", "Connecting…"); await flasher.connect(); }
    await flasher.flash(parts, (pct) => setStatus("uploading", `Uploading ${pct}%`), { reset: false });
    flashed = true;
  } catch (e) {
    out.log(`Upload failed: ${(e as Error).message}`, "error");
    out.log("If the board doesn't respond: hold BOOT, tap RESET, release BOOT, and upload again.", "muted");
    setStatus("error", "Upload failed — if the board doesn't respond: hold BOOT, tap RESET, release BOOT, then upload again");
    btnDetails.hidden = false;
    resize();
  }
  const port = flasher.currentPort;
  await flasher.disconnect().catch(() => {});
  if (!flashed || !port) return;
  // A USB device sketch (USB.h) takes over the board's USB port: the next upload needs the board in download mode
  if (variantFor([{ path: "sketch.ino", content: model.getValue() }]) === "usb") {
    setStatus("running", "Running — it's a USB device now. To upload again: hold BOOT, tap RESET, release BOOT, then Upload");
    out.log("This sketch makes the board a USB device itself (USB.h), so the USB port no longer listens for uploads. "
      + "To upload another sketch: hold BOOT, tap RESET, release BOOT, then press Upload.", "warn");
  } else setStatus("running", "Running on the board");
  serial.clear(); partial = "";
  btnDisconnect.hidden = false;   // the port stays open for the board's output, until this is clicked
  btnReset.hidden = !resetWanted;
  resize();
  debug.attach(lineTable);        // highlight the running line
  try { await monitor.start(port, { reset: true }); } catch (e) { out.log(`Monitor: ${(e as Error).message}`, "error"); }
}

// Disconnect: the monitor lets go of the port, so another program (or page) can use the board
btnDisconnect.onclick = () => exclusive(async () => {
  await monitor.stop();
  await flasher.disconnect().catch(() => {});
  debug.detach();
  btnDisconnect.hidden = btnReset.hidden = true;
  setStatus("idle", "Disconnected");
  resize();
});

// Reset: the sketch starts again from setup(); through the monitor's open port, so its output shows from the start
btnReset.onclick = () => exclusive(async () => {
  try {
    serial.clear(); partial = "";
    if (monitor.running) await monitor.reset(); else await flasher.reset();
    setStatus("running", "Reset: running from the start");
  } catch (e) {
    out.log(`Reset failed: ${(e as Error).message}`, "error");
    setStatus("error", "Reset failed");
    btnDetails.hidden = false;
  }
});

// Download: the whole firmware (bootloader, partition table, app) as one image, to flash at 0x0
async function download() {
  const parts = await build();
  if (!parts) return;
  const end = Math.max(...parts.map((p) => p.address + p.data.length));
  const image = new Uint8Array(end).fill(0xff);
  for (const p of parts) image.set(p.data, p.address);
  const app = parts.find((p) => p.address === FLASH_OFFSETS.app);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([image], { type: "application/octet-stream" }));
  a.download = "sketch.bin";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  setStatus("built", `Saved sketch.bin (${Math.round(image.length / 1024)} KB${app ? `, app ${Math.round(app.data.length / 1024)} KB` : ""}): flash it at 0x0`);
}

btnCheck.onclick = () => exclusive(async () => void (await build()));
btnDownload.onclick = () => exclusive(download);
btnUpload.onclick = () => exclusive(upload);

// The host page can drive it too (e.g. its own buttons, or code it changes)
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.source !== "esp-wasm-host") return;
  if (m.type === "set-code" && typeof m.code === "string") model.setValue(m.code);
  if (m.type === "check") void exclusive(async () => void (await build()));
  if (m.type === "upload") btnUpload.click();
  if (m.type === "reset" && !btnReset.hidden) btnReset.click();
  if (m.type === "send" && typeof m.text === "string" && monitor.running) void monitor.write(m.text).catch(() => {});
  if (m.type === "connect" && !monitor.running) void exclusive(connect);
});

// Connect: the board already runs this sketch (uploaded earlier): open its port and listen, without uploading
async function connect() {
  if (!holding() && !(await claimBoard())) { setStatus("idle", "Another example is uploading — try again in a moment"); return; }
  let port: SerialPort;
  try { port = await boardPort(); } catch { return; }   // no port picked
  await flasher.disconnect().catch(() => {});
  serial.clear(); partial = "";
  try { await monitor.start(port, { reset: false }); } catch (e) { out.log(`Monitor: ${(e as Error).message}`, "error"); setStatus("error", "Couldn't open the board"); return; }
  setStatus("running", "Connected to the board");
  btnDisconnect.hidden = false;
  btnReset.hidden = !resetWanted;
  resize();
}

refresh();
setStatus("idle", isWebSerialSupported() ? "" : "Uploading needs Chrome or Edge");
// Start fetching the compiler in the background once the project is on screen, so Check is quick.
setTimeout(() => void compiler.preload().catch(() => {}), 1500);
