/**
 * Minimal tar reader (ustar + GNU long names + pax "path"). Enough for the sysroot,
 * which has IDF header paths longer than 100 chars.
 */
export function untar(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  const str = (o: number, n: number) => {
    const s = data.subarray(o, o + n);
    const end = s.indexOf(0);
    return dec.decode(end < 0 ? s : s.subarray(0, end));
  };
  const oct = (o: number, n: number) => parseInt(str(o, n).trim() || "0", 8);

  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= data.length) {
    if (data[offset] === 0) break; // end-of-archive marker
    const size = oct(offset + 124, 12);
    const type = String.fromCharCode(data[offset + 156] || 0x30);
    const body = data.subarray(offset + 512, offset + 512 + size);
    let name = str(offset, 100);
    if (str(offset + 257, 6).startsWith("ustar")) {
      const prefix = str(offset + 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName) {
      name = longName;
      longName = undefined;
    }

    if (type === "L") {
      longName = dec.decode(body).replace(/\0+$/, "");
    } else if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body));
      if (m) longName = m[1];
    } else if (type === "0" || type === "\0" || type === "7") {
      files.set(name.replace(/^\.\//, ""), body.slice());
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

export async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // Some hosts serve .gz with Content-Encoding: gzip, so the browser already inflated it.
  if (data[0] !== 0x1f || data[1] !== 0x8b) return data;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
