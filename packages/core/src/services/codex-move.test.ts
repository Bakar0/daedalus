import { describe, expect, test } from "vitest";
import {
  findCodexRollout,
  isCodexRolloutPath,
  rewriteCodexRollout,
} from "./codex-move";
import { LocalMoveSide } from "./move-side";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const THREAD = "01a16fbf-b6aa-7f33-8df1-3d80160ed7bc";

describe("Codex rollouts in a move", () => {
  test("a path is a date folder and Codex's own name for that thread", () => {
    const good = `2026/10/25/rollout-2026-10-25T00-09-57-${THREAD}.jsonl`;
    expect(isCodexRolloutPath(good, THREAD)).toBe(true);
    for (const bad of [
      `../2026/10/25/rollout-x-${THREAD}.jsonl`,
      `2026/10/25/rollout-2026-10-25T00-09-57-${THREAD}.json`,
      `2026/10/rollout-2026-10-25T00-09-57-${THREAD}.jsonl`,
      `2026/10/25/sub/rollout-2026-10-25T00-09-57-${THREAD}.jsonl`,
      `2026/10/25/rollout-2026-10-25T00-09-57-${THREAD.replace("0", "1")}.jsonl`,
    ])
      expect(isCodexRolloutPath(bad, THREAD)).toBe(false);
    expect(isCodexRolloutPath(good, "*")).toBe(false);
  });

  test("paths move whole, never as the start of a longer name", () => {
    const line = JSON.stringify({
      payload: {
        cwd: "/Users/me/ws/s1",
        text: "<cwd>/Users/me/ws/s1</cwd> /Users/me/ws/s10 /Users/me/ws/s1/a /x/Users/me/ws/s1",
      },
    });
    const out = rewriteCodexRollout(
      `${line}\n`,
      [{ from: "/Users/me/ws/s1", to: "/workspace/s1" }],
      false,
    );
    const payload = JSON.parse(out.trim()).payload;
    expect(payload.cwd).toBe("/workspace/s1");
    expect(payload.text).toBe(
      "<cwd>/workspace/s1</cwd> /Users/me/ws/s10 /workspace/s1/a /x/Users/me/ws/s1",
    );
    // A line with nothing to change keeps its bytes.
    const plain = '{"a":  1}';
    expect(rewriteCodexRollout(plain, [{ from: "/q", to: "/r" }], false)).toBe(
      plain,
    );
    expect(() => rewriteCodexRollout("nope", [], true)).toThrow(
      "not a Codex rollout",
    );
  });

  test("finds a thread's rollout under a sessions folder, and nothing for a bad id", async () => {
    const root = await mkdtemp(join(tmpdir(), "daedalus-codex-move-"));
    try {
      const day = join(root, "2026", "10", "25");
      await mkdir(day, { recursive: true });
      const name = `rollout-2026-10-25T00-09-57-${THREAD}.jsonl`;
      await writeFile(join(day, name), "{}\n");
      const side = new LocalMoveSide();
      expect(await findCodexRollout(side, root, THREAD)).toBe(
        `2026/10/25/${name}`,
      );
      expect(await findCodexRollout(side, root, "*")).toBeUndefined();
      expect(await findCodexRollout(side, root, null)).toBeUndefined();
      await writeFile(join(day, name), "");
      expect(await findCodexRollout(side, root, THREAD)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
