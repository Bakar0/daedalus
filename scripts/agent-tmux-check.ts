import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "@daedalus/core";
import { CommandTmuxClient, runCommand } from "@daedalus/platform";

const home = await mkdtemp(join(tmpdir(), "daedalus-tmux-integration-"));
const socket = `daedalus-test-${crypto.randomUUID()}`;
const tmux = new CommandTmuxClient(socket);
let agentId: string | undefined;

try {
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const context = await createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux,
  });
  const workspace = await context.workspaces.create({ name: "Tmux Check" });
  const agent = await context.agents.spawn({
    workspace: workspace.id,
    command: "shell",
  });
  agentId = agent.id;
  context.close();

  const restarted = await createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux,
  });
  const restored = await restarted.agents.get(agent.id);
  if (restored.status !== "running")
    throw new Error(
      `Expected running after restart, received ${restored.status}`,
    );
  const marker = `DAEDALUS_TMUX_${crypto.randomUUID()}`;
  await restarted.agents.send(agent.id, `printf '${marker}\\n'`);
  await Bun.sleep(250);
  const capture = await runCommand("tmux", [
    "-L",
    socket,
    "capture-pane",
    "-p",
    "-t",
    restored.tmuxSession,
  ]);
  if (!capture.stdout.includes(marker))
    throw new Error("Sent input did not reach the isolated tmux pane");
  await restarted.agents.stop(agent.id, true);
  if ((await restarted.agents.get(agent.id)).status !== "exited")
    throw new Error("Stopped session was not persisted as exited");
  restarted.close();

  console.log("PASS durable ID-based isolated tmux session");
  console.log("PASS restart reconciliation preserves live session");
  console.log("PASS literal input reaches agent pane");
  console.log("PASS stop persists terminal session state");
} finally {
  if (agentId) {
    const sessions = await tmux.listSessions();
    for (const session of sessions) await tmux.stop(session, true);
  }
  await rm(home, { recursive: true, force: true });
}
