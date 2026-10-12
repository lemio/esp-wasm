/**
 * Documentation comments of classes and their data members, taken from the source code of the
 * sketch and its libraries, so the inspector can say what each member of an object is for:
 *
 *     uint8_t *pixels;    ///< Holds LED color values (3 or 4 bytes each)
 *
 * gives the member `pixels` the text "Holds LED color values (3 or 4 bytes each)". Handles the
 * usual styles: a trailing `///<`, `//!<` or `//` comment, or a `///`, `//` or `/** … *\/` block
 * just above the declaration (Doxygen tags like @brief are dropped).
 */
import type { DebugInfo } from "./dwarf-info";

interface Source {
  path: string;
  content: string;
}

const clean = (text: string) =>
  text
    .replace(/^\s*(\/\*[*!]?|\*\/|\*(?!\/)|\/\/\/?<?|\/\/!<?)/gm, "")
    .replace(/\*\/\s*$/gm, "")
    .replace(/@(brief|details|note)\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The comment block that ends just above line `i` (blank lines not allowed in between). */
function commentAbove(lines: string[], i: number): string {
  const out: string[] = [];
  let j = i - 1;
  if (j >= 0 && /\*\/\s*$/.test(lines[j])) {
    // A /* … */ block: back to its start.
    while (j >= 0) {
      out.unshift(lines[j]);
      if (/\/\*/.test(lines[j])) break;
      j--;
    }
  } else {
    while (j >= 0 && /^\s*\/\//.test(lines[j])) out.unshift(lines[j--]);
  }
  return clean(out.join("\n"));
}

/** The text between the `{` at `open` and its matching `}`. */
function body(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Fill in `doc` of the structs and members in `info` from the given sources. */
export function attachDocs(info: DebugInfo, sources: Source[]): void {
  const wanted = new Map<string, number[]>();
  info.types.forEach((t, i) => {
    if (t.k === "struct" && t.name && t.members.length) wanted.set(t.name, [...(wanted.get(t.name) ?? []), i]);
  });
  if (!wanted.size) return;
  const headersFirst = [...sources].sort((a, b) => Number(/\.(h|hpp)$/.test(b.path)) - Number(/\.(h|hpp)$/.test(a.path)));
  const done = new Set<string>();
  for (const src of headersFirst) {
    for (const m of src.content.matchAll(/\b(class|struct|union)\s+([A-Za-z_]\w*)\b[^;{()]*\{/g)) {
      const name = m[2];
      const types = wanted.get(name);
      if (!types || done.has(name)) continue;
      done.add(name);
      const start = m.index! + m[0].length - 1;
      const lines = src.content.slice(0, m.index).split("\n");
      const classDoc = commentAbove(lines, lines.length - 1 + (lines[lines.length - 1].trim() ? 1 : 0));
      const bodyLines = body(src.content, start).split("\n");
      for (const ti of types) {
        const t = info.types[ti];
        if (t.k !== "struct") continue;
        if (classDoc) t.doc = classDoc;
        for (const member of t.members) {
          if (member.doc || member.name.startsWith("(")) continue;
          // A declaration: a type (one or more words, maybe templated), then the name, then
          // array bounds, a bit width or an initializer. Not an assignment in an inline method.
          const decl = new RegExp(`^\\s*[A-Za-z_][\\w:<>,]*(?:[\\s*&]+[A-Za-z_][\\w:<>,]*)*[\\s*&]+${member.name}\\s*(\\[[^\\]]*\\]\\s*)*(:\\s*\\d+\\s*)?(=[^;(]*)?;(.*)$`);
          for (let i = 0; i < bodyLines.length; i++) {
            const d = decl.exec(bodyLines[i]);
            if (!d) continue;
            const trailing = /\/\/[/!]?<?(.*)$|\/\*+<?(.*?)\*\//.exec(d[4] ?? "");
            const doc = trailing ? clean(trailing[1] ?? trailing[2] ?? "") : commentAbove(bodyLines, i);
            if (doc) member.doc = doc;
            break;
          }
        }
      }
    }
  }
}
