import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Monaco asks for a worker by language label. Each is a separate bundle that
// Vite emits next to the page, so nothing is fetched from a CDN. If the
// webview refuses a worker, Monaco runs that worker's code on the main thread
// and logs a warning, so the editor still works, only slower.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// VS Code's own themes with the background swapped for the app's panel, so
// the editor does not sit in a grey box. The tab bar CSS uses the same values.
monaco.editor.defineTheme("daedalus-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d121c",
    "editorGutter.background": "#0d121c",
    "minimap.background": "#0d121c",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editorOverviewRuler.border": "#00000000",
  },
});
monaco.editor.defineTheme("daedalus-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#f9fbfe",
    "editorGutter.background": "#f9fbfe",
    "minimap.background": "#f9fbfe",
    "editor.lineHighlightBackground": "#0000000a",
    "editor.lineHighlightBorder": "#00000000",
    "editorOverviewRuler.border": "#00000000",
  },
});

/**
 * Model URIs carry the workspace, so the same relative path open in two
 * workspaces is two models. The `file` scheme and the real extension are what
 * Monaco picks the language from, and what the TypeScript worker resolves
 * imports against.
 */
export const modelUri = (workspaceId: string, path: string) =>
  monaco.Uri.from({ scheme: "file", path: `/${workspaceId}/${path}` });

export { monaco };
