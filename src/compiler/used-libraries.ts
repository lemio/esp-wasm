/**
 * Which installed libraries a build needs: those whose headers the user's code
 * includes, directly or through another needed library (as the Arduino IDE
 * picks libraries). The rest stay out of the build, so an installed library the
 * sketch doesn't use can't break it, e.g. NimBLE-Arduino, whose own copy of the
 * NimBLE stack clashes with ESP-IDF's at link time.
 */
import type { BuildLibrary, SourceFile } from "./types";

const INCLUDE = /^\s*#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/gm;

function includes(text: string): string[] {
  return [...text.matchAll(INCLUDE)].map((m) => m[1].replace(/^\.\//, ""));
}

/** The headers a library provides, as code includes them (relative to its include dirs). */
function providedHeaders(lib: BuildLibrary): string[] {
  const headers: string[] = [];
  for (const f of lib.files) {
    if (!/\.(h|hh|hpp|hxx)$/i.test(f.path)) continue;
    for (const d of lib.includeDirs) {
      const prefix = d === "." || d === "" ? "" : `${d.replace(/\/$/, "")}/`;
      if (f.path.startsWith(prefix)) headers.push(f.path.slice(prefix.length));
    }
  }
  return headers;
}

export function usedLibraries(sources: SourceFile[], libraries: BuildLibrary[]): BuildLibrary[] {
  const byHeader = new Map<string, BuildLibrary>();
  for (const lib of libraries) {
    for (const h of providedHeaders(lib)) if (!byHeader.has(h)) byHeader.set(h, lib);
  }
  const used = new Set<BuildLibrary>();
  const queue = sources.flatMap((s) => includes(s.content));
  const seen = new Set<string>();
  while (queue.length) {
    const h = queue.pop()!;
    if (seen.has(h)) continue;
    seen.add(h);
    const lib = byHeader.get(h);
    if (!lib || used.has(lib)) continue;
    used.add(lib);
    for (const f of lib.files) queue.push(...includes(f.content));
  }
  // Keep the installed order (it's the link order).
  return libraries.filter((l) => used.has(l));
}
