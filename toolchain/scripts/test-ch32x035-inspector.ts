import assert from "node:assert/strict";
import { ch32x035 } from "../../src/debug/jtag/chip-ch32x035";

const a = 0x40010800, b = 0x40010c00, c = 0x40011000;
const words = new Map<number, number>([
  [0x40021018, 0x1c],
  [a, 0x00000083], [a + 4, 0], [a + 8, 3], [a + 12, 3], [a + 28, 0],
  [b, 0], [b + 4, 0x0000000b], [b + 8, 1 << 8], [b + 12, 0], [b + 28, 0],
  [c, 0], [c + 4, 0], [c + 8, 1 << 16], [c + 12, 0], [c + 28, 4],
]);
const rows = ch32x035.pins.rows(words, undefined, ch32x035.soc.db()!);
const row = (id: string) => {
  const found = rows.find((r) => r.id === id);
  assert.ok(found, `missing ${id}`);
  return found;
};
assert.equal(row("PA0").dir, "output");
assert.equal(row("PA0").level, "driven high, reads high");
assert.equal(row("PA1").pull, "pull-up");
assert.equal(row("PB8").dir, "alternate-function output");
assert.equal(row("PC16").dir, "input (floating)");
assert.equal(row("PC16").dot, 1);
const levels = ch32x035.pins.levelRegs.map((address) => words.get(address));
assert.equal(ch32x035.pins.level(levels, "PA0"), 1);
assert.equal(ch32x035.pins.level(levels, "PB8"), 1);
assert.equal(ch32x035.pins.level(levels, "PC16"), 1);
assert.equal(ch32x035.pins.level(levels, "PD0"), undefined);
assert.equal(ch32x035.soc.safeToRead(a + 8), true);
assert.equal(ch32x035.soc.safeToRead(0x40013804), false);
assert.equal(ch32x035.soc.safeToRead(0x20000000), true);
words.set(0x40021018, 0x0c);
assert.equal(ch32x035.pins.rows(words, undefined, ch32x035.soc.db()!).find((r) => r.id === "PC16")?.dir, "off");
assert.equal(ch32x035.pins.level(ch32x035.pins.levelRegs.map((address) => words.get(address)), "PC16"), undefined);
console.log("CH32X035 inspector GPIO tests passed.");
