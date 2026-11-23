import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import config, { DEV_CDP_PORT, rendererSettings } from "./electrobun.config";

describe("desktop build configuration", () => {
  test("packages the complete migrations directory", () => {
    expect(config.build.copy.migrations).toBe("migrations");
    expect(config.build.copy["apps/desktop/dist/cli.js"]).toBe("cli/daedal.js");
  });

  test("bundles the bun Electrobun ships, not a newer one", () => {
    // A bun ahead of the one Electrobun's native bridge is written against
    // drops requests the page sends before its socket opens, and terminals
    // stay black.
    expect("bunVersion" in config.build).toBe(false);
  });

  test("renders on WKWebView with no debugging port unless asked", () => {
    expect(rendererSettings({}, "dev")).toEqual({ bundleCEF: false });
    expect(rendererSettings({}, "stable")).toEqual({ bundleCEF: false });
    expect(rendererSettings({ DAEDALUS_CDP: "0" }, "dev")).toEqual({
      bundleCEF: false,
    });
  });

  test("DAEDALUS_CDP=1 builds dev on Chromium with remote debugging", () => {
    expect(rendererSettings({ DAEDALUS_CDP: "1" }, "dev")).toEqual({
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: { "remote-debugging-port": String(DEV_CDP_PORT) },
    });
  });

  test("DAEDALUS_CDP=1 refuses every channel but dev", () => {
    for (const channel of ["stable", "canary"] as const)
      expect(() => rendererSettings({ DAEDALUS_CDP: "1" }, channel)).toThrow(
        /dev builds only/,
      );
  });

  test("packages the Daedalus macOS app icon", () => {
    expect(config.build.mac.icons).toBe("assets/icon.iconset");
  });

  test("packages every renderer public file beside the page", () => {
    const copy: Record<string, string> = config.build.copy;
    for (const file of readdirSync("apps/desktop/src/renderer/public")) {
      expect(copy[`apps/desktop/dist/${file}`]).toBe(`views/mainview/${file}`);
    }
  });
});
