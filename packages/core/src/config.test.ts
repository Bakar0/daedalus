import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  channelHome,
  loadConfig,
  saveQuitBehavior,
  saveWorkspaceInstructionFilesEnabled,
} from "./config";

describe("loadConfig", () => {
  test("uses DAEDALUS_HOME without touching the real home", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(config.home).toBe(home);
      expect(config.workspaceRoot).toBe(`${home}/workspaces`);
      expect(config.repositoryRoot).toBe(`${home}/repos`);
      expect(config.workspaceInstructionFilesEnabled).toBe(true);
      expect(await Bun.file(`${home}/config.json`).exists()).toBe(false);
    });
  });

  test("persists the workspace instruction preference without replacing other settings", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        `${home}/config.json`,
        JSON.stringify({ customSetting: "keep-me" }),
      );
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await saveWorkspaceInstructionFilesEnabled(config, false);
      expect(config.workspaceInstructionFilesEnabled).toBe(false);
      expect(await Bun.file(`${home}/config.json`).json()).toMatchObject({
        customSetting: "keep-me",
        workspaceInstructionFilesEnabled: false,
      });
      expect(
        (await loadConfig({ DAEDALUS_HOME: home }))
          .workspaceInstructionFilesEnabled,
      ).toBe(false);
    });
  });
});

describe("quitBehavior", () => {
  test("defaults to asking, and reads anything unrecognised the same way", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      expect((await loadConfig({ DAEDALUS_HOME: home })).quitBehavior).toBe(
        "ask",
      );
      // The one outcome worth ruling out is a stray value quietly archiving
      // someone's sessions on the way out.
      await Bun.write(
        `${home}/config.json`,
        JSON.stringify({ quitBehavior: "destroy-everything" }),
      );
      expect((await loadConfig({ DAEDALUS_HOME: home })).quitBehavior).toBe(
        "ask",
      );
    });
  });

  test("remembers the choice the quit dialog made", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      await saveQuitBehavior(config, "keep");
      expect(config.quitBehavior).toBe("keep");
      expect((await loadConfig({ DAEDALUS_HOME: home })).quitBehavior).toBe(
        "keep",
      );
      await expect(
        saveQuitBehavior(config, "shutdown" as never),
      ).rejects.toThrow(/Unknown quit behavior/);
    });
  });
});

test("keeps non-stable channels out of the stable home", () => {
  // Same home would mean two apps on one SQLite file.
  expect(channelHome("dev", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-dev",
  );
  expect(channelHome("canary", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-canary",
  );
  // Stable is the home everything already points at, and an unpackaged run
  // (no version.json, so no channel) must not be relocated either.
  expect(channelHome("stable", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus",
  );
  expect(channelHome(undefined, "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus",
  );
  // Daedalus exports DAEDALUS_HOME into every agent session it starts, so an
  // agent that builds a dev app and opens it hands the *stable* home straight
  // to it. An inherited home must still be pushed onto the channel's own home
  // rather than honoured as though someone had chosen it.
  expect(channelHome("dev", "/Users/x/.daedalus")).toBe(
    "/Users/x/.daedalus-dev",
  );
  // Re-applying the suffix must not stack it.
  expect(channelHome("dev", "/Users/x/.daedalus-dev")).toBe(
    "/Users/x/.daedalus-dev",
  );
});
