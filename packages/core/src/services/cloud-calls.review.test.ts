import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DaedalCall } from "@daedalus/remote-protocol";
import type { Workspace } from "../domain";
import { CloudCalls } from "./cloud-calls";

/**
 * Security review of cloud sessions stage 0, finding L-3 in
 * artifacts/cloud-sessions/security-review.md. Fixed: answers are kept per
 * host.
 */

const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let root: string;
const repositories = {
  findAgent: () => undefined,
  findTask: () => undefined,
  workspaceForCloud: (id: string) =>
    id === WS_A ? "local-a" : id === WS_B ? "local-b" : undefined,
  findWorkspace: (id: string) =>
    ({ id, path: join(root, id) }) as unknown as Workspace,
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "daedalus-cloud-review-"));
  await mkdir(join(root, "local-a"));
  await mkdir(join(root, "local-b"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("security review: daedal.call answers", () => {
  test("a call id answered for one workspace's host is not replayed to another host", async () => {
    const calls = new CloudCalls({
      repositories,
      home: "/mac/home",
      daedal: ["/mac/home/bin/daedal"],
      run: async (_executable, args) => ({
        exitCode: 0,
        stdout: `tasks of ${args.at(-1)}\n`,
        stderr: "",
      }),
    });
    const call: DaedalCall = {
      callId: "same-id",
      argv: ["task", "list"],
      cwd: ".",
      env: {},
      queueable: false,
      at: new Date().toISOString(),
    };
    const forA = await calls.answer(`ws:${WS_A}`, call);
    expect(forA.stdout).toBe("tasks of local-a\n");
    // A runner of workspace B that sends A's call id gets A's answer.
    const forB = await calls.answer(`ws:${WS_B}`, call);
    expect(forB.stdout).toBe("tasks of local-b\n");
  });
});
