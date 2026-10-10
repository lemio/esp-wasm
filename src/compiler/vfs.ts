import { Directory, File, type Inode } from "@bjorn3/browser_wasi_shim";

const split = (path: string) => path.split("/").filter((p) => p && p !== ".");

/**
 * In-memory file tree shared by every tool run. Layout:
 *   /sysroot  read-only, from sysroot.tar.gz
 *   /src      user sources (rewritten on every build)
 *   /build    objects and the linked ELF
 */
export class Vfs {
  readonly root: Map<string, Inode>;

  constructor(files: Map<string, Uint8Array> = new Map(), dirs = ["src", "build", "tmp"]) {
    // The shim only links a Directory to its parent when it is constructed with
    // its children, so build the tree bottom-up from a plain nested object.
    type Node = { [name: string]: Node | Uint8Array };
    const tree: Node = {};
    for (const d of dirs) tree[d] = {};
    for (const [path, data] of files) {
      const parts = split(path);
      let node = tree;
      for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Node;
      node[parts[parts.length - 1]] = data;
    }
    const toInodes = (node: Node): Map<string, Inode> =>
      new Map(
        Object.entries(node).map(([name, v]) => [
          name,
          v instanceof Uint8Array ? new File(v, { readonly: true }) : new Directory(toInodes(v)),
        ]),
      );
    this.root = toInodes(tree);
  }

  private dir(parts: string[], create: boolean): Directory | undefined {
    let contents = this.root;
    let dir: Directory | undefined;
    for (const p of parts) {
      let next = contents.get(p);
      if (!next && create) {
        next = new Directory(new Map());
        contents.set(p, next);
      }
      if (!(next instanceof Directory)) return undefined;
      dir = next;
      contents = next.contents;
    }
    return dir;
  }

  writeFile(path: string, data: Uint8Array | string): void {
    const parts = split(path);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const parent = parts.length > 1 ? this.dir(parts.slice(0, -1), true)!.contents : this.root;
    parent.set(parts[parts.length - 1], new File(bytes));
  }

  readFile(path: string): Uint8Array | undefined {
    const parts = split(path);
    const parent = parts.length > 1 ? this.dir(parts.slice(0, -1), false)?.contents : this.root;
    const entry = parent?.get(parts[parts.length - 1]);
    return entry instanceof File ? entry.data : undefined;
  }

  readText(path: string): string | undefined {
    const data = this.readFile(path);
    return data && new TextDecoder().decode(data);
  }

  /** Replace a top-level directory with an empty one. */
  resetDir(name: string): void {
    this.root.set(name, new Directory(new Map()));
  }
}
