import type { ElectrobunConfig } from "electrobun";
import packageJson from "./package.json";

// Electrobun already suffixes the app *name* per channel ("Daedalus-dev"), but
// it reuses one bundle identifier, and macOS keys Launch Services, preferences,
// notifications and URL registration off the identifier. Without a distinct one
// a preview build is not a second app — it is the same app twice, and whichever
// launched last wins. The channel is read from the same `--env` flag Electrobun
// itself parses, so `electrobun build --env=stable` needs no second switch.
const channel = (() => {
  const flag = process.argv
    .find((argument) => argument.startsWith("--env="))
    ?.slice("--env=".length);
  return flag === "stable" || flag === "canary" ? flag : "dev";
})();

export const STABLE_IDENTIFIER = "dev.daedalus.app";

export const APP_IDENTIFIER =
  channel === "stable" ? STABLE_IDENTIFIER : `${STABLE_IDENTIFIER}.${channel}`;

export default {
  app: {
    name: "Daedalus",
    identifier: APP_IDENTIFIER,
    version: packageJson.version,
  },
  // macOS apps do not quit when their last window closes —
  // `applicationShouldTerminateAfterLastWindowClosed` defaults to NO — and
  // Electrobun's default is the opposite. That default made the red X call
  // `Utils.quit()` directly, so the most ordinary way to put Daedalus away was
  // the one exit that never said what it left running. Cmd+Q is the quit now,
  // and it always has a window to ask in.
  runtime: { exitOnLastWindowClosed: false },
  // `postBuild` runs after the real bundle is written and before a stable
  // build archives it into the self-extracting wrapper, so the keys it adds
  // survive the launcher's first-run extraction; `postWrap` gives the wrapper
  // the same keys for the launch that does the extracting. See the script.
  scripts: {
    postBuild: "scripts/bundle-plist.ts",
    postWrap: "scripts/bundle-plist.ts",
  },
  build: {
    bun: {
      entrypoint: "apps/desktop/src/bun/index.ts",
    },
    copy: {
      "apps/desktop/dist/index.html": "views/mainview/index.html",
      "apps/desktop/dist/assets": "views/mainview/assets",
      // Vite copies `src/renderer/public` to the top of `dist`, beside
      // `index.html` rather than under `assets`, so each public file needs its
      // own entry or the page asks for it and gets nothing.
      "apps/desktop/dist/daedalus-app-icon.png":
        "views/mainview/daedalus-app-icon.png",
      "apps/desktop/dist/cli.js": "cli/daedal.js",
      migrations: "migrations",
    },
    watchIgnore: ["apps/desktop/dist/**"],
    mac: {
      bundleCEF: false,
      icons: "assets/icon.iconset",
    },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
