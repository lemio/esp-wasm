export type LogLevel = "info" | "error" | "ok" | "muted" | "warn";

/** Keep the panel responsive when a chip prints continuously. */
const MAX_NODES = 5000;

// ESP-IDF log colours: E (red), W (yellow), I (green), D/V (no colour).
const ANSI_CLASS: Record<string, LogLevel | undefined> = { "31": "error", "33": "warn", "32": "ok" };

/** Append-only output panel. Also usable as an esptool-js terminal. */
export class Console {
  /** Colour carried over between serial chunks: an escape code can arrive in one chunk and its text in the next. */
  private serialClass: LogLevel | undefined;
  private pendingEscape = "";

  constructor(private readonly el: HTMLElement) {}

  log(text: string, level: LogLevel = "info"): void {
    this.append(text.endsWith("\n") ? text : text + "\n", level);
  }

  write(text: string): void {
    this.append(text, "info");
  }

  /** Raw device output: strips \r and turns ANSI colour codes into styling. */
  serial(chunk: string): void {
    const text = (this.pendingEscape + chunk).replace(/\r/g, "");
    this.pendingEscape = "";
    let last = 0;
    for (const m of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      if (m.index > last) this.append(text.slice(last, m.index), this.serialClass);
      const codes = m[1].split(";");
      this.serialClass = codes.includes("0") && codes.length === 1 ? undefined
        : codes.map((c) => ANSI_CLASS[c]).find(Boolean) ?? this.serialClass;
      last = m.index + m[0].length;
    }
    let rest = text.slice(last);
    // Hold back a partial escape sequence at the end of the chunk.
    const partial = rest.match(/\x1b(\[[0-9;]*)?$/);
    if (partial) {
      this.pendingEscape = partial[0];
      rest = rest.slice(0, partial.index);
    }
    if (rest) this.append(rest, this.serialClass);
  }

  /** Add an element (e.g. a suggestion with buttons) to the output. */
  appendElement(node: HTMLElement): void {
    this.el.append(node);
    this.el.scrollTop = this.el.scrollHeight;
  }

  clear(): void {
    this.el.replaceChildren();
  }

  /** Adapter for esptool-js' IEspLoaderTerminal. */
  asTerminal() {
    return {
      clean: () => this.clear(),
      writeLine: (data: string) => this.log(data, "muted"),
      write: (data: string) => this.write(data),
    };
  }

  private append(text: string, level: LogLevel | undefined): void {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    if (level && level !== "info") {
      const span = document.createElement("span");
      span.className = level;
      span.textContent = text;
      this.el.append(span);
    } else {
      this.el.append(document.createTextNode(text));
    }
    while (this.el.childNodes.length > MAX_NODES) this.el.firstChild!.remove();
    // Only follow the output if the user hasn't scrolled up to read something.
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }
}
