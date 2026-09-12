import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const ghosttyBrowserFsStub: Plugin = {
  name: "ghostty-browser-fs-stub",
  generateBundle(_options, bundle) {
    for (const output of Object.values(bundle)) {
      if (
        output.type === "chunk" &&
        output.fileName.includes("__vite-browser-external") &&
        output.code.length === 0
      ) {
        output.code =
          'export async function readFile(){throw new Error("filesystem unavailable in renderer")}';
      }
    }
  },
};

export default defineConfig({
  plugins: [ghosttyBrowserFsStub, react()],
  resolve: {
    alias: {
      "electrobun/browser": new URL(
        "../../.hutch/devkit/api/browser/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  root: new URL("src/renderer", import.meta.url).pathname,
  build: {
    emptyOutDir: true,
    outDir: new URL("dist", import.meta.url).pathname,
  },
});
