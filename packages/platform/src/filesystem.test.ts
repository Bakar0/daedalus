import { describe, expect, test } from "vitest";
import { mkdtemp, readdir, stat, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editJson, writeFileAtomic } from "./filesystem";

async function inTemporaryDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "daedalus-atomic-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("writeFileAtomic", () => {
  test("replaces the file and leaves no temporary behind", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "a.json");
      await writeFile(path, "old");
      await writeFileAtomic(path, "new");
      expect(await Bun.file(path).text()).toBe("new");
      expect(await readdir(directory)).toEqual(["a.json"]);
    });
  });

  test("applies the requested mode", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "secret");
      await writeFileAtomic(path, "x", { mode: 0o600, sync: true });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  test("creates the parent directory only when asked", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "nested", "deeper", "a.txt");
      await expect(writeFileAtomic(path, "x")).rejects.toThrow();
      await writeFileAtomic(path, "x", { ensureDir: true });
      expect(await Bun.file(path).text()).toBe("x");
    });
  });

  test("removes the temporary file when the rename fails", async () => {
    await inTemporaryDirectory(async (directory) => {
      // A directory at the destination makes the rename fail.
      const path = join(directory, "taken");
      await Bun.write(join(path, "keep"), "x");
      await expect(writeFileAtomic(path, "y")).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["taken"]);
    });
  });
});

describe("editJson", () => {
  test("creates a missing file with the mode and a trailing newline", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "sub", "settings.json");
      const result = await editJson(path, (current) => ({ ...current, a: 1 }), {
        mode: 0o600,
      });
      expect(result).toEqual({ status: "written" });
      expect(await Bun.file(path).text()).toBe('{\n  "a": 1\n}\n');
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  test("keeps other keys and skips a write that changes nothing", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "s.json");
      await writeFile(path, '{\n  "keep": true\n}\n');
      expect(await editJson(path, (c) => c)).toEqual({ status: "unchanged" });
      await editJson(path, (c) => ({ ...c, added: 2 }));
      expect(await Bun.file(path).json()).toEqual({ keep: true, added: 2 });
    });
  });

  test("leaves a file that does not parse alone", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "s.json");
      await writeFile(path, "{ nope");
      expect(await editJson(path, () => ({ a: 1 }))).toEqual({
        status: "invalid",
      });
      expect(await Bun.file(path).text()).toBe("{ nope");
    });
  });

  test("removes the file when asked and the result is empty", async () => {
    await inTemporaryDirectory(async (directory) => {
      const path = join(directory, "s.json");
      await writeFile(path, '{"a":1}');
      const seen: string[] = [];
      const result = await editJson(path, () => ({}), {
        removeWhenEmpty: true,
        beforeReplace: async (raw) => void seen.push(raw),
      });
      expect(result).toEqual({ status: "removed" });
      expect(seen).toEqual(['{"a":1}']);
      expect(await readdir(directory)).toEqual([]);
    });
  });
});
