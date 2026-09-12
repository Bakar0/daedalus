import { describe, expect, test } from "vitest";
import { DaedalusError, normalizeError } from "./errors";

describe("DaedalusError", () => {
  test.each([
    ["VALIDATION", 2],
    ["NOT_FOUND", 3],
    ["CONFLICT", 4],
    ["DEPENDENCY", 5],
  ] as const)("maps %s to a stable exit code", (code, exitCode) => {
    expect(new DaedalusError(code, "test").exitCode).toBe(exitCode);
  });

  test("normalizes unknown errors", () => {
    expect(normalizeError(new Error("boom"))).toMatchObject({
      code: "INTERNAL",
      message: "boom",
    });
  });
});
