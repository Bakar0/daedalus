/**
 * Moving a session, end to end on the kind cluster, with this Mac's real
 * code: a real Claude session on this Mac, with a repository and work in
 * progress of every kind, moves to its workspace's pod and back, and must
 * come back with the pod's work and the same conversation.
 *
 *   bun run scripts/cloud-move-try.ts run       # the round trip
 *   bun run scripts/cloud-move-try.ts cleanup   # deletes the pod, its volume and the sessions
 *
 * It runs from a home of its own (~/.daedalus-move-try-dev, file vault), as
 * user move-try@test.com on the gateway at http://localhost:8080, and holds
 * the link itself, standing in for the app. The Claude on this Mac uses the
 * user's own Claude sign-in; the Claude in the pod is signed out, so it is
 * checked for its resume, not asked anything.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import {
  claudeProjectKey,
  cloudHostId,
  createApplicationContext,
  podWorkingDirectory,
  RemoteSessionHost,
} from "@daedalus/core";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-move-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "move-try@test.com";
const WORKSPACE = "move-try";

const mode = process.argv[2];
if (mode !== "run" && mode !== "cleanup") {
  console.error("Usage: cloud-move-try.ts run|cleanup");
  process.exit(2);
}

const say = (text: string) => console.log(`[move-try] ${text}`);
const fail = (text: string): never => {
  console.log(`FAIL: ${text}`);
  process.exit(1);
};
const check = (ok: boolean, text: string) =>
  ok ? say(`ok: ${text}`) : fail(text);

const git = async (cwd: string, ...args: string[]) => {
  const result = await runCommand(
    "git",
    ["-c", "user.name=move-try", "-c", "user.email=move-try@test", ...args],
    { cwd },
  );
  if (result.exitCode !== 0)
    fail(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const context = await createApplicationContext({
  env: { ...process.env, DAEDALUS_HOME: HOME },
});
const { cloud, agents, repositories } = context;

const waitIdle = async (sessionId: string, what: string) => {
  // A hook says "working" first; a turn has ended once it no longer does.
  await Bun.sleep(3_000);
  for (let waited = 0; waited < 180_000; waited += 1_000) {
    const activity = (await context.activity.binding(sessionId))?.activity;
    if (activity && activity !== "working" && activity !== "unknown") return;
    await Bun.sleep(1_000);
  }
  fail(`${what}: the turn never ended`);
};

try {
  if (!(await cloud.account.signIn())) {
    await cloud.devLogin(GATEWAY, EMAIL);
    say(`signed in to ${GATEWAY} as ${EMAIL}`);
  }
  await cloud.hold();
  const workspace = await context.workspaces
    .get(WORKSPACE)
    .catch(() => context.workspaces.create({ name: WORKSPACE }));

  if (mode === "cleanup") {
    for (const session of repositories.listAgents({
      workspaceId: workspace.id,
    })) {
      if (session.status === "running")
        await agents.stop(session.id, true).catch(() => undefined);
    }
    if (repositories.cloudWorkspaceId(workspace.id)) {
      await cloud.delete(workspace.id);
      say("deleted the cloud workspace, its pod and its volume");
    } else say("no cloud workspace to delete");
    process.exit(0);
  }

  // A repository of its own, attached to the workspace.
  const source = join(HOME, "source-app");
  if (!existsSync(source)) {
    await mkdir(source, { recursive: true });
    await git(source, "init", "-q", "-b", "main");
    await writeFile(join(source, "README.md"), "move try\n");
    await writeFile(join(source, ".gitignore"), "secret.env\n");
    await git(source, "add", "-A");
    await git(source, "commit", "-q", "-m", "start");
  }
  if (!repositories.listWorkspaceRepositories(workspace.id).length)
    await context.workspaceContent.addAndAttachRepository({
      workspace: workspace.id,
      remoteUrl: source,
      name: "app",
    });

  const word = `PELICAN${Math.floor(Math.random() * 9000 + 1000)}`;
  const session = await agents.spawn({
    workspace: workspace.id,
    provider: "claude",
    name: "move try",
    message: `Remember this word for later: ${word}. Reply with just OK and do nothing else.`,
  });
  say(
    `local Claude session ${session.id.slice(0, 8)} in ${session.workingDirectory}`,
  );
  await waitIdle(session.id, "first turn");
  const worktree = await context.workspaceContent.createSessionWorktree({
    session: session.id,
    repository: "app",
    branch: `move-try-${session.id.slice(0, 8)}`,
  });
  const repo = worktree.path;

  // Work in progress of every kind.
  await writeFile(join(repo, "committed.txt"), "a commit on the Mac\n");
  await git(repo, "add", "committed.txt");
  await git(repo, "commit", "-q", "-m", "mac commit");
  await writeFile(join(repo, "README.md"), "move try\nstaged\n");
  await git(repo, "add", "README.md");
  await writeFile(join(repo, "README.md"), "move try\nstaged\nunstaged\n");
  await writeFile(join(repo, "untracked.txt"), "untracked on the Mac\n");
  await writeFile(join(repo, "secret.env"), "ignored, stays on the Mac\n");

  check(
    (await context.hosts.local.capture(session.tmuxSession)).includes(
      "auto mode on",
    ),
    "before the move, Claude on this Mac runs in auto mode",
  );
  let started = Date.now();
  const toCloud = await context.moves.move({
    sessionId: session.id,
    to: "cloud",
  });
  if (toCloud.status !== "moved")
    fail("the move to the cloud asked for approval");
  const inCloud = await agents.get(session.id);
  say(`moved to the cloud in ${Math.round((Date.now() - started) / 1000)} s`);
  const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
  check(
    inCloud.hostId === cloudHostId(cloudId),
    "the session's host is the pod",
  );
  check(
    inCloud.id === session.id && inCloud.position === session.position,
    "same id and place",
  );
  const host = context.hosts.get(inCloud.hostId!);
  if (!(host instanceof RemoteSessionHost)) fail("no pod host");
  const pod = host as RemoteSessionHost;
  const podRepo = `${inCloud.workingDirectory}/${repo.split("/").at(-1)}`;
  const inPod = async (...args: string[]) => {
    const result = await pod.run({
      cwd: podRepo,
      executable: args[0]!,
      args: args.slice(1),
    });
    return result.stdout.trim();
  };
  check(
    (await inPod("git", "log", "-1", "--format=%s")) === "mac commit",
    "the commit is in the pod",
  );
  check(
    (await inPod("git", "branch", "--show-current")) === worktree.branchName,
    "on the session's branch",
  );
  check(
    (await inPod("git", "show", ":README.md")) === "move try\nstaged",
    "the staged change is staged",
  );
  check(
    (await inPod("cat", "README.md")) === "move try\nstaged\nunstaged",
    "the unstaged change is there",
  );
  check(
    (await inPod("cat", "untracked.txt")) === "untracked on the Mac",
    "the untracked file is there",
  );
  check(
    (
      await pod.run({
        cwd: podRepo,
        executable: "test",
        args: ["-e", "secret.env"],
      })
    ).exitCode !== 0,
    "the ignored file stayed on the Mac",
  );
  const podTranscript = await pod.readText(
    `.home/.claude/projects/${claudeProjectKey(podWorkingDirectory(inCloud.workingDirectory))}/${session.providerSessionId}.jsonl`,
  );
  check(
    Boolean(podTranscript?.includes(word)),
    "the conversation is in the pod",
  );
  check(
    inCloud.args.includes("--resume"),
    "the pod's Claude resumed the conversation",
  );
  check(await pod.isLive(inCloud.tmuxSession), "the pod's Claude is running");

  // Work in the pod.
  await pod.run({
    cwd: podRepo,
    executable: "bash",
    args: [
      "-c",
      'echo "a commit in the cloud" > cloud.txt && git add cloud.txt && git -c user.name=pod -c user.email=pod@test commit -q -m "cloud commit" && echo "untracked in the cloud" > cloud-untracked.txt && rm untracked.txt',
    ],
  });

  started = Date.now();
  const back = await context.moves.move({ sessionId: session.id, to: "local" });
  if (back.status !== "moved")
    fail(`the move back asked for approval: ${back.paths.join(", ")}`);
  const onMac = await agents.get(session.id);
  say(`moved back in ${Math.round((Date.now() - started) / 1000)} s`);
  check(
    onMac.hostId === null &&
      onMac.workingDirectory === session.workingDirectory,
    "back in its Mac folder",
  );
  check(
    (await git(repo, "log", "-1", "--format=%s")) === "cloud commit",
    "the pod's commit is on the Mac",
  );
  check(
    (await readFile(join(repo, "cloud-untracked.txt"), "utf8")) ===
      "untracked in the cloud\n",
    "the pod's untracked file is on the Mac",
  );
  check(
    !existsSync(join(repo, "untracked.txt")),
    "the file removed in the pod is gone",
  );
  check(
    (await git(repo, "show", ":README.md")) === "move try\nstaged",
    "still staged",
  );
  check(
    (await readFile(join(repo, "secret.env"), "utf8")).startsWith("ignored"),
    "the ignored file is untouched",
  );

  check(
    Boolean(back.notice?.includes("ask")),
    "the move back says it resumed asking first",
  );
  const footer = await context.hosts.local.capture(onMac.tmuxSession);
  check(
    !footer.includes("auto mode on") && !footer.includes("accept edits on"),
    "Claude on this Mac asks before acting",
  );

  // The same conversation: Claude on this Mac remembers the word.
  await agents.send(
    session.id,
    "What word did I ask you to remember? Reply with just the word.",
  );
  // The answer is the first assistant entry after the question.
  let answer = "";
  for (let waited = 0; waited < 180_000 && !answer; waited += 1_000) {
    await Bun.sleep(1_000);
    const entries = (
      await readFile(
        join(
          agents.claudeProjectsDirectory(onMac),
          claudeProjectKey(onMac.workingDirectory),
          `${session.providerSessionId}.jsonl`,
        ),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            message?: { content?: unknown };
          },
      );
    const asked = entries.findLastIndex(
      (entry) =>
        entry.type === "user" &&
        JSON.stringify(entry.message?.content ?? "").includes("What word"),
    );
    const reply =
      asked === -1
        ? undefined
        : entries.slice(asked + 1).find((entry) => entry.type === "assistant");
    if (reply) answer = JSON.stringify(reply.message?.content ?? "");
  }
  check(answer.includes(word), `Claude on this Mac still knows ${word}`);
  say("PASS: moved to the cloud and back with its work and its conversation");
  await agents.stop(session.id, true).catch(() => undefined);
  process.exit(0);
} catch (error) {
  const details = (error as { details?: unknown }).details;
  fail(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${details ? `\n${JSON.stringify(details)}` : ""}`,
  );
}
