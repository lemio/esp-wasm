/**
 * Statement-level hooks for Trace builds.
 *
 * clang's -fsanitize-coverage=trace-pc calls the trace hook at the start of
 * every basic block, which misses straight-line statements between branches.
 * This inserts the same hook in front of every statement line inside function
 * bodies, on the same line, so line numbers don't change and the call's debug
 * location is that line.
 *
 * A hook goes at the start of a line only when it's safe:
 *  - inside a function body (not a class, struct, enum, namespace or initializer),
 *  - not inside parentheses (multi-line calls and conditions),
 *  - the previous token ends a statement or opens/closes a block (; { }),
 *    so `if (x)⏎ y();` and `else⏎ y();` are never split,
 *  - the line doesn't start with else, catch, or `while (…);` (a do-while's tail).
 */
import { mask } from "../compiler/prototypes.ts";

export const HOOK = "__sanitizer_cov_trace_pc";

type Block = { code: boolean; paren: number };

const CODE_AFTER_WORD = new Set(["else", "do", "try", "const", "override", "noexcept", "final", "mutable"]);
const NO_HOOK_BEFORE = /^(else|catch)\b/;

/** `while (…);` at m[at]: the tail of a do-while (or an empty loop). Hooking it could split a do-while. */
function isWhileTail(m: string, at: number): boolean {
  if (!/^while\b/.test(m.slice(at, at + 6))) return false;
  let i = m.indexOf("(", at);
  if (i < 0) return false;
  for (let depth = 0; i < m.length; i++) {
    if (m[i] === "(") depth++;
    else if (m[i] === ")" && --depth === 0) break;
  }
  const next = m.slice(i + 1).search(/\S/);
  return next >= 0 && m[i + 1 + next] === ";";
}

export function addStatementHooks(src: string, file: string, isC: boolean): string {
  const m = mask(src);
  const inserts: number[] = [];
  const stack: Block[] = [];
  let paren = 0;
  let lastSig = ""; // last non-space character
  let lastWord = ""; // last identifier/keyword
  let word = "";

  const inCode = () => stack.length > 0 && stack[stack.length - 1].code;

  for (let i = 0; i < m.length; i++) {
    const c = m[i];

    if (c === "\n" && word) {
      // A word ending the line (e.g. "else") counts as the last token.
      lastWord = word;
      lastSig = word[word.length - 1];
      word = "";
    }
    if (c === "\n" || i === 0) {
      // At a line start: decide whether to hook the first token of this line.
      const lineStart = c === "\n" ? i + 1 : 0;
      let j = lineStart;
      while (j < m.length && (m[j] === " " || m[j] === "\t")) j++;
      const rest = m.slice(j, j + 8);
      if (
        j < m.length && m[j] !== "\n" && inCode() && paren === 0 &&
        (lastSig === ";" || lastSig === "{" || lastSig === "}") &&
        !NO_HOOK_BEFORE.test(rest) && !isWhileTail(m, j)
      ) {
        inserts.push(j);
      }
      if (c === "\n") continue;
    }

    if (/[A-Za-z0-9_]/.test(c)) {
      word += c;
      continue;
    }
    if (word) {
      lastWord = word;
      lastSig = word[word.length - 1];
      word = "";
    }
    if (c === " " || c === "\t" || c === "\r") continue;

    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren = Math.max(0, paren - 1);
    else if (c === "{") {
      const code = inCode()
        // Inside a function: blocks of statements, lambdas; not initializers or type bodies.
        ? lastSig === ")" || lastSig === ";" || lastSig === "{" || lastSig === "}" || lastSig === "]" ||
          lastSig === ":" || CODE_AFTER_WORD.has(lastWord) && /[a-z]/.test(lastSig)
        // At file/namespace/class scope: only function bodies.
        : lastSig === ")" || (CODE_AFTER_WORD.has(lastWord) && lastWord !== "else" && lastWord !== "do" && /[a-z]/.test(lastSig));
      // Save the enclosing parenthesis depth: a lambda can open inside a call, foo([] { … }).
      stack.push({ code, paren });
      paren = 0;
    } else if (c === "}") {
      const b = stack.pop();
      paren = b?.paren ?? 0;
      lastSig = "}";
      lastWord = "";
      continue;
    }
    lastSig = c;
  }

  if (inserts.length === 0) return src;
  let out = "";
  let prev = 0;
  for (const at of inserts) {
    out += src.slice(prev, at) + `${HOOK}(); `;
    prev = at;
  }
  out += src.slice(prev);
  const decl = isC ? `void ${HOOK}(void);` : `extern "C" void ${HOOK}(void);`;
  // The declaration goes first; #line puts the user's first line back at 1.
  return `${decl}\n#line 1 "${file}"\n${out}`;
}
