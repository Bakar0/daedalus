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

/** A lead's row, as if it were running; nothing is started. */
function addLead(home: string): string {
  const repositories = new SqliteRepositories(join(home, "state.db"));
  const id = crypto.randomUUID();
  const session: AgentSession = {
    id,
    workspaceId: "shop",
    taskId: null,
    name: "Main agent",
    provider: "claude",
    kind: "agent",
    tmuxSession: `daedalus_${id.replaceAll("-", "")}`,
    command: "claude",
    args: [],
    workingDirectory: join(home, "workspaces", "shop"),
    status: "running",
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

test("thread suggest saves a suggestion for the lead's Threads pane", async () => {
  await withTemporaryDaedalusHome(async (home) => {
    expect((await cli(home, ["workspace", "create", "Shop"])).exitCode).toBe(0);
    const lead = addLead(home);

    const suggested = await cli(home, [
      "thread",
      "suggest",
      "Load-test GET /cart",
      "--workspace",
      "shop",
      "--message",
      "2,400 reads/s; report p99",
      "--lead",
      lead,
    ]);
    expect(suggested.stderr).toBe("");
    expect(suggested.stdout).toContain(
      "Suggested thread 1: Load-test GET /cart",
    );

    const listed = await cli(home, [
      "thread",
      "suggestions",
      "--lead",
      lead,
      "--json",
    ]);
    expect(JSON.parse(listed.stdout).data).toEqual([
      expect.objectContaining({
        id: 1,
        leadSessionId: lead,
        title: "Load-test GET /cart",
        workspaceId: "shop",
        message: "2,400 reads/s; report p99",
      }),
    ]);

    const dismissed = await cli(home, ["thread", "dismiss", "1"]);
    expect(dismissed.stdout).toContain("Dismissed Load-test GET /cart");
    expect(
      (await cli(home, ["thread", "suggestions", "--lead", lead])).stdout,
    ).toContain("No suggested threads");

    // Outside a session, with no --lead, it says what to pass.
    const orphan = await cli(home, ["thread", "suggest", "Anything"]);
    expect(orphan.exitCode).not.toBe(0);
    expect(orphan.stderr).toContain("--lead <session>");

    const help = await cli(home, ["thread", "--help"]);
    expect(help.stdout).toContain('daedal thread suggest "<title>"');
  });
}, 30_000);
