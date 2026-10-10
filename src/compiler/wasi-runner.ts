import { ConsoleStdout, File, OpenFile, PreopenDirectory, WASI, WASIProcExit } from "@bjorn3/browser_wasi_shim";
import type { Vfs } from "./vfs";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a WASI command (clang, ld, …) to completion against the shared VFS. */
export async function runWasi(module: WebAssembly.Module, argv: string[], vfs: Vfs): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fds = [
    new OpenFile(new File([])), // stdin
    ConsoleStdout.lineBuffered((l) => stdout.push(l)),
    ConsoleStdout.lineBuffered((l) => stderr.push(l)),
    new PreopenDirectory("/", vfs.root),
  ];
  // debug must be explicit: the shim turns logging on when it's left undefined.
  const wasi = new WASI(argv, ["PWD=/", "HOME=/tmp", "TMPDIR=/tmp"], fds, { debug: false });
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });

  let exitCode: number;
  try {
    exitCode = wasi.start(instance as unknown as Parameters<WASI["start"]>[0]);
  } catch (e) {
    if (e instanceof WASIProcExit) exitCode = e.code;
    else throw e;
  }
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
