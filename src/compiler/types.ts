/** Message protocol between the main thread and compiler.worker.ts. */
import type { LineTable } from "../debug/line-table";

/** The chips the IDE builds for. */
export type Target = "esp32s3" | "ch32v003";
/** The WCH chips the CH32 sysroot ("ch32v003" target) builds for. */
export type Ch32Chip = "ch32v003" | "ch32x035";

export interface BuildOptions {
  /** The chip to build for (default: the ESP32-S3). */
  target?: Target;
  /** CH32: ch32fun (C, main()) or WCH's Arduino core (sketches, setup()/loop()). Default ch32fun. */
  framework?: "ch32fun" | "arduino";
  /** CH32: which chip (default the CH32V003). Both build from the same CH32 sysroot. */
  chip?: Ch32Chip;
  /** Extra preprocessor definitions, e.g. "ARDUINO_USB_CDC_ON_BOOT=1". */
  defines?: string[];
  /** Line tracing: instrument the user's code so the running line can be shown. */
  trace?: boolean;
  /**
   * For the JTAG inspector: the user's code unoptimized with full debug info, and no
   * instrumentation (it reads everything from the chip). Takes precedence over `trace`.
   */
  debugInfo?: boolean;
  /**
   * CH32 Arduino sketches flashed over SWIO (a funprog programmer): `Serial` prints through the debug
   * connection (shown in the output panel) instead of the UART; `Serial1` is still the UART.
   */
  serialOverSwio?: boolean;
  /**
   * CH32X035 Arduino sketches: `Serial` is the chip's USB port, a CDC device (boards.txt's "USB CDC Serial"),
   * built against the second precompiled core. `Serial1` is still the UART.
   */
  usbSerial?: boolean;
  /** Libraries the user installed (from the PlatformIO registry), compiled with the sketch. */
  libraries?: BuildLibrary[];
  /**
   * A board's own definitions (e.g. which pin LED_BUILTIN is), included into a sketch right
   * after Arduino.h, so they can override the generic ESP32-S3 variant without shifting lines.
   */
  boardHeader?: string;
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
