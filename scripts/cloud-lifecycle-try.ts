/**
 * The cloud lifecycle end to end on the kind cluster, with this Mac's real
 * code and the app's own RPC handlers:
 *
 *   bun run scripts/cloud-lifecycle-try.ts archive   # archive brings a cloud-born session home, then the workspace's cloud copy goes
 *   bun run scripts/cloud-lifecycle-try.ts sleep     # the pod sleeps after 15 idle minutes; a message wakes and resumes it
 *   bun run scripts/cloud-lifecycle-try.ts cleanup   # deletes what a run left
 *
 * It runs from a home of its own (~/.daedalus-lifecycle-try-dev, file vault),
 * as user lifecycle-try@test.com on the gateway at http://localhost:8080, and
 * holds the link itself, standing in for the app. Conversations start on
 * this Mac with the user's own Claude sign-in; the pod's Claude is signed
 * out. A session born in the cloud is made from one that moved there: its
 * conversation is put where a session started in the pod root keeps it.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import {
  claudeProjectKey,
  CLOUD_SLEEP_REASON,
  cloudHostId,
  createApplicationContext,
  podWorkingDirectory,
  RemoteSessionHost,
} from "@daedalus/core";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-lifecycle-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "lifecycle-try@test.com";

const mode = process.argv[2];
if (mode !== "archive" && mode !== "sleep" && mode !== "cleanup") {
  console.error("Usage: cloud-lifecycle-try.ts archive|sleep|cleanup");
  process.exit(2);
}

const say = (text: string) => console.log(`[lifecycle-try] ${text}`);
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

const context = await createApplicationContext({
  env: { ...process.env, DAEDALUS_HOME: HOME },
});
const { cloud, agents, repositories } = context;
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

/** A Claude conversation on this Mac that remembers a word, moved to the pod. */
async function conversationInPod(workspaceId: string, word: string) {
  const session = await agents.spawn({
    workspace: workspaceId,
    provider: "claude",
    name: `${mode} try`,
    message: `Remember this word for later: ${word}. Reply with just OK and do nothing else.`,
  });
  await waitIdle(session.id, "first turn");
  const moved = await context.moves.move({
    sessionId: session.id,
    to: "cloud",
  });
  if (moved.status !== "moved") fail("the move to the cloud asked first");
  const inCloud = await agents.get(session.id);
  const host = context.hosts.get(inCloud.hostId!) as RemoteSessionHost;
  return { session: inCloud, host };
}

try {
  if (!(await cloud.account.signIn())) {
    await cloud.devLogin(GATEWAY, EMAIL);
    say(`signed in to ${GATEWAY} as ${EMAIL}`);
  }
  await cloud.hold();
  const name = `lifecycle-${mode === "cleanup" ? "archive" : mode}`;

  if (mode === "cleanup") {
    for (const workspace of await context.workspaces.list({
      includeArchived: true,
    })) {
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
    name: `${name}-${Date.now().toString(36)}`,
  });
  const word = `OSPREY${Math.floor(Math.random() * 9000 + 1000)}`;

  if (mode === "archive") {
    // A repository attached to the workspace.
    const source = join(HOME, "source-app");
    if (!existsSync(source)) {
      await mkdir(source, { recursive: true });
      await git(source, "init", "-q", "-b", "main");
      await writeFile(join(source, "README.md"), "lifecycle try\n");
      await git(source, "add", "-A");
      await git(source, "commit", "-q", "-m", "start");
    }
    await context.workspaceContent.addAndAttachRepository({
      workspace: workspace.id,
      remoteUrl: source,
      name: "app",
    });

    const { session, host } = await conversationInPod(workspace.id, word);
    const cloudId = repositories.cloudWorkspaceId(workspace.id)!;

    // Made a session born in the cloud: its conversation where one started
    // in the pod root keeps it, the way back forgotten, resumed there.
    const podFolder = podWorkingDirectory(session.workingDirectory);
    const transcript = await host.readText(
      `.home/.claude/projects/${claudeProjectKey(podFolder)}/${session.providerSessionId}.jsonl`,
    );
    if (!transcript) fail("no conversation in the pod");
    await host.writeFiles([
      {
        path: `.home/.claude/projects/${claudeProjectKey("/workspace")}/${session.providerSessionId}.jsonl`,
        contents: new TextEncoder().encode(
          transcript!.replaceAll(podFolder, "/workspace"),
        ),
      },
    ]);
    await agents.stopForMove(session.id);
    await context.moves.forget(session.id);
    repositories.setAgentPlace(session.id, {
      hostId: session.hostId,
      workingDirectory: ".",
    });
    repositories.updateAgent({
      ...(await agents.get(session.id)),
      status: "lost",
      lostReason: CLOUD_SLEEP_REASON,
    });
    const born = await context.cloudSessions.wake(session.id);
    check(
      born.status === "running" && born.workingDirectory === ".",
      "a cloud session in the pod root, as one born there",
    );

    // The pod's own clone of the attached repository, from a bundle.
    const sourceBundle = join(HOME, "source.bundle");
    await git(source, "bundle", "create", "-q", sourceBundle, "--all");
    await host.writeFiles([
      {
        path: ".source.bundle",
        contents: new Uint8Array(await readFile(sourceBundle)),
      },
    ]);

    // Its work in the pod root: a clone of the attached repository with a
    // commit of its own on a branch, a repository of its own, a loose file.
    const branch = `born-${word.toLowerCase()}`;
    const inPod = async (script: string) => {
      const result = await host.run({
        cwd: ".",
        executable: "bash",
        args: ["-c", script],
      });
      if (result.exitCode !== 0) fail(`in the pod: ${result.stderr}`);
    };
    await inPod(
      [
        `git clone -q .source.bundle app && rm .source.bundle`,
        `cd app && git checkout -q -b ${branch}`,
        `echo "${word}" > cloud.txt && git add cloud.txt`,
        `git -c user.name=pod -c user.email=pod@test commit -q -m "born in the cloud"`,
        `echo untracked > untracked.txt`,
        `cd .. && mkdir -p notes && cd notes && git init -q -b main && echo n > n.md && git add -A && git -c user.name=pod -c user.email=pod@test commit -q -m notes`,
        `cd .. && echo stays > loose.txt`,
      ].join(" && "),
    );

    // Archive, as the window asks for it.
    let started = Date.now();
    const archived = await rpc.agentArchive({ id: session.id });
    if (!archived.ok) fail(`archive: ${archived.error.message}`);
    if (archived.ok && archived.data.status !== "archived")
      fail(`archive asked first: ${JSON.stringify(archived.data)}`);
    check(
      archived.ok &&
        archived.data.status === "archived" &&
        Boolean(archived.data.notice?.includes("Came home: app, notes.")),
      "the archive says what came home",
    );
    say(`archived home in ${Math.round((Date.now() - started) / 1000)} s`);
    const home = await agents.get(session.id);
    check(
      Boolean(home.archivedAt) && home.hostId === null,
      "archived as a session of this Mac",
    );
    const macApp = join(home.workingDirectory, "app");
    check(
      (await git(macApp, "branch", "--show-current")) === branch,
      "the attached repository is a session worktree on the pod's branch",
    );
    check(
      (await git(macApp, "log", "-1", "--format=%s")) === "born in the cloud",
      "with the pod's commit",
    );
    check(existsSync(join(macApp, "untracked.txt")), "and its untracked file");
    check(
      (await git(
        join(home.workingDirectory, "notes"),
        "log",
        "-1",
        "--format=%s",
      )) === "notes",
      "the pod's own repository is a folder of the session",
    );
    check(
      !existsSync(join(home.workingDirectory, "loose.txt")),
      "the loose file stayed in the cloud",
    );
    const macTranscript = await readFile(
      join(
        agents.claudeProjectsDirectory(home),
        claudeProjectKey(home.workingDirectory),
        `${session.providerSessionId}.jsonl`,
      ),
      "utf8",
    );
    check(macTranscript.includes(word), `the conversation is home (${word})`);
    check(
      !macTranscript.includes('"cwd":"/workspace'),
      "its folders are this Mac's",
    );

    // Archiving the workspace asks about what never came home, then
    // deletes its cloud copy.
    started = Date.now();
    const asked = await rpc.workspaceArchive({ reference: workspace.id });
    if (!asked.ok) fail(`workspace archive: ${asked.error.message}`);
    check(
      asked.ok &&
        asked.data.status === "needsCloudDecision" &&
        asked.data.lost.some((line) => line.includes("loose.txt")),
      "the loose file left in the pod is asked about",
    );
    const gone = await rpc.workspaceArchive({
      reference: workspace.id,
      cloudCopy: "delete",
    });
    if (!gone.ok) fail(`workspace archive: ${gone.error.message}`);
    check(
      gone.ok && gone.data.status === "archived",
      `the workspace is archived (${Math.round((Date.now() - started) / 1000)} s)`,
    );
    check(
      !(await cloud.list()).some((item) => item.workspaceId === cloudId),
      "the gateway no longer has its cloud workspace",
    );
    check(
      repositories.cloudWorkspaceId(workspace.id) === undefined,
      "this Mac no longer links it",
    );
    for (let waited = 0; waited < 60_000; waited += 2_000) {
      const left = await runCommand("kubectl", [
        "--context",
        "kind-daedalus",
        "get",
        "pods,pvc,secrets",
        "-A",
        "-o",
        "name",
      ]);
      if (!left.stdout.includes(cloudId)) break;
      await Bun.sleep(2_000);
    }
    const left = await runCommand("kubectl", [
      "--context",
      "kind-daedalus",
      "get",
      "pods,pvc,secrets",
      "-A",
      "-o",
      "name",
    ]);
    check(
      !left.stdout.includes(cloudId),
      "its pod, volumes and token are gone",
    );
    say(
      "PASS: archive brought the cloud-born session home and removed the cloud copy",
    );
    process.exit(0);
  }

  // sleep
  const { session, host } = await conversationInPod(workspace.id, word);
  const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
  check(
    session.hostId === cloudHostId(cloudId) &&
      (await host.isLive(session.tmuxSession)),
    "Claude waits at its prompt in the pod",
  );
  const started = Date.now();
  let status = "running";
  while (Date.now() - started < 20 * 60_000) {
    status = (await cloud.get(cloudId)).status;
    if (status === "sleeping") break;
    await Bun.sleep(15_000);
  }
  const minutes = (Date.now() - started) / 60_000;
  check(
    status === "sleeping",
    `the pod slept by itself after ${minutes.toFixed(1)} min`,
  );
  check(minutes >= 14, "not before its 15 idle minutes");
  const asleep = await agents.get(session.id);
  check(
    asleep.status === "lost" && asleep.lostReason === CLOUD_SLEEP_REASON,
    "the Mac read its session as asleep at once",
  );

  const woken = await rpc.agentSend({
    id: session.id,
    text: `The word was ${word}`,
  });
  if (!woken.ok) fail(`send: ${woken.error.message}`);
  const back = await agents.get(session.id);
  check(back.status === "running", "a message woke the pod and resumed it");
  check(back.args.includes("--resume"), "with its conversation");
  let screen = "";
  for (let waited = 0; waited < 30_000; waited += 1_000) {
    screen = await host.capture(back.tmuxSession);
    if (screen.includes(`The word was ${word}`)) break;
    await Bun.sleep(1_000);
  }
  check(screen.includes(`The word was ${word}`), "and the message reached it");
  await agents.stop(session.id, true).catch(() => undefined);
  await cloud.delete(workspace.id);
  say("PASS: slept after 15 idle minutes; a message woke and resumed it");
  process.exit(0);
} catch (error) {
  const details = (error as { details?: unknown }).details;
  fail(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${details ? `\n${JSON.stringify(details)}` : ""}`,
  );
}
