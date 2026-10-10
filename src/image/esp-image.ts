/**
 * ELF → ESP app image for the ESP32-S3, ported from esptool's `elf2image`
 * (ESP32FirmwareImage.save). Layout:
 *
 *   [24-byte header][segments: 8-byte header + data]…[pad][checksum][sha256?]
 *
 * Flash-mapped segments (IROM/DROM) must sit in the file so that
 * (file offset % 64 KiB) == (vaddr % 64 KiB), because the MMU maps 64 KiB pages.
 * The gaps get filled with RAM segments, or with padding segments if none fit.
 *
 * Like esptool, segments come from ELF *sections*, not program headers: IDF's
 * program headers include NOBITS placeholders (e.g. .dram0.dummy) that alias
 * IRAM and must never be written.
 *
 * Verified byte-identical with `esptool --chip esp32s3 elf2image` for an
 * ESP-IDF v6.0 app (see toolchain/README.md).
 */
import {
  EM_XTENSA, SHF_ALLOC, SHT_FINI_ARRAY, SHT_INIT_ARRAY, SHT_PREINIT_ARRAY, SHT_PROGBITS, parseElf,
} from "./elf";

const ESP_IMAGE_MAGIC = 0xe9;
const ESP_CHECKSUM_MAGIC = 0xef;
const ESP32S3_CHIP_ID = 9;
const HEADER_LEN = 24;
const SEG_HEADER_LEN = 8;
const IROM_ALIGN = 0x10000;

const FLASH_MAPS: Array<[number, number]> = [
  [0x42000000, 0x44000000], // IROM (instruction bus, cached flash)
  [0x3c000000, 0x3e000000], // DROM (data bus, cached flash)
];
const isFlashAddr = (a: number) => FLASH_MAPS.some(([lo, hi]) => a >= lo && a < hi);

/** esptool's ESP32-S3 memory map; adjacent segments merge only within the same region types. */
const MEMORY_MAP: Array<[number, number, string]> = [
  [0x00000000, 0x00010000, "PADDING"],
  [0x3c000000, 0x3d000000, "DROM"],
  [0x3d000000, 0x3e000000, "EXTRAM_DATA"],
  [0x600fe000, 0x60100000, "RTC_DRAM"],
  [0x3fc88000, 0x3fd00000, "BYTE_ACCESSIBLE"],
  [0x3fc88000, 0x403e2000, "MEM_INTERNAL"],
  [0x3fc88000, 0x3fd00000, "DRAM"],
  [0x40000000, 0x4001a100, "IROM_MASK"],
  [0x40370000, 0x403e0000, "IRAM"],
  [0x600fe000, 0x60100000, "RTC_IRAM"],
  [0x42000000, 0x42800000, "IROM"],
  [0x50000000, 0x50002000, "RTC_DATA"],
];
const memoryType = (addr: number) =>
  MEMORY_MAP.filter(([lo, hi]) => addr >= lo && addr < hi).map(([, , t]) => t).join(",");

export type FlashMode = "qio" | "qout" | "dio" | "dout";
export type FlashFreq = "80m" | "40m" | "26m" | "20m";
export type FlashSize = "1MB" | "2MB" | "4MB" | "8MB" | "16MB" | "32MB";

export interface ImageOptions {
  flashMode?: FlashMode;
  flashFreq?: FlashFreq;
  flashSize?: FlashSize;
  /** Append a SHA-256 of the image (IDF default for app images). */
  appendSha256?: boolean;
  /**
   * Image offset where the ELF's SHA-256 goes (inside esp_app_desc_t), as with
   * esptool --elf-sha256-offset. IDF app images use 0xb0; null disables it.
   */
  elfSha256Offset?: number | null;
  minChipRevFull?: number;
  maxChipRevFull?: number;
}

const MODE = { qio: 0, qout: 1, dio: 2, dout: 3 } as const;
const FREQ = { "40m": 0x0, "26m": 0x1, "20m": 0x2, "80m": 0xf } as const;
const SIZE = { "1MB": 0, "2MB": 1, "4MB": 2, "8MB": 3, "16MB": 4, "32MB": 5 } as const;

interface Segment {
  addr: number;
  data: Uint8Array;
}

/** Pad to a 4-byte multiple, as esptool's ImageSegment does. */
function pad4(data: Uint8Array): Uint8Array {
  const rem = data.length % 4;
  if (rem === 0) return data;
  const out = new Uint8Array(data.length + 4 - rem);
  out.set(data);
  return out;
}

class ByteWriter {
  private buf = new Uint8Array(1 << 20);
  length = 0;

  private ensure(extra: number) {
    if (this.length + extra <= this.buf.length) return;
    let size = this.buf.length;
    while (size < this.length + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  bytes(data: Uint8Array) {
    this.ensure(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }
  u32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }
  zeros(n: number) {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export async function elfToImage(elfBytes: Uint8Array, opts: ImageOptions = {}): Promise<Uint8Array> {
  const elf = parseElf(elfBytes);
  if (elf.machine !== EM_XTENSA) throw new Error(`ELF is not Xtensa (e_machine=${elf.machine})`);

  const loadable = [SHT_PROGBITS, SHT_INIT_ARRAY, SHT_FINI_ARRAY, SHT_PREINIT_ARRAY];
  const sectionSegs: Segment[] = elf.sections
    .filter((s) => loadable.includes(s.type) && s.flags & SHF_ALLOC && s.addr !== 0 && s.size > 0)
    .map((s) => ({ addr: s.addr, data: pad4(s.data) }));

  // Merge sections that are contiguous in the same memory region (esptool's
  // merge_adjacent_segments), keeping ELF section order.
  const segments: Segment[] = [];
  for (const seg of sectionSegs) {
    const prev = segments[segments.length - 1];
    if (prev && seg.addr === prev.addr + prev.data.length && memoryType(seg.addr) === memoryType(prev.addr)) {
      const merged = new Uint8Array(prev.data.length + seg.data.length);
      merged.set(prev.data);
      merged.set(seg.data, prev.data.length);
      prev.data = merged;
    } else {
      segments.push({ ...seg });
    }
  }
  segments.sort((a, b) => a.addr - b.addr);

  const elfSha256Offset = opts.elfSha256Offset === undefined ? 0xb0 : opts.elfSha256Offset;
  const elfSha256 = elfSha256Offset === null
    ? undefined
    : new Uint8Array(await crypto.subtle.digest("SHA-256", elfBytes as BufferSource));

  const flashSegs = segments.filter((s) => isFlashAddr(s.addr));
  const ramSegs = segments.filter((s) => !isFlashAddr(s.addr));

  for (let i = 1; i < flashSegs.length; i++) {
    if (Math.floor(flashSegs[i].addr / IROM_ALIGN) === Math.floor(flashSegs[i - 1].addr / IROM_ALIGN)) {
      throw new Error("Two flash segments share one 64 KiB MMU page; check the linker script");
    }
  }

  const w = new ByteWriter();
  w.zeros(HEADER_LEN); // header is filled in once we know the segment count
  let checksum = ESP_CHECKSUM_MAGIC;
  let count = 0;

  const writeSegment = (seg: Segment) => {
    w.u32(seg.addr);
    w.u32(seg.data.length);
    const start = w.length;
    if (elfSha256 && elfSha256Offset !== null &&
        elfSha256Offset >= start && elfSha256Offset + 32 <= start + seg.data.length) {
      // Patch before checksumming, as esptool does.
      const at = elfSha256Offset - start;
      if (seg.data.subarray(at, at + 32).some((b) => b !== 0)) {
        throw new Error(`Bytes at ELF SHA-256 offset 0x${elfSha256Offset.toString(16)} are not zero`);
      }
      seg.data = seg.data.slice();
      seg.data.set(elfSha256, at);
    }
    w.bytes(seg.data);
    for (const b of seg.data) checksum ^= b;
    count++;
  };

  const alignmentNeeded = (seg: Segment): number => {
    const alignPast = (seg.addr % IROM_ALIGN) - SEG_HEADER_LEN;
    let padLen = IROM_ALIGN - (w.length % IROM_ALIGN) + alignPast;
    if (padLen === 0 || padLen === IROM_ALIGN) return 0;
    padLen -= SEG_HEADER_LEN;
    if (padLen < 0) padLen += IROM_ALIGN;
    return padLen;
  };

  while (flashSegs.length > 0) {
    const seg = flashSegs[0];
    const padLen = alignmentNeeded(seg);
    if (padLen > 0) {
      if (ramSegs.length > 0 && padLen > SEG_HEADER_LEN) {
        // Fill the gap with the start of the next RAM segment.
        const ram = ramSegs[0];
        const take = Math.min(padLen, ram.data.length);
        writeSegment({ addr: ram.addr, data: ram.data.subarray(0, take) });
        ram.addr += take;
        ram.data = ram.data.subarray(take);
        if (ram.data.length === 0) ramSegs.shift();
      } else {
        writeSegment({ addr: 0, data: new Uint8Array(padLen) });
      }
      continue;
    }
    // Work around old 2nd-stage bootloaders that don't map the last MMU page
    // when a flash segment ends less than 0x24 bytes past a page boundary.
    const endRem = (w.length + SEG_HEADER_LEN + seg.data.length) % IROM_ALIGN;
    if (endRem < 0x24) {
      const padded = new Uint8Array(seg.data.length + (0x24 - endRem));
      padded.set(seg.data);
      seg.data = padded;
    }
    writeSegment(seg);
    flashSegs.shift();
  }
  for (const seg of ramSegs) writeSegment(seg);

  // Checksum goes in the last byte of a 16-byte-aligned block.
  w.zeros(15 - (w.length % 16));
  w.bytes(Uint8Array.of(checksum & 0xff));

  const image = w.result();
  writeHeader(image, count, elf.entry, opts);

  if (opts.appendSha256 ?? true) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", image as BufferSource));
    const out = new Uint8Array(image.length + digest.length);
    out.set(image);
    out.set(digest, image.length);
    return out;
  }
  return image;
}

function writeHeader(image: Uint8Array, segmentCount: number, entry: number, opts: ImageOptions) {
  const dv = new DataView(image.buffer, image.byteOffset, HEADER_LEN);
  dv.setUint8(0, ESP_IMAGE_MAGIC);
  dv.setUint8(1, segmentCount);
  dv.setUint8(2, MODE[opts.flashMode ?? "dio"]);
  dv.setUint8(3, (SIZE[opts.flashSize ?? "2MB"] << 4) | FREQ[opts.flashFreq ?? "80m"]);
  dv.setUint32(4, entry, true);
  // Extended header
  dv.setUint8(8, 0xee); // wp_pin: disabled
  // bytes 9..11: spi_pin_drv = 0
  dv.setUint16(12, ESP32S3_CHIP_ID, true);
  dv.setUint8(14, 0); // min_chip_rev (legacy)
  dv.setUint16(15, opts.minChipRevFull ?? 0, true);
  dv.setUint16(17, opts.maxChipRevFull ?? 99, true); // CONFIG_ESP32S3_REV_MAX_FULL
  // bytes 19..22 reserved
  dv.setUint8(23, (opts.appendSha256 ?? true) ? 1 : 0);
}
