/** Message protocol between the main thread and compiler.worker.ts. */
import type { LineTable } from "../debug/line-table";

export interface BuildOptions {
  /** Extra preprocessor definitions, e.g. "ARDUINO_USB_CDC_ON_BOOT=1". */
  defines?: string[];
  /** Line tracing: instrument the user's code so the running line can be shown. */
  trace?: boolean;
  /**
   * For the JTAG inspector: the user's code unoptimized with full debug info, and no
   * instrumentation (it reads everything from the chip). Takes precedence over `trace`.
   */
  debugInfo?: boolean;
  /** Libraries the user installed (from the PlatformIO registry), compiled with the sketch. */
  libraries?: BuildLibrary[];
}

export interface BuildLibrary {
  id: string;
  version: string;
  /** Include directories relative to the library root ("." for the root). */
  includeDirs: string[];
  files: SourceFile[];
}

export interface SourceFile {
  /** Relative path, e.g. "main.c" */
  path: string;
  content: string;
}

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "note";
  message: string;
}

export interface FlashPart {
  name: string;
  address: number;
  data: Uint8Array;
}

export interface BuildResult {
  parts: FlashPart[];
  /** Trace builds: address → line mapping of the user's sources. */
  lineTable?: LineTable;
  diagnostics: Diagnostic[];
  elfSize: number;
  durationMs: number;
  /** The linked ELF (for the inspector's Program view: disassembly, symbols, sections). */
  elf?: Uint8Array;
  /** The user's code calls the trace hooks (a Trace build without `debugInfo`). */
  instrumented: boolean;
}

export type LogLevel = "info" | "error" | "ok" | "muted";

/**
 * toolchainUrl is the absolute URL of toolchain/manifest.json. The page resolves
 * it: the worker's own URL (assets/… in a build, src/… in dev) isn't a usable base.
 */
export type WorkerRequest =
  | { type: "preload"; id: number; toolchainUrl: string }
  | { type: "build"; id: number; toolchainUrl: string; sources: SourceFile[]; options: BuildOptions };

export type WorkerResponse =
  | { type: "log"; text: string; level: LogLevel }
  | { type: "done"; id: number; result?: BuildResult }
  | { type: "failed"; id: number; error: string; diagnostics: Diagnostic[]; output: string };
