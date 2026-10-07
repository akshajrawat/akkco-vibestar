import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/sql/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
import { jsonDefaults } from "monaco-editor/languages/features/json/register";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { loader } from "@monaco-editor/react";
window.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
// Review is read-only: tokenize JSON locally without diagnostics or schema fetches.
jsonDefaults.setModeConfiguration({
  tokens: true,
  documentFormattingEdits: false,
  documentRangeFormattingEdits: false,
  completionItems: false,
  hovers: false,
  documentSymbols: false,
  colors: false,
  foldingRanges: false,
  diagnostics: false,
  selectionRanges: false,
});
monaco.editor.defineTheme("vibestar-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#181818",
    "editorGutter.background": "#181818",
    "editor.foreground": "#d4d7df",
    "diffEditor.insertedTextBackground": "#27754a55",
    "diffEditor.removedTextBackground": "#9f354755",
    "diffEditor.insertedLineBackground": "#173a272e",
    "diffEditor.removedLineBackground": "#53222d30",
    "editor.lineHighlightBackground": "#1a1e27",
  },
});
export { monaco };
export const language = (path: string) => {
  const ext = path.split(".").pop();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        py: "python",
        sh: "shell",
        md: "markdown",
        sql: "sql",
        yml: "yaml",
        yaml: "yaml",
        json: "json",
        css: "css",
        html: "html",
      } as Record<string, string>
    )[ext || ""] || "plaintext"
  );
};
