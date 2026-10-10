/**
 * "Missing library" suggestions: when a build fails because a header isn't
 * found, look up libraries that provide it on the PlatformIO registry and offer
 * to install one.
 */
import type { Diagnostic } from "../compiler/types";
import {
  type InstalledLibrary, type LibraryCandidate, declaredDependencies, downloadLibrary, resolveDependency, searchByHeader,
} from "./registry";
import { listLibraries, saveLibrary } from "./store";

const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Names of the libraries built into the sysroot (toolchain/builtin-libraries.json). */
let builtin: Promise<Set<string>> | undefined;
function builtinLibraries(): Promise<Set<string>> {
  builtin ??= fetch(new URL("toolchain/builtin-libraries.json", document.baseURI))
    .then((r) => (r.ok ? r.json() : []))
    .then((names: string[]) => new Set(names.map(key)))
    .catch(() => new Set<string>());
  return builtin;
}

/**
 * Install the libraries `lib` depends on (and theirs), skipping built-in and
 * already installed ones. Returns the names installed.
 */
async function installDependencies(lib: InstalledLibrary, status: (text: string) => void, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const have = await builtinLibraries();
  const installed = new Set((await listLibraries()).flatMap((l) => [key(l.name), key(l.id.split("/")[1] ?? "")]));
  const added: string[] = [];
  for (const dep of declaredDependencies(lib.files)) {
    if (have.has(key(dep.name)) || installed.has(key(dep.name))) continue;
    status(`Finding ${dep.name}…`);
    const c = await resolveDependency(dep);
    if (!c) continue; // not on the registry; a build will say which header is missing
    const depLib = await downloadLibrary(c, (done, total) => status(`${dep.name}: ${done}/${total}…`));
    await saveLibrary(depLib);
    installed.add(key(depLib.name));
    added.push(`${depLib.name} ${depLib.version}`, ...(await installDependencies(depLib, status, depth + 1)));
  }
  return added;
}

const NOT_FOUND = /^'([^']+)' file not found$/;

/** Headers a build couldn't find (in the user's code or an installed library). */
export function missingHeaders(diagnostics: Diagnostic[]): string[] {
  const headers = diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => NOT_FOUND.exec(d.message)?.[1])
    .filter((h): h is string => !!h);
  return [...new Set(headers)];
}

/** True when every error is a missing header (so the suggestion can replace the error output). */
export const onlyMissingHeaders = (diagnostics: Diagnostic[]) =>
  diagnostics.some((d) => d.severity === "error") &&
  diagnostics.every((d) => d.severity !== "error" || NOT_FOUND.test(d.message));

/**
 * A suggestion box for one missing header. `onInstalled` runs after a library
 * was installed (e.g. to repeat the build).
 */
/** Headers of ESP-IDF itself (not something a library provides). */
const IDF_HEADER = /^(driver|esp_[a-z_]+|soc|hal|rom|freertos|nvs|lwip|mbedtls|sdkconfig)(\/|\.h$)|^esp_[a-z_]+\.h$/;

export function librarySuggestion(header: string, onInstalled: (name: string) => void): HTMLElement {
  if (IDF_HEADER.test(header)) {
    const box = document.createElement("div");
    box.className = "lib-suggest";
    box.append(code(header), " is an ESP-IDF header that ESP-IDF 6 doesn't have. The code that includes it " +
      "was probably written for an older ESP-IDF (Arduino-ESP32 2.x); look for a newer version of that library.");
    return box;
  }
  const box = document.createElement("div");
  box.className = "lib-suggest";
  const title = document.createElement("div");
  title.className = "lib-suggest-title";
  title.append("No library provides ", code(header), " yet. ");
  const status = document.createElement("span");
  status.className = "lib-suggest-status";
  status.textContent = "Searching PlatformIO…";
  title.append(status);
  const list = document.createElement("div");
  list.className = "lib-suggest-list";
  const link = document.createElement("a");
  link.href = `https://registry.platformio.org/search?q=${encodeURIComponent(header)}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Search on PlatformIO";
  box.append(title, list, link);

  searchByHeader(header)
    .then((found) => {
      if (found.length === 0) {
        status.textContent = "PlatformIO has no Arduino/ESP32 library with this header.";
        return;
      }
      status.textContent = found.length === 1 ? "This library has it:" : "These libraries have it:";
      for (const c of found.slice(0, 4)) list.append(candidate(c, box, onInstalled));
    })
    .catch((e) => {
      status.textContent = `Couldn't search PlatformIO (${(e as Error).message}).`;
    });
  return box;
}

function candidate(c: LibraryCandidate, box: HTMLElement, onInstalled: (name: string) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "lib-cand";
  const info = document.createElement("div");
  info.className = "lib-cand-info";
  const name = document.createElement("strong");
  name.textContent = c.name;
  const meta = document.createElement("span");
  meta.className = "lib-cand-meta";
  meta.textContent = ` ${c.version} · by ${c.owner}`;
  info.append(name, meta);
  if (c.description) {
    const d = document.createElement("div");
    d.className = "lib-cand-desc";
    d.textContent = c.description;
    info.append(d);
  }
  const install = document.createElement("button");
  install.className = "secondary";
  install.textContent = "Install";
  install.onclick = async () => {
    for (const b of box.querySelectorAll("button")) b.disabled = true;
    install.textContent = "Installing…";
    try {
      const lib = await downloadLibrary(c, (done, total) => {
        install.textContent = `Downloading ${done}/${total}…`;
      });
      install.textContent = "Saving…";
      const rec = await saveLibrary(lib);
      // Its dependencies too, as the Arduino IDE and PlatformIO do.
      const deps = await installDependencies(lib, (t) => (install.textContent = t));
      install.textContent = "Installed ✓";
      const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
      onInstalled(`${lib.name} ${lib.version} (${lib.files.length} files, ${kb(rec.size)}, stored as ${kb(rec.packedSize)})` +
        (deps.length ? `, with ${deps.join(", ")}` : ""));
    } catch (e) {
      install.textContent = "Install";
      for (const b of box.querySelectorAll("button")) b.disabled = false;
      const err = document.createElement("div");
      err.className = "lib-cand-error";
      err.textContent = `Couldn't install: ${(e as Error).message}`;
      row.append(err);
    }
  };
  row.append(info, install);
  return row;
}

function code(text: string): HTMLElement {
  const c = document.createElement("code");
  c.textContent = text;
  return c;
}
