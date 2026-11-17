import { describe, expect, test } from "bun:test";
import {
  BUNDLED_RIPGREP_VARIABLE,
  findRipgrepExecutable,
  streamCommandLines,
} from "./ripgrep";

describe("findRipgrepExecutable", () => {
  const finder =
    (exists: readonly string[]) =>
    (executable: string, fallbacks: string[] = []) =>
      [executable, ...fallbacks].find((candidate) =>
        exists.includes(candidate),
      );

  test("prefers the bundled ripgrep", () => {
    expect(
      findRipgrepExecutable(
        { [BUNDLED_RIPGREP_VARIABLE]: "/App/Contents/MacOS/rg" },
        finder(["/App/Contents/MacOS/rg", "rg"]),
      ),
    ).toBe("/App/Contents/MacOS/rg");
  });

  test("falls back to PATH when the bundled one is missing", () => {
    expect(
      findRipgrepExecutable(
        { [BUNDLED_RIPGREP_VARIABLE]: "/gone/rg" },
        finder(["rg"]),
      ),
    ).toBe("rg");
  });

  test("ignores a bundled value that is not an absolute path", () => {
    expect(
      findRipgrepExecutable(
        { [BUNDLED_RIPGREP_VARIABLE]: "rg-old" },
        finder(["rg-old", "/opt/homebrew/bin/rg"]),
      ),
    ).toBe("/opt/homebrew/bin/rg");
  });

  test("is undefined when there is none at all", () => {
    expect(findRipgrepExecutable({}, finder([]))).toBeUndefined();
  });
});

describe("streamCommandLines", () => {
  test("hands over lines and stops the child when asked", async () => {
    const seen: string[] = [];
    const result = await streamCommandLines("/usr/bin/yes", ["line"], {
      onLine: (line) => {
        seen.push(line);
        return seen.length < 3;
      },
    });
    expect(seen).toEqual(["line", "line", "line"]);
    expect(result.stopped).toBe(true);
  });

  test("reads to the end, last line without a newline included", async () => {
    const seen: string[] = [];
    const result = await streamCommandLines("/usr/bin/printf", ["a\\nb"], {
      onLine: (line) => {
        seen.push(line);
      },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result).toMatchObject({ exitCode: 0, stopped: false });
  });

  test("an abort kills the child", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await streamCommandLines("/bin/sleep", ["5"], {
      signal: controller.signal,
      onLine: () => undefined,
    });
    expect(result.stopped).toBe(true);
  });
});
