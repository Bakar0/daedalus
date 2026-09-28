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

// Where a stable build looks for updates, and where the release workflow
// publishes them. GitHub serves `releases/latest/download/<asset>` from the
// newest published release, so the URL never changes between versions, and a
// draft is invisible to it until it is published.
export const RELEASE_BASE_URL =
  "https://github.com/Bakar0/daedalus/releases/latest/download";

// Signing and notarization need an Apple Developer ID, which only the release
// machine has. Each turns on when its credentials are in the environment, so
// a local `build:stable` still works without them. The variable names are
// Electrobun's own.
const signing = Boolean(process.env["ELECTROBUN_DEVELOPER_ID"]);
const notarizing =
  signing &&
  Boolean(
    (process.env["ELECTROBUN_APPLEAPIISSUER"] &&
      process.env["ELECTROBUN_APPLEAPIKEY"] &&
      process.env["ELECTROBUN_APPLEAPIKEYPATH"]) ||
    (process.env["ELECTROBUN_APPLEID"] &&
      process.env["ELECTROBUN_APPLEIDPASS"] &&
      process.env["ELECTROBUN_TEAMID"]),
  );

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
  build: {
    // No `bunVersion`: the app runs on the bun Electrobun 1.18.1 ships
    // (1.3.13), which its native bridge is written against. 0.8.1 pinned
    // 1.4.2, and every terminal came up black: bun 1.4 hands an FFI callback's
    // `cstring` argument over as a string, Electrobun's page-to-host bridge
    // calls `new CString()` on it, that throws, and the error is swallowed. Each
    // request the page sent before its WebSocket opened, `terminalEndpoint`
    // among them, was lost. Move with Electrobun, never ahead of it.
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
      codesign: signing,
      notarize: notarizing,
    },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  scripts: {
    // Adds the bundled tmux to Contents/MacOS before the bundle is signed.
    postBuild: "scripts/electrobun-post-build.ts",
  },
  release: { baseUrl: RELEASE_BASE_URL },
} satisfies ElectrobunConfig;
