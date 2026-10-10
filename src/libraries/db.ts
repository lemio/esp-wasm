/**
 * The browser database (IndexedDB) shared by the page and the compiler worker:
 *  - "libraries": installed libraries, their sources stored gzip-compressed
 *  - "objects":   compiled library objects, gzip-compressed, so a library is
 *                 compiled once rather than once per session
 * IndexedDB rather than localStorage: localStorage holds ~5 MB of strings, too
 * little for libraries like NimBLE-Arduino.
 */
const DB = "esp-wasm";
const VERSION = 2;
export const LIBRARIES = "libraries";
export const OBJECTS = "objects";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LIBRARIES)) db.createObjectStore(LIBRARIES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(OBJECTS)) db.createObjectStore(OBJECTS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function dbRequest<T>(
  store: string,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** gzip with the browser's CompressionStream. */
export async function gzip(data: Uint8Array): Promise<Blob> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

export async function gunzipBlob(blob: Blob): Promise<Uint8Array> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
