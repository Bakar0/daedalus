/**
 * Waking a sleeping cloud workspace for one of its sessions, end to end on
 * the kind cluster, with this Mac's real code: a Claude conversation moves to
 * its workspace's pod, and after each sleep Claude must come back with its
 * history: opened while asleep, woken from the workspace menu, and opened
 * after a wake that resumed nothing. Claude in the pod must also run with
 * DISABLE_AUTOUPDATER=1. The run deletes its cloud workspace at the end.
 *
 *   bun run scripts/cloud-wake-try.ts run       # sleep, wake, resume, three ways
 *   bun run scripts/cloud-wake-try.ts cleanup   # deletes the pod, its volume and the sessions
 *
 * It runs from a home of its own (~/.daedalus-wake-try-dev, file vault), as
 * user wake-try@test.com on the gateway at http://localhost:8080, and holds
 * the link itself, standing in for the app. The conversation starts on this
 * Mac, with the user's own Claude sign-in, so the pod has history to resume.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  cloudHostId,
  createApplicationContext,
  RemoteSessionHost,
} from "@daedalus/core";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-wake-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "wake-try@test.com";
const WORKSPACE = "wake-try";

const mode = process.argv[2];
if (mode !== "run" && mode !== "cleanup") {
  console.error("Usage: cloud-wake-try.ts run|cleanup");
  process.exit(2);
}

const say = (text: string) => console.log(`[wake-try] ${text}`);
const fail = (text: string): never => {
  console.log(`FAIL: ${text}`);
  process.exit(1);
};
const check = (ok: boolean, text: string) =>
  ok ? say(`ok: ${text}`) : fail(text);

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

  // A conversation with something to remember, moved to the pod.
  const word = `HERON${Math.floor(Math.random() * 9000 + 1000)}`;
  const session = await agents.spawn({
    workspace: workspace.id,
    provider: "claude",
    name: "wake try",
    message: `Remember this word for later: ${word}. Reply with just OK and do nothing else.`,
  });
  await waitIdle(session.id, "first turn");
  const moved = await context.moves.move({
    sessionId: session.id,
    to: "cloud",
  });
  if (moved.status !== "moved")
    fail("the move to the cloud asked for approval");
  const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
  const inCloud = await agents.get(session.id);
  check(inCloud.hostId === cloudHostId(cloudId), "the session is in the pod");
  const host = context.hosts.get(inCloud.hostId!) as RemoteSessionHost;
  check(await host.isLive(inCloud.tmuxSession), "Claude runs in the pod");

  // The app's handlers, with the window's snapshot poll beside them.
  const rpc = createDesktopRequestHandlers(context);
  let polling = true;
  const poll = (async () => {
    while (polling) {
      const snap = await rpc.snapshot({});
      if (!snap.ok) say(`snapshot failed: ${snap.error.message}`);
      await rpc.cloudState({});
      await Bun.sleep(1_000);
    }
  })();

  const sleep = async () => {
    // What the workspace menu's Sleep does.
    const slept = await rpc.cloudWorkspaceSleep({ workspace: workspace.id });
    if (!slept.ok) fail(`sleep: ${slept.error.message}`);
    check(
      (await agents.get(session.id)).status === "lost",
      "sleeping leaves the session lost",
    );
    check(
      (await cloud.get(cloudId)).status === "sleeping",
      "the workspace is asleep",
    );
  };
  const resumed = async (how: string) => {
    const revived = await agents.get(session.id);
    check(revived.status === "running", `${how}: the session runs again`);
    check(revived.args.includes("--resume"), `${how}: Claude resumed`);
    check(await host.isLive(revived.tmuxSession), `${how}: Claude runs`);
    let screen = "";
    for (let waited = 0; waited < 30_000; waited += 1_000) {
      screen = await host.capture(revived.tmuxSession);
      if (screen.includes(word)) break;
      await Bun.sleep(1_000);
    }
    check(screen.includes(word), `${how}: Claude shows its history (${word})`);
  };
  const open = async () => {
    const opened = await rpc.cloudSessionWake({ sessionId: session.id });
    if (!opened.ok) fail(`open: ${opened.error.message}`);
  };
  const timed = async (how: string, run: () => Promise<void>) => {
    const started = Date.now();
    await run();
    say(`${how} in ${Math.round((Date.now() - started) / 1000)} s`);
    await resumed(how);
  };

  // Claude's version is the image's: it must not try to update itself.
  const claudeEnv = await host.run({
    cwd: ".",
    executable: "bash",
    // The image has no pgrep.
    args: [
      "-c",
      "for p in /proc/[0-9]*; do [ \"$(cat $p/comm)\" = claude ] && tr '\\0' '\\n' < $p/environ; done",
    ],
  });
  check(
    claudeEnv.stdout.split("\n").includes("DISABLE_AUTOUPDATER=1"),
    "Claude in the pod runs with DISABLE_AUTOUPDATER=1",
  );

  // Opening the session while its workspace sleeps.
  await sleep();
  await timed("opened while asleep", open);

  // Wake in the workspace menu.
  await sleep();
  await timed("woken from the menu", async () => {
    const woken = await rpc.cloudWorkspaceWake({ workspace: workspace.id });
    if (!woken.ok) fail(`wake: ${woken.error.message}`);
  });

  // Woken by something that resumes nothing (the CLI), then opened: the
  // user's case, where the session stayed lost.
  await sleep();
  await cloud.wake(workspace.id);
  check(
    (await agents.get(session.id)).status === "lost",
    "a plain wake leaves the session lost",
  );
  await timed("opened after a plain wake", open);
  polling = false;
  await poll;
  say("PASS: slept, opened, and Claude resumed with its history");
  await agents.stop(session.id, true).catch(() => undefined);
  // The next run starts from a new pod and volume.
  await cloud.delete(workspace.id);
  process.exit(0);
} catch (error) {
  const details = (error as { details?: unknown }).details;
  fail(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}${details ? `\n${JSON.stringify(details)}` : ""}`,
  );
}
