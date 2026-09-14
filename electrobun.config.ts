import type { ElectrobunConfig } from "electrobun";
import packageJson from "./package.json";

export default {
  app: {
    name: "Daedalus",
    identifier: "dev.daedalus.app",
    version: packageJson.version,
  },
  build: {
    mainProcess: "cottontail",
    cottontail: {
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
