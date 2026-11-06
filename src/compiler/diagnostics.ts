/** Compiler messages and build failures (shared by the ESP32-S3 and CH32V003 builds). */
import type { Diagnostic } from "./types";

const DIAG_RE = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$/;

export function parseDiagnostics(stderr: string): Diagnostic[] {
  return stderr.split("\n").flatMap((line) => {
    const m = DIAG_RE.exec(line);
    if (!m) return [];
    return [{
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: (m[4] === "fatal error" ? "error" : m[4]) as Diagnostic["severity"],
      message: m[5],
    }];
  });
}

export class BuildError extends Error {
  /** output: the compiler's messages, for the page to show (or replace with a suggestion). */
  constructor(message: string, readonly diagnostics: Diagnostic[] = [], readonly output = "") {
    super(message);
  }
}
