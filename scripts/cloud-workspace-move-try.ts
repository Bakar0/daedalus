/**
 * A whole workspace moving between this Mac and its cloud copy, end to end
 * on the kind cluster, with this Mac's real code and the app's own RPC
 * handlers:
 *
 *   bun run scripts/cloud-workspace-move-try.ts run        # to the cloud, work there, home, back, archive
 *   bun run scripts/cloud-workspace-move-try.ts fallback   # the copy is collected; the Mac takes its backup
 *   bun run scripts/cloud-workspace-move-try.ts orphans    # copies no workspace lives in go when the limit is hit
 *   bun run scripts/cloud-workspace-move-try.ts cleanup    # deletes what a run left
 *
 * It runs from a home of its own (~/.daedalus-lifecycle-try-dev, file vault),
 * as user lifecycle-try@test.com on the gateway at http://localhost:8080, and
 * holds the link itself, standing in for the app. The Claude conversation
 * starts on this Mac with the user's own Claude sign-in.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { runCommand } from "@daedalus/platform";
import {
  CLOUD_COLLECTED_REASON,
  COLLECTED_CONFIRM_MS,
  claudeProjectKey,
  cloudHostId,
  createApplicationContext,
  GatewayClient,
  RemoteSessionHost,
} from "@daedalus/core";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-lifecycle-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "lifecycle-try@test.com";

const mode = process.argv[2];
if (
  mode !== "run" &&
  mode !== "fallback" &&
  mode !== "orphans" &&
  mode !== "cleanup"
) {
  console.error(
    "Usage: cloud-workspace-move-try.ts run|fallback|orphans|cleanup",
  );
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
    ["-c", "user.name=try", "-c", "user.email=try@test", ...args],
    { cwd },
  );
  if (result.exitCode !== 0)
    fail(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

/** The cloud service's clock: the fallback run lets an hour pass. */
let skipped = 0;
const context = await createApplicationContext({
  env: { ...process.env, DAEDALUS_HOME: HOME },
  cloud: { now: () => Date.now() + skipped },
});
const { cloud, agents, repositories, workspaceContent } = context;
const rpc = createDesktopRequestHandlers(context);

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

/** Until the session's screen in the pod shows `text`, or 90 s. */
const screenShows = async (
  host: RemoteSessionHost,
  tmuxSession: string,
  text: string,
) => {
  let screen = "";
  for (let waited = 0; waited < 90_000; waited += 2_000) {
    screen = await host.capture(tmuxSession);
    if (screen.includes(text)) return screen;
    await Bun.sleep(2_000);
  }
  say(`screen:\n${screen}`);
  return undefined;
};

const move = async (workspaceId: string, to: "cloud" | "mac") => {
  const started = Date.now();
  const answer = await rpc.workspaceMove({ reference: workspaceId, to });
  if (!answer.ok) return fail(`move to ${to}: ${answer.error.message}`);
  if (answer.data.status !== "moved")
    return fail(`move to ${to}: ${JSON.stringify(answer.data)}`);
  say(`moved to ${to} in ${Math.round((Date.now() - started) / 1000)} s`);
  if (answer.data.notice) say(`notice: ${answer.data.notice}`);
  return answer.data;
};

/** A bare repository on this Mac standing in for the git host. */
async function origin(): Promise<string> {
  const bare = join(HOME, "origin-app.git");
  if (existsSync(bare)) return bare;
  const seed = join(HOME, "origin-seed");
  await rm(seed, { recursive: true, force: true });
  await mkdir(seed, { recursive: true });
  await git(seed, "init", "-q", "-b", "main");
  await writeFile(join(seed, "README.md"), "move try\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-q", "-m", "start");
  await git(HOME, "clone", "-q", "--bare", seed, bare);
  return bare;
}

try {
  if (!(await cloud.account.signIn())) {
    await cloud.devLogin(GATEWAY, EMAIL);
    say(`signed in to ${GATEWAY} as ${EMAIL}`);
  }
  await cloud.hold();

  if (mode === "cleanup") {
    for (const workspace of repositories.listWorkspaces()) {
      for (const session of repositories.listAgents({
        workspaceId: workspace.id,
      }))
        if (session.status === "running")
          await agents.stop(session.id, true).catch(() => undefined);
      if (repositories.cloudWorkspaceId(workspace.id)) {
        await cloud.delete(workspace.id);
        say(`deleted ${workspace.name}'s cloud copy`);
      }
    }
    process.exit(0);
  }

  const workspace = await context.workspaces.create({
    name: `move-${mode}-${Date.now().toString(36)}`,
  });
  const word = `OSPREY${Math.floor(Math.random() * 9000 + 1000)}`;

  if (mode === "orphans") {
    // One workspace in the cloud, then copies of workspaces on this Mac and
    // an archived one up to the gateway's limit of 5, as old versions left.
    await move(workspace.id, "cloud");
    const kept = repositories.cloudWorkspaceId(workspace.id)!;
    const leftovers: string[] = [];
    for (let index = 0; index < 4; index++) {
      const left = await context.workspaces.create({
        name: `move-orphan-${index}-${Date.now().toString(36)}`,
      });
      leftovers.push((await cloud.create(left.id)).workspaceId);
      if (index === 0) await context.workspaces.archive(left.id);
    }
    check((await cloud.list()).length === 5, "the account is at its limit");
    const next = await context.workspaces.create({
      name: `move-orphans-next-${Date.now().toString(36)}`,
    });
    await mkdir(join(next.path, "notes"), { recursive: true });
    await writeFile(join(next.path, "notes", "n.md"), "next\n");
    await move(next.id, "cloud");
    const listed = (await cloud.list()).map((item) => item.workspaceId);
    check(
      leftovers.every((id) => !listed.includes(id)),
      "the move deleted every copy no workspace lives in",
    );
    check(
      listed.includes(kept) &&
        (await context.workspaces.get(workspace.id)).place === "cloud",
      "and kept the one whose workspace is in the cloud",
    );
    check(
      (await context.workspaces.get(next.id)).place === "cloud",
      "the new workspace moved to the cloud",
    );
    await move(next.id, "mac");
    check(
      !(await cloud.list()).some(
        (item) =>
          item.workspaceId !== kept && !leftovers.includes(item.workspaceId),
      ),
      "moving it home deleted its copy",
    );
    say("PASS: orphan copies went at the limit, the cloud workspace's stayed");
    process.exit(0);
  }

  if (mode === "fallback") {
    await mkdir(join(workspace.path, "notes"), { recursive: true });
    await writeFile(join(workspace.path, "notes", "kept.md"), "backup\n");
    await move(workspace.id, "cloud");
    const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
    const shell = await rpc.agentSpawn({
      workspace: workspace.id,
      terminal: true,
    });
    if (!shell.ok) fail(`terminal: ${shell.error.message}`);
    // Collected behind the Mac's back, as the gateway's 30-day rule does.
    const signIn = await cloud.account.requireSignIn();
    await new GatewayClient(signIn.gatewayUrl, signIn.token).deleteWorkspace(
      cloudId,
    );
    check((await rpc.cloudState({})).ok, "the Mac asked the gateway");
    check(
      repositories.cloudWorkspaceId(workspace.id) === cloudId &&
        (await context.workspaces.get(workspace.id)).place === "cloud",
      "one answer that it is gone keeps the workspace in the cloud",
    );
    skipped += COLLECTED_CONFIRM_MS;
    check((await rpc.cloudState({})).ok, "the Mac asked again an hour later");
    const back = await context.workspaces.get(workspace.id);
    check(back.place !== "cloud", "the workspace lives on this Mac again");
    check(
      Boolean(back.cloudNotice),
      `with a notice: ${back.cloudNotice ?? "none"}`,
    );
    check(
      repositories.cloudWorkspaceId(workspace.id) === undefined,
      "the link is forgotten",
    );
    if (shell.ok) {
      const session = await agents.get(shell.data.id);
      check(
        session.hostId === null &&
          session.status === "lost" &&
          session.lostReason === CLOUD_COLLECTED_REASON,
        `its session reads lost here: ${session.lostReason}`,
      );
    }
    check(
      (await readFile(join(workspace.path, "notes", "kept.md"), "utf8")) ===
        "backup\n",
      "the backup's files are there",
    );
    say("PASS: a collected copy left the workspace on this Mac at its backup");
    process.exit(0);
  }

  // run
  const repository = await workspaceContent.addAndAttachRepository({
    workspace: workspace.id,
    remoteUrl: await origin(),
    name: "app",
  });
  await mkdir(join(workspace.path, "notes"), { recursive: true });
  await writeFile(join(workspace.path, "notes", "mac.md"), "from the Mac\n");
  const spawned = await agents.spawn({
    workspace: workspace.id,
    provider: "claude",
    name: "move try",
    message: `Remember this word for later: ${word}. Reply with just OK and do nothing else.`,
  });
  await waitIdle(spawned.id, "first turn");
  // Opened and never used: Claude has written no conversation for it.
  const unused = await agents.spawn({
    workspace: workspace.id,
    provider: "claude",
    name: "never used",
  });

  // To the cloud.
  await move(workspace.id, "cloud");
  const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
  const hostId = cloudHostId(cloudId);
  const host = context.hosts.get(hostId) as RemoteSessionHost;
  const inCloud = await agents.get(spawned.id);
  check(
    inCloud.hostId === hostId && inCloud.status === "running",
    "the session runs in the pod",
  );
  check(
    (await context.workspaces.get(workspace.id)).place === "cloud",
    "the workspace's place is the cloud",
  );
  await Bun.sleep(10_000);
  const unusedInCloud = await agents.get(unused.id);
  check(
    unusedInCloud.status === "running" &&
      (await host.isLive(unusedInCloud.tmuxSession)),
    "a session that never had a turn still runs in the pod after 10 s",
  );
  check(
    (
      await host.run({
        cwd: ".",
        executable: "bash",
        args: ["-c", "ls -A | grep -c '^\\._' || true"],
      })
    ).stdout.trim() === "0",
    "no macOS ._ files arrived in the pod",
  );

  // The explorer works in the pod.
  const listed = await workspaceContent.listDirectory(workspace.id, "notes");
  check(
    listed.some((entry) => entry.name === "mac.md"),
    "the explorer lists the pod's notes/",
  );
  const macNote = await workspaceContent.readFile(workspace.id, "notes/mac.md");
  check(macNote.content === "from the Mac\n", "and reads a file there");
  await workspaceContent.createEntry({
    workspace: workspace.id,
    parentPath: "notes",
    name: "pod.md",
    kind: "file",
  });
  await workspaceContent.writeFile({
    workspace: workspace.id,
    path: "notes/pod.md",
    content: `written in the cloud ${word}\n`,
    expectedContent: "",
  });
  check(
    (await host.readText("notes/pod.md"))?.includes(word) === true,
    "the editor's save landed in the pod",
  );
  const content = await workspaceContent.get(workspace.id);
  check(content.brief.length > 0, "the brief is read from the pod");
  await workspaceContent
    .appendJournal({ workspace: workspace.id, kind: "decision", summary: "x" })
    .then(
      () => fail("a journal append wrote this Mac's backup"),
      () => say("ok: this Mac's backup refuses a journal append"),
    );

  // The conversation resumed in the pod, its history on screen. (Answering
  // needs the pod's Claude signed in, which this home does not do.)
  check(
    Boolean(await screenShows(host, inCloud.tmuxSession, word)),
    "Claude resumed the conversation in the pod",
  );

  // A worktree in the pod, a commit there, pushed to the origin.
  const branch = `try/${word.toLowerCase()}`;
  const worktree = await workspaceContent.createSessionWorktree({
    session: spawned.id,
    repository: repository.id,
    branch,
  });
  const podTree = relative(workspace.path, worktree.path);
  const inPod = async (cwd: string, script: string) => {
    const result = await host.run({
      cwd,
      executable: "bash",
      args: ["-c", script],
    });
    if (result.exitCode !== 0) fail(`in the pod: ${result.stderr}`);
    return result.stdout.trim();
  };
  check(
    (await inPod(podTree, "git branch --show-current")) === branch,
    `a worktree on ${branch} in the pod`,
  );
  await inPod(
    podTree,
    `echo "${word}" > cloud.txt && git add cloud.txt && git -c user.name=pod -c user.email=pod@test commit -q -m "made in the cloud"`,
  );
  const pushed = await workspaceContent.pushSessionWorktree({
    session: spawned.id,
    repository: repository.id,
  });
  check(!pushed.alreadyUpToDate, "the push sent the pod's commit");
  check(
    (await git(await origin(), "log", "-1", "--format=%s", branch)) ===
      "made in the cloud",
    "the origin has the branch with the pod's commit",
  );
  await inPod(podTree, "echo wip > wip.txt");

  // A session started while the workspace is in the cloud.
  const born = await rpc.agentSpawn({
    workspace: workspace.id,
    provider: "claude",
    name: "born in the cloud",
    message: "Reply with just READY and do nothing else.",
  });
  if (!born.ok) fail(`spawn in the cloud: ${born.error.message}`);
  if (born.ok) {
    check(born.data.hostId === hostId, "a new session starts in the pod");
    const screen = await screenShows(host, born.data.tmuxSession, "READY");
    check(
      Boolean(screen && !/trust the files|Do you trust/i.test(screen)),
      "Claude in a session folder starts without asking to trust it",
    );
    await waitIdle(born.data.id, "born session's turn");
  }

  // Home.
  await move(workspace.id, "mac");
  const home = await agents.get(spawned.id);
  check(
    home.hostId === null && home.status === "running",
    "the session runs on this Mac again",
  );
  await Bun.sleep(10_000);
  const unusedHome = await agents.get(unused.id);
  check(
    unusedHome.hostId === null &&
      unusedHome.status === "running" &&
      (await context.hosts.local.isLive(unusedHome.tmuxSession)),
    "the never-used session still runs on this Mac after 10 s",
  );
  const macTree = join(home.workingDirectory, "app");
  check(
    (await git(macTree, "branch", "--show-current")) === branch,
    "the worktree came home on its branch",
  );
  check(
    (await git(macTree, "log", "-1", "--format=%s")) === "made in the cloud",
    "with the pod's commit",
  );
  check(existsSync(join(macTree, "wip.txt")), "and its uncommitted file");
  check(
    (await readFile(join(workspace.path, "notes", "pod.md"), "utf8")).includes(
      word,
    ),
    "the file written in the cloud came home",
  );
  const transcript = await readFile(
    join(
      agents.claudeProjectsDirectory(home),
      claudeProjectKey(home.workingDirectory),
      `${home.providerSessionId}.jsonl`,
    ),
    "utf8",
  );
  check(transcript.includes(word), "the conversation came home");
  check(
    !transcript.includes('"cwd":"/workspace'),
    "its folders are this Mac's",
  );
  check(
    repositories.cloudWorkspaceId(workspace.id) === undefined &&
      !(await cloud.list()).some((item) => item.workspaceId === cloudId),
    "moving home deleted the cloud copy",
  );

  // Back to the cloud, then archived from there.
  await writeFile(join(workspace.path, "notes", "again.md"), "second trip\n");
  await move(workspace.id, "cloud");
  // A new copy, everything sent again.
  const againId = repositories.cloudWorkspaceId(workspace.id)!;
  const again = context.hosts.get(cloudHostId(againId)) as RemoteSessionHost;
  check(againId !== cloudId, "the second move made a new cloud copy");
  check(
    (await again.readText("notes/again.md")) === "second trip\n" &&
      (await again.readText("notes/pod.md"))?.includes(word) === true,
    "and sent everything, the changes and what came home before",
  );
  const archived = await rpc.workspaceArchive({ reference: workspace.id });
  if (!archived.ok) fail(`archive: ${archived.error.message}`);
  check(
    archived.ok && archived.data.status === "archived",
    "archived from the cloud",
  );
  check(
    repositories.cloudWorkspaceId(workspace.id) === undefined &&
      !(await cloud.list()).some((item) => item.workspaceId === againId),
    "the cloud copy is deleted",
  );
  check(
    (await agents.get(spawned.id)).hostId === null,
    "its sessions are this Mac's",
  );
  say("PASS: the workspace went to the cloud and home, and was archived");
  process.exit(0);
} catch (error) {
  const details = (error as { details?: unknown }).details;
  fail(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${details ? `\n${JSON.stringify(details)}` : ""}`,
  );
}
