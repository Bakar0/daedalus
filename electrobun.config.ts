import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Daedalus",
    identifier: "dev.daedalus.app",
    version: "0.1.0",
  },
  build: {
    mainProcess: "cottontail",
    cottontail: {
      entrypoint: "apps/desktop/src/bun/index.ts",
    },
    copy: {
      "apps/desktop/dist/index.html": "views/mainview/index.html",
      "apps/desktop/dist/assets": "views/mainview/assets",
      "migrations/001_initial.sql": "migrations/001_initial.sql",
    },
    watchIgnore: ["apps/desktop/dist/**"],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
