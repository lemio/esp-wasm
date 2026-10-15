/*
 * esp-wasm embed: write Arduino projects straight into a page, each one editable, compilable
 * and uploadable to a real ESP32-S3 from the browser.
 *
 *   <script src="https://lemio.github.io/esp-wasm/embed.js" defer></script>
 *
 *   <Project>
 *     <p>Some explanation…</p>
 *     <Arduino board="esp32-s3">
 *   void setup() {
 *   }
 *   void loop() {
 *   }
 *     </Arduino>
 *     <Diagram>…</Diagram>
 *   </Project>
 *
 * Every <Arduino> becomes an editor with Check and Upload (an iframe of embed.html, created when it
 * scrolls into view). <Project> and <Diagram> are left for the page to lay out and style.
 * Code with "<" in it (#include <Wire.h>, a < b) is safest inside <script type="text/arduino">…</script>
 * within <Arduino>; plain text works too, and the loader repairs what the HTML parser did to it.
 * Files the sketch needs that the reader doesn't have to see, e.g. a small library, go alongside it as
 * <script type="text/arduino" data-file="BleKeyboard.h">…</script>: built with the sketch, as if installed
 * (#include <BleKeyboard.h>), and not shown in the editor.
 *
 * Attributes on <Arduino>: board ("esp32-s3", "schematik"), id (keeps edits per project), theme ("light" | "dark"),
 * buttons (which buttons besides Upload: "check" or "build", "download", "reset"; e.g. buttons="upload check download").
 * Reset shows after an upload by default; with a buttons list only if it names "reset"; reset="off" leaves it out.
 * Events on the <Arduino> element (bubbling): "esp-wasm:status" { state, text }, "esp-wasm:serial" { text }.
 * window.EspWasm: { mount(el), check(el), upload(el), setCode(el, code), base }.
 */
(() => {
  const script = document.currentScript;
  const base = (script && script.dataset.base) || (script ? new URL(".", script.src).href : "https://lemio.github.io/esp-wasm/");
  const frames = new Map();   // id → { el, iframe }

  const toBase64Url = (s) => {
    const bytes = new TextEncoder().encode(s); let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  // The HTML parser lowercases "#include <Wire.h>" into an element <wire.h></wire.h>, and "a<b" starts a tag.
  // Best: a <script type="text/arduino"> child. Otherwise the page's own source (http/https: the browser has it
  // cached), block by block; and from file://, the parsed text with the usual header names put back.
  const HEADERS = ["Arduino.h", "Wire.h", "SPI.h", "WiFi.h", "WiFiClient.h", "WiFiClientSecure.h", "WiFiUdp.h", "WebServer.h", "HTTPClient.h",
    "ESPmDNS.h", "Preferences.h", "EEPROM.h", "SD.h", "FS.h", "SPIFFS.h", "LittleFS.h", "Ticker.h", "Update.h", "ArduinoOTA.h", "AsyncUDP.h",
    "BLEDevice.h", "BLEServer.h", "BLEUtils.h", "BLEHIDDevice.h", "BleKeyboard.h", "NimBLEDevice.h", "ESP_I2S.h", "esp_now.h", "Adafruit_NeoPixel.h", "FastLED.h", "ArduinoJson.h",
    "PubSubClient.h", "Adafruit_GFX.h", "Adafruit_SSD1306.h", "Adafruit_Sensor.h", "DHT.h", "U8g2lib.h", "WebSocketsServer.h", "ESPAsyncWebServer.h", "AsyncTCP.h"];
  const proper = Object.fromEntries(HEADERS.map((h) => [h.toLowerCase(), h]));
  const decode = (html) => { const ta = document.createElement("textarea"); ta.innerHTML = html; return ta.value; };
  let rawBlocks = null;
  const rawSource = (location.protocol === "http:" || location.protocol === "https:")
    ? fetch(location.href, { cache: "force-cache" }).then((r) => r.text()).then((t) => {
        rawBlocks = [...t.matchAll(/<arduino\b[^>]*>([\s\S]*?)<\/arduino>/gi)].map((m) => m[1]);
      }).catch(() => {})
    : Promise.resolve();
  function codeOf(el) {
    const raw = el.querySelector('script[type="text/arduino"]:not([data-file]), script[type="text/plain"]:not([data-file]), template');
    let text;
    if (raw) text = raw.tagName === "TEMPLATE" ? decode(raw.innerHTML) : raw.textContent;
    else {
      const all = [...document.getElementsByTagName("arduino")], i = all.indexOf(el);
      // the sketch is the text around any data-file blocks
      const own = (html) => html.replace(/<script\b[^>]*\bdata-file\b[\s\S]*?<\/script>/gi, "");
      if (rawBlocks && rawBlocks.length === all.length && !/<script/i.test(own(rawBlocks[i]))) text = decode(own(rawBlocks[i]));
      // the parser opened an element <wire.h> there and closed it at the end of the block: drop the closing tag
      else text = decode(own(el.innerHTML).replace(/<\/[a-z0-9_./-]+\.(?:h|hpp)>/gi, "").replace(/<([a-z0-9_./-]+\.(?:h|hpp))>/gi, (m, name) => `<${proper[name.toLowerCase()] || name}>`));
    }
    // the common indentation of the block goes, as do the blank lines around it
    const lines = text.replace(/\t/g, "  ").split("\n");
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    return lines.map((l) => l.slice(indent)).join("\n") + "\n";
  }
  function mount(el) {
    if (el.dataset.espWasm) return;
    const code = codeOf(el);
    const id = el.getAttribute("id") || `p${[...code].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261).toString(16)}`;
    el.dataset.espWasm = id;
    const q = new URLSearchParams({ code: toBase64Url(code), board: el.getAttribute("board") || "esp32-s3", id });
    const files = [...el.querySelectorAll("script[data-file]")].map((s) => ({ path: s.dataset.file, content: s.textContent }));
    if (files.length) q.set("files", toBase64Url(JSON.stringify(files)));
    if (el.getAttribute("theme")) q.set("theme", el.getAttribute("theme"));
    if (el.getAttribute("buttons")) q.set("buttons", el.getAttribute("buttons"));   // e.g. "upload check download"
    if (el.getAttribute("trace")) q.set("trace", el.getAttribute("trace"));         // "off": no line highlighting
    if (el.getAttribute("reset")) q.set("reset", el.getAttribute("reset"));         // "off": no reset button after uploading
    const iframe = document.createElement("iframe");
    iframe.src = `${base}embed.html#${q}`;
    iframe.title = "Arduino code editor";
    iframe.allow = "serial; usb";
    iframe.loading = "lazy";
    iframe.style.cssText = "display:block;width:100%;height:220px;border:0;";
    el.replaceChildren(iframe);
    el.style.display = "block";
    frames.set(id, { el, iframe });
  }
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || m.source !== "esp-wasm") return;
    const f = frames.get(m.id); if (!f || e.source !== f.iframe.contentWindow) return;
    if (m.type === "height") f.iframe.style.height = `${Math.ceil(m.px)}px`;
    else f.el.dispatchEvent(new CustomEvent(`esp-wasm:${m.type}`, { bubbles: true, detail: m }));
  });
  const send = (el, msg) => { const f = frames.get(el.dataset.espWasm); f && f.iframe.contentWindow.postMessage({ source: "esp-wasm-host", ...msg }, "*"); };
  window.EspWasm = { base, mount, check: (el) => send(el, { type: "check" }), upload: (el) => send(el, { type: "upload" }), reset: (el) => send(el, { type: "reset" }), setCode: (el, code) => send(el, { type: "set-code", code }) };

  const start = () => rawSource.then(() => {
    // <Arduino> is not a custom element name (no hyphen), so the parser makes it a plain element named ARDUINO
    const els = [...document.getElementsByTagName("arduino")];
    if (!("IntersectionObserver" in window)) return els.forEach(mount);
    const io = new IntersectionObserver((entries) => entries.forEach((en) => { if (en.isIntersecting) { io.unobserve(en.target); mount(en.target); } }), { rootMargin: "600px" });
    els.forEach((el) => io.observe(el));
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
