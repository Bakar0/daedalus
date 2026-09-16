// @hutch cli=0.24.3
export default {
  scripts: {
    install: ["hutch", "install", "--frozen-lockfile"],
    dev: "hutch electrobun prepare && hutch pm exec -- vite build --config apps/desktop/vite.config.ts && hutch electrobun dev --watch",
    build:
      "hutch electrobun prepare && hutch pm exec -- vite build --config apps/desktop/vite.config.ts && hutch electrobun build --env=stable",
  },
  electrobun: {
    version: "2.0.1",
  },
};
