import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "@daedalus/core";
import {
  CommandTmuxClient,
  isInheritedSessionVariable,
  runCommand,
} from "@daedalus/platform";

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

  await checkInheritedEnvironment();

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

/**
 * The app opened from an agent's shell: the context's env, and the tmux server
 * that an older build already started from it, both carry that agent's
 * terminal state and identity. A session started there must see none of it.
 */
async function checkInheritedEnvironment(): Promise<void> {
  const pollutedHome = await mkdtemp(join(tmpdir(), "daedalus-tmux-env-"));
  const polluted: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DAEDALUS_HOME: pollutedHome,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    COLORTERM: "none",
    TMUX: "/private/tmp/tmux-501/default,1,0",
    TMUX_PANE: "%9",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    AI_AGENT: "codex",
    DAEDALUS_SESSION_ID: "another-session",
    DAEDALUS_TASK_ID: "another-task",
    DAEDALUS_TASK_NUMBER: "25",
    DAEDALUS_WORKSPACE_ID: "another-workspace",
  };
  await Bun.write(
    join(pollutedHome, "config.json"),
    JSON.stringify({
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const context = await createApplicationContext({ env: polluted });
  const client = context.tmux as CommandTmuxClient;
  try {
    // What a build without the fix left behind: a server whose global
    // environment came from the agent's shell.
    const seeded = await runCommand(
      client.executable,
      ["-L", client.socketName, "new-session", "-d", "-s", "seed"],
      { env: polluted, replaceEnvironment: true },
    );
    if (seeded.exitCode !== 0)
      throw new Error(`Could not seed a polluted server: ${seeded.stderr}`);
    const workspace = await context.workspaces.create({ name: "Env Check" });
    const agent = await context.agents.spawn({
      workspace: workspace.id,
      command: "shell",
    });
    const output = join(pollutedHome, "session-env.txt");
    await context.agents.send(agent.id, `env > '${output}'`);
    let seen = "";
    for (let attempt = 0; attempt < 40 && !seen; attempt += 1) {
      await Bun.sleep(100);
      const file = Bun.file(output);
      if (await file.exists()) seen = await file.text();
    }
    if (!seen) throw new Error("The session never wrote its environment");
    const values = new Map(
      seen
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as const;
        }),
    );
    // tmux sets TERM, COLORTERM, TMUX and TMUX_PANE for every pane, and the
    // launch sets the session's own DAEDALUS_* values. Each must be those
    // values, not the shell's.
    const setForTheSession = new Set([
      "TERM",
      "COLORTERM",
      "TMUX",
      "TMUX_PANE",
      "DAEDALUS_SESSION_ID",
      "DAEDALUS_WORKSPACE_ID",
    ]);
    const leaked = [...values.keys()].filter(
      (key) => isInheritedSessionVariable(key) && !setForTheSession.has(key),
    );
    if (leaked.length > 0)
      throw new Error(
        `The session inherited ${leaked.map((key) => `${key}=${values.get(key)}`).join(", ")}`,
      );
    if (values.get("TERM") === "dumb")
      throw new Error("The session inherited TERM=dumb");
    if (values.get("COLORTERM") === "none")
      throw new Error("The session inherited COLORTERM=none");
    if (values.get("TMUX_PANE") === "%9")
      throw new Error("The session inherited another server's TMUX_PANE");
    if (!values.get("TMUX")?.includes(client.socketName))
      throw new Error("The session inherited another server's TMUX");
    if (values.get("DAEDALUS_SESSION_ID") !== agent.id)
      throw new Error(
        `The session reports as ${values.get("DAEDALUS_SESSION_ID")}, not ${agent.id}`,
      );
    if (values.get("DAEDALUS_WORKSPACE_ID") !== workspace.id)
      throw new Error("The session inherited another workspace's ID");
    console.log("PASS a session sees none of an agent shell's environment");
  } finally {
    await client.killServer().catch(() => false);
    context.close();
    await rm(pollutedHome, { recursive: true, force: true });
  }
}
