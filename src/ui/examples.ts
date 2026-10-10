/**
 * Examples panel: the Arduino core's and libraries' examples (collected by
 * toolchain/scripts/collect_examples.py into toolchain/examples.json), with a
 * search over title, library, path and code. Loaded on first open.
 */

export interface ExampleFile {
  path: string;
  content: string;
}

export interface Example {
  id: string;
  library: string;
  kind: "core" | "library";
  title: string;
  path: string;
  files: ExampleFile[];
  /** Set by toolchain/scripts/test-examples.mjs: whether it built in the browser toolchain. */
  status?: { ok: boolean; stage?: string; error?: string };
}

interface Indexed {
  ex: Example;
  meta: string; // lowercased title, library and path
  code: string; // lowercased code of all files
}

const MAX_RESULTS = 200;
const URL_ = () => new URL("toolchain/examples.json", document.baseURI).href;

export class ExamplesPanel {
  private index?: Indexed[];
  private loading?: Promise<void>;
  private readonly search: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly count: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly onOpen: (ex: Example) => void,
  ) {
    root.innerHTML = `
      <div class="examples-head">
        <input type="search" class="examples-search" placeholder="Search examples and code…"
               aria-label="Search examples" spellcheck="false" />
        <span class="examples-count" aria-live="polite"></span>
      </div>
      <div class="installed-libs" hidden></div>
      <div class="examples-list" role="list"></div>`;
    this.search = root.querySelector(".examples-search")!;
    this.list = root.querySelector(".examples-list")!;
    this.count = root.querySelector(".examples-count")!;
    let timer: number | undefined;
    this.search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => this.render(), 120);
    });
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (this.list.querySelector(".example") as HTMLElement | null)?.click();
    });
  }

  /** Libraries the user installed (shown above the examples, with a remove button each). */
  setInstalled(
    libs: { id: string; name: string; version: string; packedSize?: number }[],
    onRemove: (id: string) => void,
  ): void {
    const box = this.root.querySelector<HTMLElement>(".installed-libs")!;
    box.hidden = libs.length === 0;
    box.replaceChildren();
    if (!libs.length) return;
    const title = document.createElement("div");
    title.className = "examples-group";
    title.textContent = "Installed libraries";
    box.append(title);
    for (const lib of libs) {
      const row = document.createElement("div");
      row.className = "installed-lib";
      const name = document.createElement("span");
      name.textContent = `${lib.name} `;
      const ver = document.createElement("span");
      ver.className = "example-sub";
      const size = lib.packedSize ? ` · ${lib.packedSize < 1048576 ? `${Math.max(1, Math.round(lib.packedSize / 1024))} KB` : `${(lib.packedSize / 1048576).toFixed(1)} MB`}` : "";
      ver.textContent = `${lib.version} · ${lib.id.split("/")[0]}${size}`;
      const remove = document.createElement("button");
      remove.className = "small";
      remove.title = `Remove ${lib.name}`;
      remove.setAttribute("aria-label", `Remove ${lib.name}`);
      remove.textContent = "✕";
      remove.onclick = () => onRemove(lib.id);
      name.append(ver);
      row.append(name, remove);
      box.append(row);
    }
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  async toggle(show = !this.visible): Promise<void> {
    this.root.hidden = !show;
    if (!show) return;
    this.search.focus();
    await this.load();
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      this.count.textContent = "Loading…";
      try {
        const res = await fetch(URL_());
        // Hosts answer a missing file with an HTML page, so check the type too.
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) {
          throw new Error("toolchain/examples.json is missing on the server; rebuild and upload dist/");
        }
        const { examples } = (await res.json()) as { examples: Example[] };
        this.index = examples.map((ex) => ({
          ex,
          meta: `${ex.title} ${ex.library} ${ex.path}`.toLowerCase(),
          code: ex.files.map((f) => f.content).join("\n").toLowerCase(),
        }));
        this.render();
      } catch (e) {
        this.loading = undefined; // allow a retry on the next open
        this.count.textContent = "";
        const p = document.createElement("p");
        p.className = "examples-empty";
        p.textContent = `Couldn't load the examples: ${(e as Error).message}.`;
        this.list.replaceChildren(p);
      }
    })();
    return this.loading;
  }

  private render(): void {
    if (!this.index) return;
    const terms = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    // Every term must appear in the title/library/path or the code.
    // Examples whose title/path match come before code-only matches.
    const hits = this.index
      .filter((i) => terms.every((t) => i.meta.includes(t) || i.code.includes(t)))
      .map((i) => ({ i, rank: terms.length && terms.every((t) => i.meta.includes(t)) ? 0 : 1 }))
      .sort((a, b) => a.rank - b.rank);

    this.count.textContent = terms.length ? `${hits.length} found` : `${hits.length} examples`;
    this.list.replaceChildren();
    if (hits.length === 0) {
      this.list.innerHTML = `<p class="examples-empty">No examples match.</p>`;
      return;
    }

    let group = "";
    for (const { i, rank } of hits.slice(0, MAX_RESULTS)) {
      const ex = i.ex;
      const g = terms.length ? (rank === 0 ? "Matching title" : "Matching code") : groupName(ex);
      if (g !== group) {
        group = g;
        const h = document.createElement("div");
        h.className = "examples-group";
        h.textContent = g;
        this.list.append(h);
      }
      this.list.append(this.item(i, terms, rank === 1, terms.length > 0));
    }
    if (hits.length > MAX_RESULTS) {
      const more = document.createElement("p");
      more.className = "examples-empty";
      more.textContent = `${hits.length - MAX_RESULTS} more — refine the search.`;
      this.list.append(more);
    }
  }

  /** withLibrary: in search results examples of different libraries mix, so name the library. */
  private item({ ex, code }: Indexed, terms: string[], codeMatch: boolean, withLibrary: boolean): HTMLElement {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "example";
    el.setAttribute("role", "listitem");
    const title = document.createElement("span");
    title.className = "example-title";
    title.textContent = ex.title;
    const sub = document.createElement("span");
    sub.className = "example-sub";
    const folder = ex.path.includes("/") ? ex.path.slice(0, ex.path.lastIndexOf("/")) : "";
    sub.textContent = [withLibrary ? ex.library : "", folder].filter(Boolean).join(" › ");
    el.append(title);
    if (sub.textContent) el.append(sub);

    const badges = document.createElement("span");
    badges.className = "example-badges";
    if (ex.files.length > 1) badges.append(badge(`+${ex.files.length - 1} file${ex.files.length > 2 ? "s" : ""}`, ""));
    if (ex.status && !ex.status.ok) {
      badges.append(badge("doesn't build", "warn", `Doesn't build here (${ex.status.stage}): ${ex.status.error ?? ""}`));
    }
    if (badges.childElementCount) el.append(badges);

    if (codeMatch && terms.length) {
      const snippet = document.createElement("code");
      snippet.className = "example-snippet";
      snippet.textContent = snippetFor(ex, code, terms[0]);
      el.append(snippet);
    }
    el.addEventListener("click", () => this.onOpen(ex));
    return el;
  }
}

function groupName(ex: Example): string {
  return ex.kind === "core" ? `Arduino core › ${ex.library}` : ex.library;
}

function badge(text: string, cls: string, title?: string): HTMLElement {
  const b = document.createElement("span");
  b.className = `example-badge ${cls}`.trim();
  b.textContent = text;
  if (title) b.title = title;
  return b;
}

/** The line of code where `term` first appears. */
function snippetFor(ex: Example, lowerCode: string, term: string): string {
  const at = lowerCode.indexOf(term);
  if (at < 0) return "";
  const all = ex.files.map((f) => f.content).join("\n");
  const start = all.lastIndexOf("\n", at) + 1;
  const end = all.indexOf("\n", at);
  return all.slice(start, end < 0 ? undefined : end).trim().slice(0, 120);
}
