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
  /**
   * Variants of the sysroot, each a tar.gz of only the files that differ from it (laid over it).
   * "usb": USB mode USB-OTG (TinyUSB), for sketches that use the S3's USB port themselves (USB.h).
   */
  variants?: Record<string, { overlay: string; description?: string }>;
  bootloader: string;
  partitionTable: string;
  image: { flashMode: "qio" | "dio"; flashFreq: "80m" | "40m"; flashSize: "2MB" | "4MB" | "8MB" | "16MB" };
}

export interface Toolchain {
  manifest: ToolchainManifest;
  /** The sysroot's files, as unpacked (variants reuse them). */
  files: Map<string, Uint8Array>;
  /** The toolchain with a sysroot variant laid over the base one (downloaded on first use). */
  variant(name: string): Promise<Toolchain>;
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
  const files = untar(await gunzip(sysrootGz));
  const vfs = new Vfs(files);

  // Drop stale caches from earlier toolchain versions.
  if ("caches" in self) {
    for (const name of await caches.keys()) {
      if (name.startsWith("esp-wasm-toolchain-") && name !== cacheName) await caches.delete(name);
    }
  }
  const variants = new Map<string, Promise<Toolchain>>();
  const tc: Toolchain = {
    manifest, files, clang, ld, vfs, bootloader, partitionTable,
    variant(name) {
      const v = manifest.variants?.[name];
      if (!v) return Promise.reject(new Error(`This toolchain has no "${name}" variant`));
      if (!variants.has(name)) {
        variants.set(name, (async () => {
          const overlay = untar(await gunzip(await get(v.overlay)));
          const merged = new Map(files);
          for (const [path, data] of overlay) merged.set(path, data);
          // its own version: compiled libraries are cached per toolchain version, and these differ
          return { ...tc, manifest: { ...manifest, version: `${manifest.version}+${name}` }, files: merged, vfs: new Vfs(merged) };
        })().catch((e) => { variants.delete(name); throw e; }));
      }
      return variants.get(name)!;
    },
  };
  return tc;
}
