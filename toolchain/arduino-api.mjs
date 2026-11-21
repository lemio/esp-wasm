// Extracts the Arduino API from headers, for the editor's completions:
//   node toolchain/arduino-api.mjs [public/toolchain/sysroot.tar.gz] > src/editor/arduino-api.json
//   node toolchain/arduino-api.mjs --ch32 <ch32v003|ch32x035> [toolchain/out/arduino_core_ch32] > src/editor/arduino-api-<chip>.json
// The first reads Arduino-ESP32 from the sysroot; --ch32 reads WCH's Arduino core (arduino_core_ch32):
// its cores/arduino, the chip's variant and its libraries. Functions (with parameters), macro
// constants, global objects (Serial, Wire…) and the public methods of their classes, including
// inherited ones. Run again when the sysroot or the core changes.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const ch32 = args[0] === "--ch32" ? args.splice(0, 2)[1] : null;
const CH32_CHIPS = {   // the variant (as in collect_ch32_arduino.py) and the libraries built for it
  ch32v003: { series: "CH32V00x", variant: "CH32V003F4", libraries: ["Wire", "SPI", "EEPROM"], usarts: 1, analog: 8, label: "CH32V003" },
  ch32x035: { series: "CH32X035", variant: "CH32X035G8U", libraries: ["Wire", "SPI", "EEPROM", "USBPD_SINK"], usarts: 4, analog: 14, label: "CH32X035" },
};
if (ch32 && !CH32_CHIPS[ch32]) { console.error(`--ch32 takes one of: ${Object.keys(CH32_CHIPS).join(", ")}`); process.exit(1); }

const files = {};
if (ch32) {
  const root = args[0] ?? "toolchain/out/arduino_core_ch32", c = CH32_CHIPS[ch32];
  const dirs = ["cores/arduino", "cores/arduino/avr", `variants/${c.series}/${c.variant}`, ...c.libraries.map((l) => `libraries/${l}/src`)];
  const internal = /^(binary|usbpd_def|usbpd_sink|usbpd_capabilities|usbpd_api)\.h$/;   // not what a sketch uses
  for (const d of dirs) for (const f of fs.readdirSync(path.join(root, d), { withFileTypes: true }))
    if (f.isFile() && f.name.endsWith(".h") && !internal.test(f.name)) files[`${d}/${f.name}`] = fs.readFileSync(path.join(root, d, f.name), "utf8");
} else {
  const tarPath = args[0] ?? "public/toolchain/sysroot.tar.gz";
  const tar = zlib.gunzipSync(fs.readFileSync(tarPath));
  for (let off = 0; off + 512 <= tar.length;) {
    const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/s, "");
    if (!name) break;
    const prefix = tar.toString("utf8", off + 345, off + 500).replace(/\0.*$/s, "");
    const size = parseInt(tar.toString("utf8", off + 124, off + 136).replace(/\0.*$/s, "").trim() || "0", 8);
    const path = prefix ? `${prefix}/${name}` : name;
    if (/components\/arduino\/(cores\/esp32|variants\/esp32s3|libraries\/[^/]+\/src)\/[^/]+\.h$/.test(path)) files[path] = tar.toString("utf8", off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
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
        classes[cls[2]] ??= { bases, methods: Object.create(null), fields: Object.create(null) };
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
      // a public data member: "float minVoltage", "uint8_t a, b", "char buf[8]" (no initializer braces: they open a scope above)
      if (!fn && owner?.kind === "class" && !/[()]|^(typedef|using|friend|enum|template|static_assert)\b/.test(s)) {
        const f = /^((?:(?:static|const|volatile|mutable|unsigned|signed|struct)\s+)*[A-Za-z_][\w:]*(?:<[^>]*>)?(?:\s+(?:long|int|char|short|double))*)\s*([*&]*)\s*([A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*=[^,]*)?(?:\s*,\s*[*&]*\s*[A-Za-z_]\w*(?:\s*\[[^\]]*\])?(?:\s*=[^,]*)?)*)$/.exec(s);
        if (f) for (const d of f[3].split(",")) {
          const name = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*(=.*)?$/.exec(d.trim());
          if (name && !name[1].startsWith("_")) classes[owner.name].fields[name[1]] = `${clean(f[1].replace(/\b(static|mutable)\b/g, ""))}${f[2] ? " " + f[2] : ""}${name[2] ?? ""}`.trim();
        }
        continue;
      }
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
if (ch32) {
  // AVR leftovers (PROGMEM string functions, port helpers) and the core's internals; only the chip's own USARTs
  for (const name of Object.keys(functions)) if (/_P$|_PF$|^pgm_|^(PSTR|cbi|sbi|pre_init|get_timer_index|INADDR_NONE|getInt|getFloat|getString|digitalPinFirstOccurence|analogOutputInit)$/.test(name)) delete functions[name];
  for (const name of Object.keys(constants)) if (/^(PIN_A\d+|P[A-Z]\d+_ALT0|PNUM_\w+|SYSTICK_\w+|CR_\w+|FLASH_KEY\d|PGM_P|SERIAL|DISPLAY|NB_SPI_SETTINGS|SPI_TRANSFER_TIMEOUT|NO_CONFIG|CS_PIN_CONTROLLED_BY_USER|MAX_ANALOG_INPUTS|NUM_ANALOG_INTERNAL_FIRST|ENABLE_RX_BUFFER|TIMER_CHANNELS|NO_IGNORE_CHAR|pinIsAnalogInput)$/.test(name)) delete constants[name];
  constants.NUM_ANALOG_INPUTS = String(CH32_CHIPS[ch32].analog);
  // A0, A1… (an enum in pins_arduino_analog.h): as many as the variant has analog inputs
  for (let i = 0; i < CH32_CHIPS[ch32].analog; i++) { constants[`A${i}`] = `analog input ${i}`; fromHeader[`A${i}`] = "pins_arduino_analog.h"; }
  for (const name of Object.keys(classes)) if (/^(MultiTarget|SUBGHZSPIClass|StringSumHelper)$/.test(name)) delete classes[name];
  for (const name of Object.keys(objects)) {
    const n = /^Serial(\d)$/.exec(name)?.[1];
    if ((n && Number(n) > CH32_CHIPS[ch32].usarts) || /^SERIAL_PORT_/.test(name)) delete objects[name];
  }
} else {
  for (const name of Object.keys(functions)) if (/^(esp_|periman|perimanGet|ets_|log_|ARDUHAL|HAL_)/.test(name) && !/^esp_restart$/.test(name)) delete functions[name];
  for (const name of Object.keys(constants)) if (/^(CONFIG_|SOC_|ESP_ERR|ARDUHAL|ESP_LOG|LOG_|ESP_PLATFORM|ARDUINO_RUNNING|ARDUINO_EVENT|configASSERT|portMAX)/.test(name)) delete constants[name];
}
for (const c of Object.values(classes)) for (const m of Object.keys(c.methods)) if (/^_/.test(m)) delete c.methods[m];

process.stdout.write(JSON.stringify({ version: ch32 ? `arduino_core_ch32, ${CH32_CHIPS[ch32].label} (from the core's headers)` : "arduino-esp32 (from the sysroot)", functions, constants, objects, classes, headers: fromHeader }));
process.stderr.write(`${Object.keys(functions).length} functions, ${Object.keys(constants).length} constants, ${Object.keys(objects).length} objects, ${Object.keys(classes).length} classes\n`);
