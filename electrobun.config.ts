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

export const APP_IDENTIFIER =
  channel === "stable" ? "dev.daedalus.app" : `dev.daedalus.app.${channel}`;

export default {
  app: {
    name: "Daedalus",
    identifier: APP_IDENTIFIER,
    version: packageJson.version,
  },
  build: {
    bun: {
      entrypoint: "apps/desktop/src/bun/index.ts",
    },
    copy: {
      "apps/desktop/dist/index.html": "views/mainview/index.html",
      "apps/desktop/dist/assets": "views/mainview/assets",
      "apps/desktop/dist/cli.js": "cli/daedal.js",
      migrations: "migrations",
    },
    watchIgnore: ["apps/desktop/dist/**"],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
