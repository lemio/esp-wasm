/**
 * Installed libraries in the browser database. A library's sources are stored
 * as one gzip-compressed blob (source code compresses ~4–5×).
 */
import { LIBRARIES, OBJECTS, dbRequest, gunzipBlob, gzip } from "./db";
import type { InstalledLibrary, LibraryFile } from "./registry";

/** What's stored: the library's metadata and its packed sources. */
export interface StoredLibrary {
  id: string;
  owner: string;
  name: string;
  version: string;
  includeDirs: string[];
  installedAt: number;
  /** Size of the sources, unpacked and packed, in bytes. */
  size: number;
  packedSize: number;
  packed: Blob;
}

export async function saveLibrary(lib: InstalledLibrary): Promise<StoredLibrary> {
  const json = new TextEncoder().encode(JSON.stringify(lib.files));
  const packed = await gzip(json);
  const { files: _files, ...meta } = lib;
  const rec: StoredLibrary = { ...meta, size: json.length, packedSize: packed.size, packed };
  await dbRequest(LIBRARIES, "readwrite", (s) => s.put(rec));
  return rec;
}

export async function listLibraries(): Promise<StoredLibrary[]> {
  const recs = await dbRequest(LIBRARIES, "readonly", (s) => s.getAll() as IDBRequest<(StoredLibrary & { files?: LibraryFile[] })[]>)
    .catch(() => []);
  // Libraries installed before compression existed: pack them now.
  return Promise.all(recs.map((r) => (r.files ? saveLibrary(r as unknown as InstalledLibrary) : r)));
}

/** The library's source files (unpacked). */
export async function libraryFiles(rec: StoredLibrary): Promise<LibraryFile[]> {
  return JSON.parse(new TextDecoder().decode(await gunzipBlob(rec.packed)));
}

export async function removeLibrary(id: string): Promise<void> {
  await dbRequest(LIBRARIES, "readwrite", (s) => s.delete(id));
  // Its compiled objects too (their keys start with "<id>@").
  await dbRequest(OBJECTS, "readwrite", (s) => s.delete(IDBKeyRange.bound(`${id}@`, `${id}@￿`))).catch(() => {});
}
