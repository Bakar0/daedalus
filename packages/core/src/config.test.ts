import { describe, expect, test } from "vitest";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("uses DAEDALUS_HOME without touching the real home", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(config.home).toBe(home);
      expect(config.workspaceRoot).toBe(`${home}/workspaces`);
      expect(await Bun.file(`${home}/config.json`).exists()).toBe(false);
    });
  });
});
