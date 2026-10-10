import CompilerWorker from "./compiler.worker?worker";
import type { BuildOptions, BuildResult, Diagnostic, LogLevel, SourceFile, WorkerRequest, WorkerResponse } from "./types";

export class CompileError extends Error {
  /** output: the compiler's messages for this failure. */
  constructor(message: string, readonly diagnostics: Diagnostic[], readonly output = "") {
    super(message);
  }
}

type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id" | "toolchainUrl"> : never) : never;

// Relative to the page, so the app works from a subfolder.
const TOOLCHAIN_URL = new URL("toolchain/manifest.json", document.baseURI).href;

type Pending = { resolve: (r?: BuildResult) => void; reject: (e: Error) => void };

/** Main-thread handle to the compiler worker. */
export class CompilerClient {
  private worker = new CompilerWorker();
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(onLog: (text: string, level: LogLevel) => void) {
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === "log") return onLog(msg.text, msg.level);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "done") p.resolve(msg.result);
      else p.reject(new CompileError(msg.error, msg.diagnostics, msg.output));
    };
  }

  private request(req: RequestBody): Promise<BuildResult | undefined> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id, toolchainUrl: TOOLCHAIN_URL } as WorkerRequest);
    });
  }

  /** Download and cache the toolchain ahead of the first build. */
  async preload(): Promise<void> {
    await this.request({ type: "preload" });
  }

  async build(sources: SourceFile[], options: BuildOptions = {}): Promise<BuildResult> {
    return (await this.request({ type: "build", sources, options }))!;
  }
}
