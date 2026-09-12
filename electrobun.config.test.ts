import { describe, expect, test } from "vitest";
import config from "./electrobun.config";

describe("desktop build configuration", () => {
  test("packages the complete migrations directory", () => {
    expect(config.build.copy.migrations).toBe("migrations");
  });
});
