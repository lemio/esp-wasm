import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { Diagnostic } from "../compiler/types";
import { registerArduinoLanguage } from "./arduino-completions";

// C/C++ only has Monarch highlighting, so the base editor worker is enough.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export function createEditor(container: HTMLElement, options: monaco.editor.IStandaloneEditorConstructionOptions = {}) {
  registerArduinoLanguage();   // completions, parameter hints and hover for the Arduino-ESP32 API
  return monaco.editor.create(container, {
    model: null,
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 14,
    // Code overview on the right; Trace builds mark the running line and trail in it too.
    minimap: { enabled: true, renderCharacters: true, showSlider: "mouseover" },
    scrollBeyondLastLine: false,
    glyphMargin: true, // line tracing arrow
    ...options, // e.g. the embed: light theme, no minimap
  });
}

export type TextModel = monaco.editor.ITextModel;

/** Language for a source file: C for .c, C++ for everything else (.ino, .cpp, .h…). */
export const languageFor = (path: string): "c" | "cpp" => (path.endsWith(".c") ? "c" : "cpp");

/** Get the model for a file, creating it with initialSource the first time. */
export function fileModel(path: string, language: "c" | "cpp", initialSource: () => string): TextModel {
  const uri = monaco.Uri.file(path);
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(initialSource(), language, uri);
}

export function disposeModel(path: string): void {
  monaco.editor.getModel(monaco.Uri.file(path))?.dispose();
}

/** Show clang diagnostics for one source file (its path in the build, e.g. "sketch.ino") as squiggles. */
export function setDiagnostics(model: TextModel, diagnostics: Diagnostic[], sourcePath: string): void {
  const markers = diagnostics
    .filter((d) => d.file === `/src/${sourcePath}` || d.file === sourcePath)
    .map((d) => ({
      severity:
        d.severity === "error" ? monaco.MarkerSeverity.Error
        : d.severity === "warning" ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: model.getLineMaxColumn(Math.min(d.line, model.getLineCount())),
    }));
  monaco.editor.setModelMarkers(model, "clang", markers);
}
