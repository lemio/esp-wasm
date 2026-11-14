/**
 * Where the lines of a source as it was built are in the source as it is now (after edits), so
 * line-table positions (built lines) land on the same code in the editor. A line that was
 * changed or deleted has no place now (0): better nothing than a highlight on the wrong code.
 */

/** Above this many cells, the middle part (after the common start and end) isn't diffed. */
const MAX_CELLS = 4_000_000;

export interface LineMap {
  /** Built line (1-based) → line now, 0 when it's gone or changed. Index 0 is unused. */
  toNow: Int32Array;
  /** Line now (1-based) → built line, 0 when it's new or changed. */
  toBuilt: Int32Array;
}

export function lineMap(builtText: string, nowText: string): LineMap {
  const a = builtText.split("\n");
  const b = nowText.split("\n");
  const toNow = new Int32Array(a.length + 1);
  const toBuilt = new Int32Array(b.length + 1);
  const pair = (i: number, j: number) => {
    toNow[i + 1] = j + 1;
    toBuilt[j + 1] = i + 1;
  };
  if (builtText === nowText) {
    for (let i = 0; i < a.length; i++) pair(i, i);
    return { toNow, toBuilt };
  }
  // The common start and end (usually all but a few lines).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) pair(start, start), start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) pair(--endA, --endB);

  // The middle: longest common subsequence of lines.
  const n = endA - start, m = endB - start;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return { toNow, toBuilt };
  const w = m + 1;
  const len = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * w + j] = a[start + i] === b[start + j]
        ? len[(i + 1) * w + j + 1] + 1
        : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[start + i] === b[start + j]) pair(start + i++, start + j++);
    else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) i++;
    else j++;
  }
  return { toNow, toBuilt };
}

/** The kind of editor model this needs (Monaco's ITextModel has these). */
interface TextModel {
  getValue(): string;
  getLineCount(): number;
  getAlternativeVersionId(): number;
  isDisposed(): boolean;
}

/**
 * The sources a build was made from, and where their lines are in the editor's code now.
 * Without a snapshot (`set` not called), lines are taken as they are.
 */
export class BuiltSources<M extends TextModel = TextModel> {
  private texts = new Map<string, string>();
  private maps = new Map<string, { model: M; version: number; map: LineMap }>();

  /** `modelFor`: the editor's model of a compiled path ("/src/main.c"). */
  constructor(private readonly modelFor: (file: string) => M | undefined) {}

  /** The build's sources, by compiled path. */
  set(texts: Iterable<[string, string]>): void {
    this.texts = new Map(texts);
    this.maps.clear();
  }

  /** The build's text of a file, if known. */
  text(file: string): string | undefined {
    return this.texts.get(file);
  }

  private mapOf(file: string): { model: M; map?: LineMap } | undefined {
    const model = this.modelFor(file);
    if (!model || model.isDisposed()) return undefined;
    const built = this.texts.get(file);
    if (built === undefined) return { model };
    let m = this.maps.get(file);
    if (!m || m.model !== model || m.version !== model.getAlternativeVersionId()) {
      m = { model, version: model.getAlternativeVersionId(), map: lineMap(built, model.getValue()) };
      this.maps.set(file, m);
    }
    return { model, map: m.map };
  }

  /** Where a line of the build is in the editor now; undefined when that code was changed or deleted. */
  nowLine(file: string, line: number): number | undefined {
    const at = this.mapOf(file);
    if (!at) return undefined;
    const now = at.map ? at.map.toNow[line] ?? 0 : line;
    return now > 0 && now <= at.model.getLineCount() ? now : undefined;
  }

  /** The build's line for a line in the editor now; undefined for new or changed code. */
  builtLine(file: string, line: number): number | undefined {
    const at = this.mapOf(file);
    if (!at) return line;
    const built = at.map ? at.map.toBuilt[line] ?? 0 : line;
    return built > 0 ? built : undefined;
  }
}
