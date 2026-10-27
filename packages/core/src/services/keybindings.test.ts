import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { DaedalusError } from "../errors";
import { KeybindingService, keybindingsPath } from "./keybindings";

const service = async (home: string) => {
  await mkdir(home, { recursive: true });
  return new KeybindingService(keybindingsPath(home));
};

const fileOf = async (home: string) =>
  JSON.parse(await readFile(join(home, "keybindings.json"), "utf8")) as unknown;

describe("keybindings.json", () => {
  test("lives in the home, and is empty until written", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      expect(keys.path).toBe(join(home, "keybindings.json"));
      expect(await keys.read()).toEqual({
        path: keys.path,
        overrides: {},
        rejected: [],
      });
    });
  });

  test("keeps every valid entry and reports the rest", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      await writeFile(
        keys.path,
        JSON.stringify({
          "palette.open": ["mod+shift+p"],
          "tab.close": [],
          "no.such": ["mod+y"],
          "view.board": ["mod+banana", "mod+shift+b"],
          "view.world": ["mod+c"],
          "view.session": "mod+3",
        }),
      );
      const state = await keys.read();
      expect(state.overrides).toEqual({
        "palette.open": ["mod+shift+p"],
        "tab.close": [],
        "view.board": ["mod+shift+b"],
      });
      expect(state.rejected.map(({ id, key }) => [id, key])).toEqual([
        ["no.such", undefined],
        ["view.board", "mod+banana"],
        ["view.world", "mod+c"],
        ["view.session", undefined],
      ]);
      expect(state.rejected[2]?.reason).toMatch(/Reserved: ⌘C is Copy/);
    });
  });

  test("bad JSON is reported, not fatal, and is never written over", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      await writeFile(keys.path, '{ "tab.close": [], ');
      const state = await keys.read();
      expect(state.overrides).toEqual({});
      expect(state.rejected).toEqual([
        { id: "", reason: expect.stringMatching(/not valid JSON/) },
      ]);
      await expect(
        keys.set([{ id: "view.board", keys: ["mod+shift+b"] }]),
      ).rejects.toBeInstanceOf(DaedalusError);
      expect(await readFile(keys.path, "utf8")).toBe('{ "tab.close": [], ');

      await writeFile(keys.path, "[]");
      expect((await keys.read()).rejected[0]?.reason).toMatch(
        /must be an object/,
      );
    });
  });

  test("writes changes together, keeps hand-written entries, and drops defaults", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      await writeFile(keys.path, JSON.stringify({ "no.such": ["mod+y"] }));
      const state = await keys.set([
        { id: "view.board", keys: ["mod+shift+b"] },
        { id: "tab.close", keys: [] },
      ]);
      expect(state.overrides).toEqual({
        "view.board": ["mod+shift+b"],
        "tab.close": [],
      });
      expect(await fileOf(home)).toEqual({
        "no.such": ["mod+y"],
        "view.board": ["mod+shift+b"],
        "tab.close": [],
      });
      // Its own default, however it is spelled, is no override.
      await keys.set([
        { id: "tab.goTo2", keys: ["cmd+2"] },
        { id: "view.board", keys: null },
        { id: "tab.close", keys: null },
      ]);
      expect(await fileOf(home)).toEqual({ "no.such": ["mod+y"] });
    });
  });

  test("refuses an unknown command, a bad key and a reserved key, writing nothing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      for (const changes of [
        [{ id: "no.such" as never, keys: ["mod+y"] }],
        [
          { id: "view.board" as const, keys: ["mod+shift+b"] },
          { id: "view.world" as const, keys: ["hyper+x"] },
        ],
        [{ id: "view.board" as const, keys: ["mod+tab"] }],
      ])
        await expect(keys.set(changes)).rejects.toMatchObject({
          code: "VALIDATION",
        });
      expect(await keys.read()).toMatchObject({ overrides: {} });
    });
  });

  test("resets all, and creates the file for Finder to show", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      expect(await keys.ensureFile()).toBe(keys.path);
      expect(await fileOf(home)).toEqual({});
      await keys.set([{ id: "tab.close", keys: [] }]);
      expect((await keys.resetAll()).overrides).toEqual({});
      expect(await fileOf(home)).toEqual({});
    });
  });

  test("a hand edit, replacing the file, is seen by the watch", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      let changes = 0;
      const seen = new Promise<void>((resolve) => {
        const watcher = keys.watch(() => {
          changes += 1;
          watcher.close();
          resolve();
        });
      });
      // An atomic write renames a new file over the old one, as editors do.
      await keys.set([{ id: "tab.close", keys: [] }]);
      await seen;
      expect(changes).toBe(1);
    });
  });

  test("reset all replaces a broken file, keeping it as keybindings.json.bak", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      await writeFile(keys.path, '{ "tab.close": [], ');
      expect((await keys.resetAll()).rejected).toEqual([]);
      expect(await fileOf(home)).toEqual({});
      expect(await readFile(`${keys.path}.bak`, "utf8")).toBe(
        '{ "tab.close": [], ',
      );
    });
  });

  test("a write another process made meanwhile is kept, not overwritten", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await mkdir(home, { recursive: true });
      const path = keybindingsPath(home);
      let raced = false;
      const keys = new KeybindingService(path, {
        beforeCommit: async () => {
          if (raced) return;
          raced = true;
          // `daedal keys set` from a terminal, between the read and the rename.
          await writeFile(path, JSON.stringify({ "palette.open": ["mod+p"] }));
        },
      });
      await keys.set([{ id: "tab.close", keys: [] }]);
      expect(await fileOf(home)).toEqual({
        "palette.open": ["mod+p"],
        "tab.close": [],
      });
    });
  });

  test("gives up with a conflict when the file never stops changing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await mkdir(home, { recursive: true });
      const path = keybindingsPath(home);
      let count = 0;
      const keys = new KeybindingService(path, {
        beforeCommit: async () => {
          count += 1;
          await writeFile(
            path,
            JSON.stringify({ "view.board": [`f${count}`] }),
          );
        },
      });
      await expect(
        keys.set([{ id: "tab.close", keys: [] }]),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  test("a symlinked file is written through, and stays a symlink", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const keys = await service(home);
      const dotfiles = join(home, "dotfiles");
      await mkdir(dotfiles);
      const real = join(dotfiles, "keybindings.json");
      await writeFile(real, "{}\n");
      await symlink(real, keys.path);
      await keys.set([{ id: "tab.close", keys: [] }]);
      expect((await lstat(keys.path)).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, "utf8"))).toEqual({
        "tab.close": [],
      });
      expect((await keys.read()).overrides).toEqual({ "tab.close": [] });
    });
  });
});
