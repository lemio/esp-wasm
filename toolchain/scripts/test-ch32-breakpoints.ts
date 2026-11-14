import assert from "node:assert/strict";
import { Ch32Target, type Ch32Program } from "../../src/debug/ch32-target";

const flashBase = 0x08000000;
const host = { print: () => {}, log: () => {}, program: () => undefined };

async function testSectors(chip: "ch32v003" | "ch32x035", sectorSize: number): Promise<void> {
  const image = Uint8Array.from({ length: sectorSize + 40 }, (_, i) => (i * 13 + 19) & 255);
  const flash = new Uint8Array(sectorSize * 2).fill(0xa5);
  flash.set(image);
  const target = new Ch32Target(host, chip);
  const blocks: number[] = [];
  let badRead = false, failWrite = false, corruptWrite = false;
  Reflect.set(target, "flashed", { image, funcs: [] });
  Reflect.set(target, "beforeMemoryOps", async () => {});
  Reflect.set(target, "readWords", async (addr: number, count: number) => {
    const data = flash.slice(addr - flashBase, addr - flashBase + count * 4);
    if (badRead) { badRead = false; data[data.length - 1] ^= 1; }
    return data;
  });
  Reflect.set(target, "x", async (cmd: number[]) => {
    const statuses: number[] = [];
    for (let i = 0; i < cmd.length; i += 70) {
      assert.equal(cmd[i], 0xfe);
      assert.equal(cmd[i + 1], 0x0b);
      const offset = (cmd[i + 2] | cmd[i + 3] << 8 | cmd[i + 4] << 16 | cmd[i + 5] << 24) >>> 0;
      const at = offset - flashBase;
      blocks.push(at);
      if (at % sectorSize === 0) flash.fill(0xff, at, at + sectorSize);
      flash.set(cmd.slice(i + 6, i + 70), at);
      if (corruptWrite && at % sectorSize === sectorSize - 64) {
        flash[at] ^= 1;
        corruptWrite = false;
      }
      statuses.push(failWrite ? 1 : 0);
      failWrite = false;
    }
    return Uint8Array.from(statuses);
  });
  const sync = (wanted: number[]) => Reflect.apply(Reflect.get(target, "sync"), target, [wanted]) as Promise<void>;
  const a = sectorSize + 2, b = sectorSize + 38;
  await sync([a, b]);
  assert.deepEqual(blocks, Array.from({ length: sectorSize / 64 }, (_, n) => sectorSize + n * 64));
  assert.deepEqual([...flash.slice(a, a + 2)], [2, 0x90]);
  assert.deepEqual([...flash.slice(b, b + 2)], [2, 0x90]);
  assert.deepEqual([...flash.slice(image.length)], Array(sectorSize - 40).fill(0xa5));
  await sync([b]);
  assert.deepEqual([...flash.slice(a, a + 2)], [...image.slice(a, a + 2)]);
  assert.deepEqual([...flash.slice(b, b + 2)], [2, 0x90]);
  await sync([]);
  assert.deepEqual([...flash.slice(0, image.length)], [...image]);
  assert.deepEqual([...flash.slice(image.length)], Array(sectorSize - 40).fill(0xa5));
  const count = blocks.length;
  badRead = true;
  await assert.rejects(sync([a]), /inconsistent/);
  assert.equal(blocks.length, count);
  failWrite = true;
  await assert.rejects(sync([a]), /Writing a breakpoint/);
  await sync([]);
  assert.deepEqual([...flash.slice(0, image.length)], [...image]);
  assert.deepEqual([...flash.slice(image.length)], Array(sectorSize - 40).fill(0xa5));
  corruptWrite = true;
  await assert.rejects(sync([a]), /Verifying a breakpoint/);
  await sync([]);
  assert.deepEqual([...flash.slice(0, image.length)], [...image]);
  assert.deepEqual([...flash.slice(image.length)], Array(sectorSize - 40).fill(0xa5));
}

function testUnwinding(): void {
  const image = new Uint8Array(0x200);
  const view = new DataView(image.buffer);
  // beq a0, zero, +32; jal t0, helper; addi sp, sp, -16.
  view.setUint32(0x100, 0x02050063, true);
  view.setUint32(0x104, 0x07c002ef, true);
  view.setUint32(0x108, 0xff010113, true);
  const program: Ch32Program = { image, funcs: [{ addr: 0x180, size: 32, name: "__riscv_save_4" }] };
  const target = new Ch32Target(host, "ch32x035");
  const frame = (pc: number) => Reflect.apply(Reflect.get(target, "frameOf"), target, [program, 0x100, pc, false]);
  assert.deepEqual(frame(0x108), { size: 32, raAt: 28 });
  assert.deepEqual(frame(0x10c), { size: 48, raAt: 44 });
  assert.deepEqual(frame(0x120), { size: 0, raAt: undefined });
  const v003 = new Ch32Target(host, "ch32v003");
  assert.deepEqual(Reflect.apply(Reflect.get(v003, "frameOf"), v003, [program, 0x100, 0x108, false]), { size: 0, raAt: undefined });
  view.setUint16(0x100, 0xc401, true); // c.beqz s0, +8
  view.setUint32(0x102, 0x07e002ef, true); // jal t0, helper
  assert.deepEqual(frame(0x106), { size: 32, raAt: 28 });
  assert.deepEqual(frame(0x108), { size: 0, raAt: undefined });
}

await testSectors("ch32v003", 64);
await testSectors("ch32x035", 256);
testUnwinding();
console.log("CH32 breakpoint sector and unwinding tests passed.");
