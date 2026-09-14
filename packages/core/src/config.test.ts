import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig, saveWorkspaceInstructionFilesEnabled } from "./config";

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
