import { gunzip, untar } from "./tar";
import { Vfs } from "./vfs";
import type { LogLevel } from "./types";

/**
 * public/toolchain/manifest.json, written by toolchain/build-sysroot.sh.
 * Every URL is relative to the manifest.
 */
export interface ToolchainManifest {
  version: string;
  tools: {
    clang: { url: string; argv0: string };
    ld: { url: string; argv0: string };
  };
  /** tar.gz holding the sysroot/ directory (headers, libs, ld scripts, flags/) */
  sysroot: string;
  bootloader: string;
  partitionTable: string;
  image: { flashMode: "qio" | "dio"; flashFreq: "80m" | "40m"; flashSize: "2MB" | "4MB" | "8MB" | "16MB" };
}

export interface Toolchain {
  manifest: ToolchainManifest;
  clang: WebAssembly.Module;
  ld: WebAssembly.Module;
  vfs: Vfs;
  bootloader: Uint8Array;
  partitionTable: Uint8Array;
}

type Log = (text: string, level?: LogLevel) => void;

/** Fetch through the Cache API so the large assets download once per toolchain version. */
async function cachedFetch(url: URL, cacheName: string, log: Log): Promise<Uint8Array> {
  const cache = "caches" in self ? await caches.open(cacheName) : undefined;
  let res = await cache?.match(url);
  if (!res) {
    log(`Downloading ${url.pathname.split("/").pop()}…`, "muted");
    res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
    await cache?.put(url, res.clone());
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadToolchain(manifestUrl: string, log: Log): Promise<Toolchain> {
  const manifestHref = new URL(manifestUrl);
  const res = await fetch(manifestHref, { cache: "no-cache" });
  // Dev servers and SPA hosts answer missing files with index.html, so check the type too.
  if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
    throw new Error(
      `No toolchain found at ${manifestHref.pathname}. ` +
        "Build it with toolchain/build-all.sh (see toolchain/README.md).",
    );
  }
  const manifest = (await res.json()) as ToolchainManifest;
  const cacheName = `esp-wasm-toolchain-${manifest.version}`;
  const get = (rel: string) => cachedFetch(new URL(rel, manifestHref), cacheName, log);

  const [clangBytes, ldBytes, sysrootGz, bootloader, partitionTable] = await Promise.all([
    get(manifest.tools.clang.url),
    get(manifest.tools.ld.url),
    get(manifest.sysroot),
    get(manifest.bootloader),
    get(manifest.partitionTable),
  ]);

  log("Preparing toolchain…", "muted");
  const [clang, ld] = await Promise.all([
    WebAssembly.compile(clangBytes as BufferSource),
    WebAssembly.compile(ldBytes as BufferSource),
  ]);
  const vfs = new Vfs(untar(await gunzip(sysrootGz)));

  // Drop stale caches from earlier toolchain versions.
  if ("caches" in self) {
    for (const name of await caches.keys()) {
      if (name.startsWith("esp-wasm-toolchain-") && name !== cacheName) await caches.delete(name);
    }
  }
  return { manifest, clang, ld, vfs, bootloader, partitionTable };
}
