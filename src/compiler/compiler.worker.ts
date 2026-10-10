/// <reference lib="webworker" />
import { BuildError, build } from "./pipeline";
import { loadToolchain, type Toolchain } from "./toolchain";
import type { LogLevel, WorkerRequest, WorkerResponse } from "./types";

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });
const log = (text: string, level: LogLevel = "info") => post({ type: "log", text, level });

let toolchain: Promise<Toolchain> | undefined;
const getToolchain = (url: string) => {
  toolchain ??= loadToolchain(url, log).catch((e) => {
    toolchain = undefined; // let the next request retry
    throw e;
  });
  return toolchain;
};

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const tc = await getToolchain(req.toolchainUrl);
    if (req.type === "preload") {
      post({ type: "done", id: req.id });
      return;
    }
    const result = await build(tc, req.sources, log, req.options);
    // Only app.bin is freshly allocated. The others are reused and mustn't be transferred.
    const app = result.parts.find((p) => p.name === "app.bin")!;
    post({ type: "done", id: req.id, result }, [app.data.buffer]);
  } catch (e) {
    post({
      type: "failed",
      id: req.id,
      error: e instanceof Error ? e.message : String(e),
      diagnostics: e instanceof BuildError ? e.diagnostics : [],
      output: e instanceof BuildError ? e.output : "",
    });
  }
};
