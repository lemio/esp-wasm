/**
 * PlatformIO library registry, used straight from the browser (its API and
 * downloads send CORS headers). Finds libraries that provide a header, and
 * downloads one as a set of source files.
 */
import { gunzip, untar } from "../compiler/tar";

const API = "https://api.registry.platformio.org/v3";

export interface LibraryCandidate {
  owner: string;
  name: string;
  version: string;
  description: string;
  popularity?: number;
}

export interface LibraryFile {
  path: string;
  content: string;
}

/** An installed library: its sources, as the build uses them. */
export interface InstalledLibrary {
  id: string; // "owner/name"
  owner: string;
  name: string;
  version: string;
  /** Include directories, relative to the library root. */
  includeDirs: string[];
  /** Headers, sources and the library's metadata files. */
  files: LibraryFile[];
  installedAt: number;
}

interface SearchItem {
  name: string;
  owner: { username: string };
  description?: string;
  version: { name: string };
  platforms?: { name: string }[];
  frameworks?: { name: string }[];
}

/** Libraries whose headers include `header`, usable with Arduino on an ESP32 (or not limited to a platform). */
export async function searchByHeader(header: string): Promise<LibraryCandidate[]> {
  const url = `${API}/search?query=${encodeURIComponent(`header:${header}`)}&sort=popularity&limit=10`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`PlatformIO registry: ${res.status} ${res.statusText}`);
  const { items } = (await res.json()) as { items: SearchItem[] };
  return items
    .filter((it) => {
      const platforms = (it.platforms ?? []).map((p) => p.name);
      const frameworks = (it.frameworks ?? []).map((f) => f.name);
      return (platforms.length === 0 || platforms.includes("espressif32") || platforms.includes("*")) &&
        (frameworks.length === 0 || frameworks.includes("arduino") || frameworks.includes("*"));
    })
    .map((it) => ({
      owner: it.owner.username,
      name: it.name,
      version: it.version.name,
      description: it.description ?? "",
    }));
}

const SOURCE_EXT = /\.(h|hh|hpp|hxx|inc|inl|ipp|tpp|c|cc|cpp|cxx|S)$/;
const JSDELIVR_API = "https://data.jsdelivr.com/v1/packages/gh";
const JSDELIVR_CDN = "https://cdn.jsdelivr.net/gh";

/** The package as published on PlatformIO (a .tar.gz). */
async function fromRegistry(downloadUrl: string): Promise<Map<string, Uint8Array>> {
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  return untar(await gunzip(new Uint8Array(await res.arrayBuffer())));
}

/**
 * The same release from GitHub through jsDelivr. Needed because PlatformIO's
 * download redirect sends its Access-Control-Allow-Origin header twice, which
 * browsers reject. Only source and metadata files are fetched.
 */
async function fromGitHub(repoUrl: string, version: string, onProgress?: Progress): Promise<Map<string, Uint8Array>> {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(\.git)?\/?$/.exec(repoUrl);
  if (!m) throw new Error(`Can't download from ${repoUrl} in the browser (only GitHub is supported)`);
  const repo = `${m[1]}/${m[2]}`;
  const info = await fetch(`${JSDELIVR_API}/${repo}`);
  // jsDelivr lists versions as { version: "0.3.2-beta", … }, newest first.
  const versions: string[] = info.ok
    ? ((await info.json()).versions ?? []).map((v: { version?: string } | string) => (typeof v === "string" ? v : v.version ?? ""))
    : [];
  // PlatformIO versions don't always match tag names ("0.3.2" vs "0.3.2-beta", "v0.3.2").
  const ref = [version, `v${version}`].find((v) => versions.includes(v)) ??
    versions.find((v) => v.startsWith(version) || v.startsWith(`v${version}`)) ?? versions[0];
  let listing: { files: { name: string }[] } | undefined;
  let usedRef = "";
  for (const r of [ref, "main", "master"].filter(Boolean) as string[]) {
    const res = await fetch(`${JSDELIVR_API}/${repo}@${r}?structure=flat`);
    if (res.ok) {
      listing = await res.json();
      usedRef = r;
      break;
    }
  }
  if (!listing) throw new Error(`Couldn't find ${repo} on jsDelivr`);
  const wanted = listing.files
    .map((f) => f.name.replace(/^\//, ""))
    .filter((p) => (SOURCE_EXT.test(p) || /^library\.(json|properties)$/.test(p)) &&
      !/(^|\/)(examples?|extras|tests?|docs?)\//i.test(p));
  // One request per file (GitHub's archive download isn't open to other sites),
  // 16 at a time.
  const files = new Map<string, Uint8Array>();
  let next = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const p = wanted[next++];
      const res = await fetch(`${JSDELIVR_CDN}/${repo}@${usedRef}/${p}`);
      if (!res.ok) throw new Error(`Download of ${p} failed: ${res.status}`);
      files.set(p, new Uint8Array(await res.arrayBuffer()));
      onProgress?.(files.size, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, wanted.length) }, worker));
  return files;
}

export type Progress = (done: number, total: number) => void;

/** Download the library's latest version and keep what the build needs. */
export async function downloadLibrary(c: LibraryCandidate, onProgress?: Progress): Promise<InstalledLibrary> {
  const pkgUrl = `${API}/packages/${encodeURIComponent(c.owner)}/library/${encodeURIComponent(c.name)}`;
  const pkg = await (await fetch(pkgUrl, { headers: { Accept: "application/json" } })).json();
  const file = pkg.version?.files?.[0];
  const version: string = pkg.version?.name ?? c.version;
  // GitHub (through jsDelivr) first: PlatformIO's own download currently fails in
  // browsers (duplicate CORS header on its redirect). Its package is the fallback.
  let archive: Map<string, Uint8Array> | undefined;
  let firstError: unknown;
  if (/github\.com/.test(pkg.repository_url ?? "")) {
    try {
      archive = await fromGitHub(pkg.repository_url, version, onProgress);
    } catch (e) {
      firstError = e;
    }
  }
  if (!archive) {
    if (!file?.download_url) throw firstError ?? new Error(`No download for ${c.owner}/${c.name}`);
    try {
      archive = await fromRegistry(file.download_url);
    } catch (e) {
      throw new Error(`Can't download ${c.name}: ${((firstError ?? e) as Error).message}`);
    }
  }

  // Strip a single top-level folder, if the archive has one.
  let entries = [...archive.entries()].filter(([p]) => !p.endsWith("/"));
  const tops = new Set(entries.map(([p]) => p.split("/")[0]));
  if (tops.size === 1 && entries.every(([p]) => p.includes("/"))) {
    const top = [...tops][0] + "/";
    entries = entries.map(([p, d]) => [p.slice(top.length), d]);
  }
  const dec = new TextDecoder();
  const all = new Map(entries.map(([p, d]) => [p, d]));
  const text = (p: string) => (all.has(p) ? dec.decode(all.get(p)) : undefined);

  // Where the sources are: library.json "build" settings, else the Arduino layout
  // (src/ recursively, or the root folder plus utility/).
  let srcDir = "";
  let includeDir: string | undefined;
  const json = text("library.json");
  if (json) {
    try {
      const build = JSON.parse(json).build ?? {};
      if (typeof build.srcDir === "string") srcDir = build.srcDir.replace(/^\.\/|\/$/g, "");
      if (typeof build.includeDir === "string") includeDir = build.includeDir.replace(/^\.\/|\/$/g, "");
    } catch { /* malformed library.json: use the defaults */ }
  }
  if (!srcDir && [...all.keys()].some((p) => p.startsWith("src/"))) srcDir = "src";
  const inSources = (p: string) => {
    if (/(^|\/)(examples?|extras|tests?|docs?)\//i.test(p)) return false;
    if (srcDir) return p.startsWith(srcDir + "/");
    return !p.includes("/") || p.startsWith("utility/");
  };
  const files: LibraryFile[] = [];
  for (const [p, d] of all) {
    if ((SOURCE_EXT.test(p) && inSources(p)) || (includeDir && p.startsWith(includeDir + "/") && SOURCE_EXT.test(p))) {
      files.push({ path: p, content: dec.decode(d) });
    }
  }
  for (const meta of ["library.json", "library.properties"]) {
    const t = text(meta);
    if (t) files.push({ path: meta, content: t });
  }
  if (!files.some((f) => SOURCE_EXT.test(f.path))) throw new Error(`${c.name} has no source files`);

  const includeDirs = [includeDir, srcDir || "."].filter((d): d is string => d !== undefined);
  if (!srcDir && files.some((f) => f.path.startsWith("utility/"))) includeDirs.push("utility");
  return {
    id: `${c.owner}/${c.name}`,
    owner: c.owner,
    name: c.name,
    version,
    includeDirs: [...new Set(includeDirs)],
    files,
    installedAt: Date.now(),
  };
}

export interface Dependency {
  owner?: string;
  name: string;
}

/** Dependencies a library declares, in library.json (PlatformIO) or library.properties (Arduino). */
export function declaredDependencies(files: LibraryFile[]): Dependency[] {
  const deps: Dependency[] = [];
  const json = files.find((f) => f.path === "library.json")?.content;
  if (json) {
    try {
      const d = JSON.parse(json).dependencies;
      const list: unknown[] = Array.isArray(d) ? d : d && typeof d === "object" ? Object.keys(d).map((name) => ({ name })) : [];
      for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const { owner, name, platforms, frameworks } = item as Record<string, unknown>;
        const has = (v: unknown, want: string) => v === undefined || v === "*" || v === want ||
          (Array.isArray(v) && (v.includes(want) || v.includes("*")));
        if (typeof name === "string" && has(platforms, "espressif32") && has(frameworks, "arduino")) {
          deps.push({ owner: typeof owner === "string" ? owner : undefined, name });
        }
      }
    } catch { /* malformed library.json */ }
  }
  const props = files.find((f) => f.path === "library.properties")?.content;
  const depends = props && /^depends=(.*)$/m.exec(props)?.[1];
  if (depends) {
    for (const d of depends.split(",")) {
      const name = d.replace(/\(.*\)/, "").trim();
      if (name) deps.push({ name });
    }
  }
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  return deps.filter((d, i) => deps.findIndex((x) => key(x.name) === key(d.name)) === i);
}

/** Find a dependency on the registry by (owner and) exact name. */
export async function resolveDependency(dep: Dependency): Promise<LibraryCandidate | undefined> {
  if (dep.owner) {
    const res = await fetch(`${API}/packages/${encodeURIComponent(dep.owner)}/library/${encodeURIComponent(dep.name)}`,
      { headers: { Accept: "application/json" } });
    if (res.ok) {
      const p = await res.json();
      return { owner: p.owner.username, name: p.name, version: p.version.name, description: p.description ?? "" };
    }
  }
  const url = `${API}/search?query=${encodeURIComponent(`name:"${dep.name}"`)}&sort=popularity&limit=10`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return undefined;
  const { items } = (await res.json()) as { items: SearchItem[] };
  const key = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  const it = items.find((i) => key(i.name) === key(dep.name));
  return it && { owner: it.owner.username, name: it.name, version: it.version.name, description: it.description ?? "" };
}
