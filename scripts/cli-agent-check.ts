import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";

const root = join(import.meta.dir, "..");
const home = await mkdtemp(join(tmpdir(), "daedalus-cli-agent-"));
const socket = `daedalus-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;

async function cli(args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(root, "apps/cli/src/index.ts"),
      ...args,
      "--json",
    ],
    {
      cwd: root,
      env: { ...process.env, DAEDALUS_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(
      `CLI failed (${exitCode}): ${stderr.trim() || stdout.trim()}`,
    );
  return (JSON.parse(stdout) as { data: unknown }).data;
}

try {
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const workspace = (await cli(["workspace", "create", "CLI Agent"])) as {
    id: string;
  };
  const task = (await cli([
    "task",
    "create",
    "--workspace",
    workspace.id,
    "--title",
    "CLI lifecycle",
  ])) as { id: string };
  const agent = (await cli([
    "agent",
    "spawn",
    "--workspace",
    workspace.id,
    "--command",
    "shell",
    "--task",
    task.id,
  ])) as { id: string; status: string };
  if (agent.status !== "running")
    throw new Error("Agent did not start running");
  const running = (await cli(["agent", "list", "--running"])) as Array<{
    id: string;
  }>;
  if (!running.some((item) => item.id === agent.id))
    throw new Error("Running agent was not reconciled by a new CLI process");
  await cli(["agent", "send", agent.id, "printf 'CLI_AGENT_OK\\n'"]);
  const stopped = (await cli(["agent", "stop", agent.id, "--force"])) as {
    status: string;
  };
  if (stopped.status !== "exited")
    throw new Error("Agent did not stop cleanly");
  await cli(["agent", "remove", agent.id]);
  await cli(["task", "remove", task.id, "--force"]);
  const removed = (await cli([
    "workspace",
    "remove",
    workspace.id,
    "--delete-files",
    "--force",
  ])) as { filesDeleted: boolean };
  if (!removed.filesDeleted)
    throw new Error("Workspace files were not deleted");

  console.log("PASS workspace and task setup through JSON CLI");
  console.log("PASS task-backed custom agent spawn and restart reconciliation");
  console.log("PASS send, stop, and agent history removal through CLI");
  console.log("PASS guarded task and workspace cleanup through CLI");
} finally {
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
}
