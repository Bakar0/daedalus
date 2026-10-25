/**
 * A cloud workspace's idle sleep end to end on the kind cluster, with this
 * Mac's real code and the app's own RPC handlers:
 *
 *   bun run scripts/cloud-lifecycle-try.ts sleep     # the pod sleeps after 15 idle minutes; a message wakes and resumes it
 *   bun run scripts/cloud-lifecycle-try.ts cleanup   # deletes what a run left
 *
 * Archive, moves home and the fallback after collection are in
 * scripts/cloud-workspace-move-try.ts; waking a session four ways is in
 * scripts/cloud-wake-try.ts.
 *
 * It runs from a home of its own (~/.daedalus-lifecycle-try-dev, file vault),
 * as user lifecycle-try@test.com on the gateway at http://localhost:8080, and
 * holds the link itself, standing in for the app. The conversation starts on
 * this Mac with the user's own Claude sign-in, then the workspace moves to
 * the cloud.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLOUD_SLEEP_REASON,
  cloudHostId,
  createApplicationContext,
  RemoteSessionHost,
} from "@daedalus/core";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-lifecycle-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "lifecycle-try@test.com";

const mode = process.argv[2];
if (mode !== "sleep" && mode !== "cleanup") {
  console.error("Usage: cloud-lifecycle-try.ts sleep|cleanup");
  process.exit(2);
}

const say = (text: string) => console.log(`[lifecycle-try] ${text}`);
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
    name: `lifecycle-sleep-${Date.now().toString(36)}`,
  });
  const word = `OSPREY${Math.floor(Math.random() * 9000 + 1000)}`;
  const spawned = await agents.spawn({
    workspace: workspace.id,
    provider: "claude",
    name: "sleep try",
    message: `Remember this word for later: ${word}. Reply with just OK and do nothing else.`,
  });
  await waitIdle(spawned.id, "first turn");
  const moved = await rpc.workspaceMove({
    reference: workspace.id,
    to: "cloud",
  });
  if (!moved.ok) fail(`move: ${moved.error.message}`);
  if (moved.ok && moved.data.status !== "moved")
    fail(`the move to the cloud asked first: ${JSON.stringify(moved.data)}`);

  const session = await agents.get(spawned.id);
  const cloudId = repositories.cloudWorkspaceId(workspace.id)!;
  const host = context.hosts.get(session.hostId!) as RemoteSessionHost;
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
