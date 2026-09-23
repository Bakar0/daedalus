import { readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import config from "./electrobun.config";

describe("desktop build configuration", () => {
  test("packages the complete migrations directory", () => {
    expect(config.build.copy.migrations).toBe("migrations");
    expect(config.build.copy["apps/desktop/dist/cli.js"]).toBe("cli/daedal.js");
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
