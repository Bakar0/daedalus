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
});
