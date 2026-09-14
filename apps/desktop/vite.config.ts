import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
