import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import config from "./electrobun.config";

describe("desktop build configuration", () => {
  test("packages the complete migrations directory", () => {
    expect(config.build.copy.migrations).toBe("migrations");
    expect(config.build.copy["apps/desktop/dist/cli.js"]).toBe("cli/daedal.js");
  });

  test("bundles the bun Electrobun ships, not a newer one", () => {
    // Electrobun 1.18.1's page-to-host bridge breaks on bun 1.4: requests the
    // page sends before its socket opens are dropped, and terminals stay black.
    expect("bunVersion" in config.build).toBe(false);
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
