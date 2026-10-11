import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The phone app. The relay serves the build from its own origin
 * (`apps/relay/wrangler.jsonc`, `assets`), so sign-in, the account API and
 * the WebSocket are all same-origin. `vite dev` forwards them to a relay
 * given in DAEDALUS_RELAY_HTTP (a local `wrangler dev` by default).
 */
const relay = process.env.DAEDALUS_RELAY_HTTP ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  root: new URL("src", import.meta.url).pathname,
  publicDir: new URL("src/public", import.meta.url).pathname,
  build: {
    emptyOutDir: true,
    outDir: new URL("dist", import.meta.url).pathname,
  },
  server: {
    proxy: {
      "/v1": { target: relay, ws: true },
      "/auth": relay,
    },
  },
});
