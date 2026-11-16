import { join } from "node:path";
import { expect, test } from "vitest";
import { SqliteRepositories, type AgentSession } from "@daedalus/core";
import {
  NO_LOGIN_SHELL,
  withTemporaryDaedalusHome,
} from "@daedalus/test-utils";

async function cli(home: string, args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...NO_LOGIN_SHELL,
    DAEDALUS_HOME: home,
  };
  // Run as the user, not as the session this suite may be running in.
  for (const name of Object.keys(env))
    if (name.startsWith("DAEDALUS_") && name !== "DAEDALUS_HOME")
      delete env[name];
  delete env.TMUX;
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** A session's row, as if it were running; nothing is started. */
function addSession(
  home: string,
  name = "Session",
  status: AgentSession["status"] = "running",
): string {
  const repositories = new SqliteRepositories(join(home, "state.db"));
  const id = crypto.randomUUID();
  const session: AgentSession = {
    id,
    workspaceId: "shop",
    taskId: null,
    name,
    provider: "claude",
    kind: "agent",
    tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
    command: "claude",
    args: [],
    workingDirectory: join(home, "workspaces", "shop"),
    status,
    exitCode: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    providerSessionId: null,
    archivedAt: null,
    resumeCount: 0,
    lostReason: null,
    resumeOnStart: false,
    rebirthRequestedAt: null,
    position: 0,
    pinnedAt: null,
    color: null,
    autoRebirthPercent: null,
    account: null,
    teamId: null,
    teamHandle: null,
    spawnedBy: null,
    hostId: null,
  };
  repositories.createAgent(session);
  repositories.close();
  return id;
}

test("thread done refuses a session in no team; help names done and reopen", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    expect((await cli(home, ["workspace", "create", "Shop"])).exitCode).toBe(0);
    const session = addSession(home, "Loner");

    const refused = await cli(home, ["thread", "done", session]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("'Loner' is in no lead's team");

    const removed = await cli(home, ["thread", "track", session]);
    expect(removed.exitCode).not.toBe(0);
    expect(removed.stderr).toContain("Unknown thread command 'track'");

    const help = await cli(home, ["thread", "--help"]);
    expect(help.stdout).toContain("daedal thread done <session>");
    expect(help.stdout).toContain("daedal thread reopen <session>");
    expect(help.stdout).not.toContain("track");
  });
}, 30_000);
