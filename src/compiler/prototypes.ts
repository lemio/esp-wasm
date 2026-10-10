/**
 * Arduino-style prototype generation for .ino sketches.
 *
 * The Arduino IDE lets a sketch call a function above its definition: before
 * compiling, it inserts a declaration for every top-level function in front of
 * the first function definition. This does the same with a small scanner
 * (instead of the IDE's ctags). `#line` directives keep diagnostics pointing at
 * the user's lines.
 *
 * Handled: free functions at file scope, including attributes/macros in the
 * return type (static, inline, IRAM_ATTR). Skipped, as in the IDE: methods
 * (Foo::bar), templates, and anything inside namespaces, classes or extern "C".
 */

const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "sizeof", "catch", "else", "do"]);
const TYPE_INTRODUCERS = /\b(class|struct|union|enum|namespace|typedef|template|operator|using)\b/;

/** Replace comments, string/char literals and preprocessor lines with spaces, keeping newlines. */
export function mask(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  let lineStart = true;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end < 0 ? src.length : end);
      i = end < 0 ? src.length : end;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else if (c === "R" && n === '"') {
      // raw string literal R"delim( ... )delim"
      const open = src.indexOf("(", i);
      const delim = src.slice(i + 2, open);
      const end = src.indexOf(`)${delim}"`, open);
      const stop = end < 0 ? src.length : end + delim.length + 2;
      blank(i, stop);
      i = stop;
    } else if (lineStart && c === "#") {
      // preprocessor line, with backslash continuations
      let j = i;
      while (j < src.length && !(src[j] === "\n" && src[j - 1] !== "\\")) j++;
      blank(i, j);
      i = j;
    } else {
      if (c === "\n") lineStart = true;
      else if (c !== " " && c !== "\t") lineStart = false;
      i++;
    }
    if (i > 0 && src[i - 1] === "\n") lineStart = true;
  }
  return out.join("");
}

/** Split a parameter list at top-level commas. */
function splitParams(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of params) {
    if ("(<[{".includes(ch)) depth++;
    else if (")>]}".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** Drop default arguments: "int a = 3" → "int a" (a later declaration may not repeat them). */
function withoutDefaults(params: string): string {
  return splitParams(params)
    .map((p) => {
      let depth = 0;
      for (let k = 0; k < p.length; k++) {
        if ("(<[{".includes(p[k])) depth++;
        else if (")>]}".includes(p[k])) depth--;
        else if (p[k] === "=" && depth === 0) return p.slice(0, k);
      }
      return p;
    })
    .map((p) => p.trim().replace(/\s+/g, " "))
    .join(", ");
}

interface FunctionDef {
  /** Offset of the start of the definition's first line. */
  lineStart: number;
  prototype: string;
}

function findDefinitions(src: string): FunctionDef[] {
  const m = mask(src);
  const defs: FunctionDef[] = [];
  let depth = 0;
  let headerStart = 0; // just after the last ';', '{' or '}' at depth 0
  let paren = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === "(") paren++;
    else if (c === ")") paren--;
    else if (c === "{") {
      if (depth === 0 && paren === 0) {
        const header = m.slice(headerStart, i);
        const proto = prototypeOf(header);
        if (proto) {
          let start = headerStart + header.search(/\S/);
          start = m.lastIndexOf("\n", start - 1) + 1;
          defs.push({ lineStart: start, prototype: proto });
        }
      }
      depth++;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) headerStart = i + 1;
    } else if (c === ";" && depth === 0 && paren === 0) {
      headerStart = i + 1;
    }
  }
  return defs;
}

function prototypeOf(header: string): string | null {
  const h = header.replace(/\s+/g, " ").trim();
  const beforeParams = h.slice(0, h.indexOf("(") >>> 0);
  // "=" before the parameter list: an initializer (int a[] = {…}), not a function.
  if (!h || beforeParams.includes("=") || TYPE_INTRODUCERS.test(beforeParams) || beforeParams.includes("::")) {
    return null;
  }
  // <return type and qualifiers> <name>(<params>) [const|noexcept…]
  const match = /^(.+?[\s*&])([A-Za-z_]\w*)\s*\(((?:[^()]|\([^()]*\))*)\)\s*(?:noexcept\s*)?$/.exec(h);
  if (!match) return null;
  const [, ret, name, params] = match;
  if (KEYWORDS.has(name) || !/[A-Za-z_]/.test(ret)) return null;
  if (/^\s*(else|return|case|do)\b/.test(ret)) return null;
  return `${ret.trim()} ${name}(${withoutDefaults(params)});`;
}

/**
 * Insert prototypes in front of the first function definition.
 * `file` is the name used in the #line directives (the path clang sees).
 */
export function addPrototypes(src: string, file: string): string {
  const defs = findDefinitions(src);
  if (defs.length === 0) return src;
  const first = defs[0].lineStart;
  const line = src.slice(0, first).split("\n").length; // 1-based line of the first definition
  const protos = [...new Set(defs.map((d) => d.prototype))];
  return (
    src.slice(0, first) +
    `#line ${line} "${file}"\n` +
    protos.join("\n") +
    `\n#line ${line} "${file}"\n` +
    src.slice(first)
  );
}
