/**
 * Seeds a throwaway home the size of a busy real one and times what the
 * desktop host reads on its 1.2 s change check and on every reload.
 *
 *   bun run scripts/perf-snapshot.ts [snapshot.json]
 *
 * The counts are a real machine's on 2026-10-22: 7 workspaces, 87 tasks and
 * 133 sessions, 30 of them running. With a path it also writes the desktop
 * snapshot as JSON, which `scripts/render-perf-check.ts` renders.
 */
import {
  withoutProviderClis,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";
import {
  createApplicationContext,
  ReadModel,
  type AgentSession,
} from "@daedalus/core";
import type { TmuxClient } from "@daedalus/platform";
import { desktopSnapshot } from "../apps/desktop/src/bun/rpc";

const noop = async () => {};
// Nothing here may reach a real tmux server.
const tmux = {
  openPty: () => ({ start: noop, write() {}, resize() {}, close() {} }),
  pinWindowSize: noop,
  unpinWindowSize: noop,
  probe: async () => "tmux 3.7c",
  createSession: noop,
  hasSession: async () => true,
  listSessions: async () => [],
  attach: async () => 0,
  capture: async () => "",
  sendKeys: noop,
  send: noop,
  stop: noop,
  killServer: async () => false,
} as unknown as TmuxClient;

const time = async (label: string, runs: number, run: () => unknown) => {
  await run();
  const start = performance.now();
  for (let index = 0; index < runs; index += 1) await run();
  console.log(
    `${label}: ${((performance.now() - start) / runs).toFixed(2)} ms`,
  );
};

await withTemporaryDaedalusHome(async (home) => {
  await withoutProviderClis(home);
  const context = await createApplicationContext({
    env: { ...process.env, DAEDALUS_HOME: home },
    tmux,
  });
  try {
    const workspaces = [];
    for (let index = 0; index < 7; index += 1)
      workspaces.push(await context.workspaces.create({ name: `W${index}` }));
    const tasks = [];
    for (let index = 0; index < 87; index += 1)
      tasks.push(
        await context.tasks.create({
          workspace: workspaces[index % 7]!.id,
          title: `Task ${index}`,
          description: "x".repeat(400),
        }),
      );
    const now = new Date().toISOString();
    for (let index = 0; index < 133; index += 1) {
      const id = crypto.randomUUID();
      const session: AgentSession = {
        id,
        workspaceId: workspaces[index % 7]!.id,
        taskId: tasks[index % tasks.length]!.id,
        name: `agent ${index}`,
        provider: "claude",
        kind: "agent",
        tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
        command: "claude",
        args: ["--settings", `${home}/settings.json`],
        workingDirectory: `${home}/w/${index}`,
        status: index < 30 ? "running" : "exited",
        exitCode: null,
        startedAt: now,
        endedAt: null,
        providerSessionId: null,
        archivedAt: index < 60 ? null : now,
        resumeCount: 0,
        lostReason: null,
        resumeOnStart: false,
        rebirthRequestedAt: null,
        position: index,
        pinnedAt: null,
        color: null,
        autoRebirthPercent: null,
        account: null,
        teamId: null,
        teamHandle: null,
        spawnedBy: null,
      };
      context.repositories.createAgent(session);
    }
    const readModel = new ReadModel(context);
    await time("readModel.version()", 50, () => readModel.version());
    console.log(
      `  version string: ${(await readModel.version()).length} characters`,
    );
    await time("readModel.snapshot()", 20, () => readModel.snapshot());
    await time("desktopSnapshot() + JSON", 20, async () =>
      JSON.stringify(await desktopSnapshot(readModel)),
    );
    const json = JSON.stringify(await desktopSnapshot(readModel));
    console.log(`  snapshot: ${json.length} bytes of JSON`);
    const output = Bun.argv[2];
    if (output) await Bun.write(output, json);
  } finally {
    context.close();
  }
});
