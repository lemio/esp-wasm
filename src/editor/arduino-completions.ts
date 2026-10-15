/**
 * Arduino-ESP32 completions for the editor: functions (with their parameters as snippet tab stops),
 * constants, global objects and their methods (Serial., Wire., WiFi., and variables of a known class),
 * parameter hints while typing a call, and notes on hover. The API is read from the sysroot's headers
 * (toolchain/arduino-api.mjs → arduino-api.json); DOCS adds plain-language notes for the common ones.
 */
import * as monaco from "monaco-editor";
import API from "./arduino-api.json";
import { DOCS } from "./arduino-docs";

interface Api { functions: Record<string, string[]>; constants: Record<string, string>; objects: Record<string, string>; classes: Record<string, { bases: string[]; methods: Record<string, string[]> }>; headers: Record<string, string> }
const api = API as unknown as Api;
const K = monaco.languages.CompletionItemKind;

const KEYWORDS = ["void", "int", "long", "unsigned", "float", "double", "char", "bool", "boolean", "byte", "word", "String", "uint8_t", "uint16_t", "uint32_t",
  "int8_t", "int16_t", "int32_t", "size_t", "const", "static", "volatile", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return", "true", "false"];

/** Methods of a class, its own first, then inherited ones (Serial gets Stream's and Print's too). */
function methodsOf(cls: string, seen = new Set<string>()): [string, string[]][] {
  const c = api.classes[cls]; if (!c || seen.has(cls)) return [];
  seen.add(cls);
  const own = Object.entries(c.methods);
  const names = new Set(own.map(([n]) => n));
  return [...own, ...c.bases.flatMap((b) => methodsOf(b, seen)).filter(([n]) => !names.has(n) && names.add(n))];
}
/** "void pinMode(uint8_t pin, uint8_t mode)" → ["uint8_t pin", "uint8_t mode"] */
function paramsOf(sig: string): string[] {
  const inner = sig.slice(sig.indexOf("(") + 1, sig.lastIndexOf(")")).trim();
  if (!inner || inner === "void") return [];
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(" || ch === "<") depth++;
    if (ch === ")" || ch === ">") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  return [...out, cur.trim()];
}
/** The name a parameter goes by in a snippet: "uint8_t pin" → pin; "unsigned long duration = 0" → duration (optional: left out). */
const paramName = (p: string) => p.replace(/=.*$/, "").trim().split(/[\s*&]+/).pop()!.replace(/\W/g, "") || "value";
function snippet(name: string, sig: string): string {
  const ps = paramsOf(sig).filter((p) => !/=/.test(p) && p !== "...");
  return `${name}(${ps.map((p, i) => `\${${i + 1}:${paramName(p)}}`).join(", ")})`;
}
const docFor = (key: string): monaco.IMarkdownString | undefined => {
  const d = DOCS[key]; if (!d) return undefined;
  return { value: `${d.doc}${d.ref ? `\n\n[Arduino reference](${d.ref})` : ""}` };
};
const sigsFor = (name: string): string[] => DOCS[name]?.sig ? [DOCS[name].sig!] : api.functions[name] ?? [];

/** The class of a name: a global object (Serial), or a variable declared in the sketch with a known class (String s; WiFiClient c;). */
function classOf(model: monaco.editor.ITextModel, name: string): string | undefined {
  if (api.objects[name]) return api.objects[name];
  const m = new RegExp(`\\b([A-Z]\\w*)\\s*[*&]?\\s+${name}\\b`).exec(model.getValue());
  return m && api.classes[m[1]] ? m[1] : undefined;
}

let registered = false;
export function registerArduinoLanguage(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider("cpp", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      // obj.  → its methods
      const member = /([A-Za-z_]\w*)\s*(?:\.|->)\s*\w*$/.exec(line);
      if (member) {
        const cls = classOf(model, member[1]);
        if (!cls) return { suggestions: [] };
        return { suggestions: methodsOf(cls).map(([name, all], i) => {
          const doc = DOCS[`${member[1]}.${name}`] ?? DOCS[`Serial.${name}`];
          const sigs = [...all].sort((a, b) => Number(/__FlashStringHelper|std::/.test(a)) - Number(/__FlashStringHelper|std::/.test(b)));
          const shown = doc?.sig ?? sigs[0];
          return {
          label: { label: name, description: shown.slice(shown.indexOf("(")) },
          kind: K.Method, insertText: snippet(name, shown), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: sigs.join("\n"), documentation: docFor(`${member[1]}.${name}`) ?? docFor(`Serial.${name}`),
          sortText: `${doc ? 0 : 1}${String(i).padStart(3, "0")}`, range,
        }; }) };
      }
      if (/(^|[^\w])#\s*include\s*[<"]?[\w./]*$/.test(line)) return { suggestions: [] };
      const out: monaco.languages.CompletionItem[] = [];
      const seen = new Set<string>();
      const add = (item: monaco.languages.CompletionItem, name: string) => { if (!seen.has(name)) { seen.add(name); out.push(item); } };
      // the common ones first: documented functions and constants
      for (const [name, sigs] of Object.entries(api.functions).concat(Object.keys(DOCS).filter((n) => DOCS[n].sig && !n.includes(".") && !api.functions[n]).map((n) => [n, [DOCS[n].sig!]]))) {
        const sig = sigsFor(name)[0] ?? sigs[0];
        add({ label: { label: name, description: DOCS[name] ? "Arduino" : api.headers[name] }, kind: K.Function, insertText: snippet(name, sig),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, detail: sigsFor(name).join("\n") || sigs.join("\n"),
          documentation: docFor(name), sortText: `${DOCS[name] ? 0 : 2}${name}`, range }, name);
      }
      for (const [name, value] of Object.entries(api.constants)) add({ label: { label: name, description: value }, kind: K.Constant, insertText: name,
        detail: `${name} = ${value}`, documentation: docFor(name), sortText: `${DOCS[name] ? 0 : 3}${name}`, range }, name);
      for (const [name, cls] of Object.entries(api.objects)) if (!/^_/.test(name)) add({ label: { label: name, description: cls }, kind: K.Variable, insertText: name,
        detail: cls, documentation: docFor(name), sortText: `${DOCS[name] ? 0 : 1}${name}`, range }, name);
      for (const kw of KEYWORDS) add({ label: kw, kind: K.Keyword, insertText: kw, sortText: `1${kw}`, range }, kw);
      for (const cls of Object.keys(api.classes)) if (/^[A-Z]/.test(cls)) add({ label: cls, kind: K.Class, insertText: cls, sortText: `4${cls}`, range }, cls);
      // and the sketch's own names (its variables and functions)
      for (const m of model.getValue().matchAll(/\b[A-Za-z_]\w{2,}\b/g)) if (m[0] !== word.word) add({ label: m[0], kind: K.Text, insertText: m[0], sortText: `5${m[0]}`, range }, m[0]);
      return { suggestions: out };
    },
  });

  // parameter hints: which argument you are typing, and what it is
  monaco.languages.registerSignatureHelpProvider("cpp", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp(model, position) {
      const text = model.getValueInRange(new monaco.Range(Math.max(1, position.lineNumber - 5), 1, position.lineNumber, position.column));
      let depth = 0, commas = 0, i = text.length - 1;
      for (; i >= 0; i--) {
        const ch = text[i];
        if (ch === ")") depth++;
        else if (ch === "(") { if (depth === 0) break; depth--; }
        else if (ch === "," && depth === 0) commas++;
        else if (ch === ";" || ch === "{" || ch === "}") return null;
      }
      if (i < 0) return null;
      const m = /([A-Za-z_]\w*)\s*(?:\.|->)?\s*([A-Za-z_]\w*)?\s*$/.exec(text.slice(0, i));
      if (!m) return null;
      const [obj, fn] = m[2] ? [m[1], m[2]] : [undefined, m[1]];
      const cls = obj && classOf(model, obj);
      const sigs = cls ? (methodsOf(cls).find(([n]) => n === fn)?.[1] ?? []) : sigsFor(fn);
      if (!sigs.length) return null;
      const docKey = obj ? `${obj}.${fn}` : fn;
      return {
        value: {
          signatures: sigs.map((sig) => ({ label: sig, documentation: docFor(docKey), parameters: paramsOf(sig).map((p) => ({ label: p })) })),
          activeSignature: Math.max(0, sigs.findIndex((s) => paramsOf(s).length > commas)),
          activeParameter: commas,
        },
        dispose: () => {},
      };
    },
  });

  // hover: what a name is
  monaco.languages.registerHoverProvider("cpp", {
    provideHover(model, position) {
      const w = model.getWordAtPosition(position); if (!w) return null;
      const before = model.getLineContent(position.lineNumber).slice(0, w.startColumn - 1);
      const obj = /([A-Za-z_]\w*)\s*(?:\.|->)\s*$/.exec(before)?.[1];
      const key = obj ? `${obj}.${w.word}` : w.word;
      const cls = obj && classOf(model, obj);
      const sigs = cls ? (methodsOf(cls).find(([n]) => n === w.word)?.[1] ?? []) : sigsFor(w.word);
      const raw = !obj ? api.constants[w.word] : undefined;
      const value = raw != null && raw !== w.word ? `${w.word} = ${raw}` : undefined;   // not "LED_BUILTIN = LED_BUILTIN"
      const d = DOCS[key] ?? (obj ? DOCS[`Serial.${w.word}`] : undefined), doc = docFor(key) ?? (obj ? docFor(`Serial.${w.word}`) : undefined);
      if (!sigs.length && !doc && !value && !api.objects[w.word]) return null;
      const contents: monaco.IMarkdownString[] = [];
      // the documented form, or the first few overloads
      const shown = d?.sig ? [d.sig] : sigs.slice(0, 3);
      const more = sigs.length - shown.length > 0 ? `\n// + ${sigs.length - shown.length} more overload${sigs.length - shown.length > 1 ? "s" : ""}` : "";
      const code = shown.length ? shown.join("\n") + more : value ?? (api.objects[w.word] ? `${api.objects[w.word]} ${w.word}` : "");
      if (code) contents.push({ value: "```cpp\n" + code + "\n```" });
      if (doc) contents.push(doc);
      return { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), contents };
    },
  });
}
