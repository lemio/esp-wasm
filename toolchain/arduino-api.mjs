// Extracts the Arduino-ESP32 API from the sysroot's headers, for the editor's completions:
//   node toolchain/arduino-api.mjs [public/toolchain/sysroot.tar.gz] > src/editor/arduino-api.json
// Functions (with parameters), macro constants, global objects (Serial, Wire, WiFi…) and the public
// methods of their classes, including inherited ones. Run again when the sysroot changes.
import fs from "node:fs";
import zlib from "node:zlib";

const tarPath = process.argv[2] ?? "public/toolchain/sysroot.tar.gz";
const tar = zlib.gunzipSync(fs.readFileSync(tarPath));
const files = {};
for (let off = 0; off + 512 <= tar.length;) {
  const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/s, "");
  if (!name) break;
  const prefix = tar.toString("utf8", off + 345, off + 500).replace(/\0.*$/s, "");
  const size = parseInt(tar.toString("utf8", off + 124, off + 136).replace(/\0.*$/s, "").trim() || "0", 8);
  const path = prefix ? `${prefix}/${name}` : name;
  if (/components\/arduino\/(cores\/esp32|variants\/esp32s3|libraries\/[^/]+\/src)\/[^/]+\.h$/.test(path)) files[path] = tar.toString("utf8", off + 512, off + 512 + size);
  off += 512 + Math.ceil(size / 512) * 512;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
const clean = (s) => s.replace(/\s+/g, " ").trim();
const SKIP = /^(_|operator|if|for|while|switch|return|sizeof|defined|static_assert)/;

const functions = Object.create(null);   // name → [signature]
const constants = Object.create(null);   // name → value
const classes = Object.create(null);     // name → { bases: [], methods: { name: [signature] } }
const objects = Object.create(null);     // name → class
const fromHeader = Object.create(null);
const aliases = [];      // [macro, identifier]  // name → header (for the docs)

const addFn = (map, name, sig) => { (map[name] ??= []); if (!map[name].includes(sig)) map[name].push(sig); };

for (const [path, raw] of Object.entries(files)) {
  const header = path.split("/").pop();
  const lib = /libraries\/([^/]+)\//.exec(path)?.[1];
  // macros: constants, and function-like macros (min, bitRead, digitalPinToInterrupt…)
  for (const m of raw.matchAll(/^[ \t]*#define[ \t]+([A-Za-z]\w*)(\(([^)]*)\))?[ \t]*(.*)$/gm)) {
    const [, name, fnLike, params, value] = m;
    if (/_H_?$|^_|_H_INCLUDED$|^ESP_ARDUINO_VERSION/.test(name) || name.length < 2) continue;
    if (fnLike) { addFn(functions, name, `${name}(${params.replace(/\s+/g, "")})`.replace(/,/g, ", ")); if (header !== "io_pin_remap.h") fromHeader[name] ??= header; continue; }
    const v = clean(value.replace(/\/\/.*$|\/\*.*$/, ""));
    if (v === "" || /\\$/.test(value)) continue;
    // a macro that names something (#define Serial HWCDCSerial): resolved once every object is known
    if (/^[A-Za-z_]\w*$/.test(v)) aliases.push([name, v]);
    constants[name] ??= v.length > 40 ? v.slice(0, 40) + "…" : v;
    fromHeader[name] ??= header;
  }
  // declarations: walk the braces, so methods land in their class and the rest at file scope
  const src = stripComments(raw).replace(/^[ \t]*#.*$/gm, "");
  const stack = [];   // { kind: "class" | "other", name, public }
  let stmt = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const head = clean(stmt);
      const cls = /(?:^|\s)(class|struct)\s+(?:\w+\s+)*?(\w+)\s*(?::\s*([^{]*))?$/.exec(head);
      if (cls && !/\(/.test(head)) {
        const bases = (cls[3] ?? "").split(",").map((b) => clean(b.replace(/\b(public|protected|private|virtual)\b/g, ""))).filter(Boolean).map((b) => b.replace(/<.*$/, ""));
        classes[cls[2]] ??= { bases, methods: Object.create(null) };
        if (!classes[cls[2]].bases.length) classes[cls[2]].bases = bases;
        stack.push({ kind: "class", name: cls[2], public: cls[1] === "struct" });
      } else if (/extern\s+"C"$|^namespace\b/.test(head)) stack.push({ kind: "scope" });
      else stack.push({ kind: "other" });
      stmt = "";
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      // a function body that ended: it was a declaration with a body, record it like one
      if (top?.kind === "body") { /* handled at its start */ }
      stmt = "";
      continue;
    }
    if (c === ";" || (c === ":" && /^\s*(public|private|protected)\s*$/.test(stmt))) {
      const s = clean(stmt);
      stmt = "";
      const owner = [...stack].reverse().find((x) => x.kind !== "scope");
      if (/^(public|private|protected)$/.test(s)) { if (owner?.kind === "class") owner.public = s === "public"; continue; }
      if (owner && owner.kind !== "class") continue;            // inside a function body or an initializer
      if (owner?.kind === "class" && !owner.public) continue;
      const fn = /^(.*?)\b([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(const)?\s*(override)?\s*(=\s*(0|default|delete))?\s*$/.exec(s);
      const obj = /^extern\s+([A-Za-z_][\w:<>]*)\s+([A-Za-z_]\w*)$/.exec(s);
      if (obj && !owner) { objects[obj[2]] = obj[1].replace(/^.*::/, ""); fromHeader[obj[2]] ??= header; continue; }
      if (!fn || SKIP.test(fn[2]) || /typedef|\busing\b/.test(fn[1])) continue;
      const ret = clean(fn[1].replace(/\b(extern|static|inline|virtual|explicit|IRAM_ATTR|ARDUINO_ISR_ATTR|__attribute__\s*\(\(.*?\)\))\b/g, ""));
      if (owner?.kind === "class" && (fn[2] === owner.name || fn[2] === `~${owner.name}`)) continue;   // constructors
      const sig = `${ret ? ret + " " : ""}${fn[2]}(${clean(fn[3])})`;
      if (owner?.kind === "class") addFn(classes[owner.name].methods, fn[2], sig);
      else if (ret) { addFn(functions, fn[2], sig); fromHeader[fn[2]] ??= lib ? `${lib}: ${header}` : header; }
      continue;
    }
    if (c === "{") continue;
    stmt += c;
    // a function body at file scope: "void f() {": handled by the { above as "other"
  }
}
// objects made by a global definition the regex missed, e.g. "HardwareSerial Serial0(0)"
for (const [path, raw] of Object.entries(files)) for (const m of stripComments(raw).matchAll(/^extern\s+(\w+)\s+(\w+)\s*;/gm)) objects[m[2]] ??= m[1];

// constants that are variables: the board variant's pin names (static const uint8_t A0 = 1;)
for (const [path, raw] of Object.entries(files)) for (const m of stripComments(raw).matchAll(/^\s*static\s+const\s+\w+\s+([A-Za-z]\w*)\s*=\s*([^;]+);/gm)) {
  constants[m[1]] ??= clean(m[2]); fromHeader[m[1]] ??= path.split("/").pop();
}
for (const [name, target] of aliases) if (objects[target]) { objects[name] = objects[target]; delete constants[name]; }
// a function-like macro that only remaps pins (io_pin_remap.h) shadows the real, typed function: keep the typed one
for (const [name, sigs] of Object.entries(functions)) {
  const typed = sigs.filter((x) => !x.startsWith(`${name}(`));
  if (typed.length) functions[name] = typed;
}
// prune: only classes something can reach, names a sketch would type
for (const name of Object.keys(functions)) if (/^(esp_|periman|perimanGet|ets_|log_|ARDUHAL|HAL_)/.test(name) && !/^esp_restart$/.test(name)) delete functions[name];
for (const name of Object.keys(constants)) if (/^(CONFIG_|SOC_|ESP_ERR|ARDUHAL|ESP_LOG|LOG_|ESP_PLATFORM|ARDUINO_RUNNING|ARDUINO_EVENT|configASSERT|portMAX)/.test(name)) delete constants[name];
for (const c of Object.values(classes)) for (const m of Object.keys(c.methods)) if (/^_/.test(m)) delete c.methods[m];

process.stdout.write(JSON.stringify({ version: "arduino-esp32 (from the sysroot)", functions, constants, objects, classes, headers: fromHeader }));
process.stderr.write(`${Object.keys(functions).length} functions, ${Object.keys(constants).length} constants, ${Object.keys(objects).length} objects, ${Object.keys(classes).length} classes\n`);
