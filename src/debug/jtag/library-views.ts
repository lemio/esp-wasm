/**
 * Plain-language summaries of objects from well-known libraries, built from their members (read
 * with the library's debug info) and the memory their pointers lead to. What the bytes mean comes
 * from the library's own source: for Adafruit_NeoPixel, Adafruit_NeoPixel.h documents each member
 * (brightness "stored as +1", rOffset "Red index within each 3- or 4-byte pixel", …) and
 * Adafruit_NeoPixel.cpp shows how setPixelColor() scales colours by the brightness.
 */

/** A member's value: a number, or the bytes a pointer member leads to. */
export interface ObjectView {
  num(name: string): number | undefined;
  /** The bytes a pointer member points to, if they were read. */
  target(name: string): Uint8Array | undefined;
}

export interface Summary {
  text: string;
  /** A few words for next to the code. */
  short: string;
  /** Colours to show as swatches (CSS colours with a label). */
  swatches?: { color: string; label: string }[];
}

type Decoder = (o: ObjectView) => Summary | undefined;

const DECODERS: Record<string, Decoder> = {
  Adafruit_NeoPixel(o) {
    const leds = o.num("numLEDs"), pin = o.num("pin"), stored = o.num("brightness");
    if (leds === undefined) return undefined;
    const r = o.num("rOffset") ?? 1, g = o.num("gOffset") ?? 0, b = o.num("bOffset") ?? 2, w = o.num("wOffset") ?? r;
    const bpp = w === r ? 3 : 4; // the library sets wOffset = rOffset for strips without a white LED
    const order = ["R", "G", "B", "W"].slice(0, bpp).map((c, i) => [c, [r, g, b, w][i]] as const).sort((x, y) => x[1] - y[1]).map(([c]) => c).join("");
    // setBrightness(b) stores b + 1 (0 means "never set": full brightness), and setPixelColor()
    // stores each colour already scaled by it: value * stored >> 8.
    const level = stored ? stored - 1 : 255;
    const parts = [
      `${leds} LED${leds === 1 ? "" : "s"} on GPIO ${pin === undefined || pin < 0 ? "(not set)" : pin}`,
      `brightness ${level}/255 (stored as ${stored}, the library keeps it +1)`,
      `${bpp} bytes per LED, sent in ${order} order`,
    ];
    if (!o.num("begun")) parts.push("begin() hasn't run yet");
    const buf = o.target("pixels");
    const swatches: Summary["swatches"] = [];
    if (buf) {
      for (let i = 0; i < Math.min(leds, Math.floor(buf.length / bpp), 16); i++) {
        const at = (k: number) => buf[i * bpp + k];
        const [rr, gg, bb] = [at(r), at(g), at(b)];
        // Undo the brightness scaling to show the colour the sketch asked for.
        const unscale = (v: number) => (stored ? Math.min(255, Math.round((v * 256) / stored)) : v);
        swatches.push({
          color: `rgb(${unscale(rr)}, ${unscale(gg)}, ${unscale(bb)})`,
          label: `LED ${i}: sent R ${rr} G ${gg} B ${bb}${bpp === 4 ? ` W ${at(w)}` : ""}` +
            (stored ? ` (the colour before brightness scaling: about rgb(${unscale(rr)}, ${unscale(gg)}, ${unscale(bb)}))` : ""),
        });
      }
    }
    const colours = swatches.slice(0, 3).map((s) => s.label.replace(/ \(the colour.*$/, "").replace(/^LED (\d+): sent /, "LED $1 ")).join(", ");
    return { text: parts.join("; "), swatches, short: `${colours || `${leds} LEDs`}, brightness ${level}` };
  },
};

export function summarize(typeName: string, view: ObjectView): Summary | undefined {
  return DECODERS[typeName]?.(view);
}

/**
 * For a pointer member: how many bytes it points to, from a sibling member that holds a size
 * (numBytes, len, size, count, …). The library's naming convention is the only clue there is.
 */
export function pointeeLength(member: string, num: (name: string) => number | undefined, elemSize: number): number {
  const candidates = [`${member}Len`, `${member}Size`, `${member}Count`, "numBytes", "len", "length", "size", "count", "_len", "_size"];
  for (const c of candidates) {
    const v = num(c);
    if (v !== undefined && v > 0) return Math.min(v * (c === "numBytes" || /len|size/i.test(c) ? 1 : elemSize), 256);
  }
  return Math.min(Math.max(elemSize, 1) * 4, 16);
}
