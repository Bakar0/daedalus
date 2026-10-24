/**
 * Codex in a cloud workspace, end to end on the kind cluster, with this
 * Mac's real code and the app's own RPC handlers
 * (artifacts/cloud-sessions/codex-spike.md):
 *
 *   bun run scripts/cloud-codex-try.ts run       # Codex to the cloud and home again
 *   bun run scripts/cloud-codex-try.ts cleanup   # deletes what a run left
 *
 * It runs from a home of its own (~/.daedalus-codex-try-dev, file vault),
 * as user codex-try@test.com on the gateway at http://localhost:8080, and
 * holds the link itself, standing in for the app. Codex on this Mac and in
 * the pod is signed in with a fake API key, so every turn fails at OpenAI
 * with 401, but Codex still writes the user's messages into its rollout:
 * that is what moves. No real sign-in is made; the ChatGPT sign-in is
 * followed up to the page the user would click.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "@daedalus/platform";
import {
  cloudHostId,
  createApplicationContext,
  RemoteSessionHost,
} from "@daedalus/core";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-codex-try-dev");
const CODEX_HOME = join(HOME, "codex");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "codex-try@test.com";
const FAKE_KEY = "sk-codex-try-not-a-key";
const POD_SESSIONS = ".home/.codex/sessions";

const mode = process.argv[2];
if (mode !== "run" && mode !== "cleanup") {
  console.error("Usage: cloud-codex-try.ts run|cleanup");
  process.exit(2);
}

const say = (text: string) => console.log(`[codex-try] ${text}`);
const fail = (text: string): never => {
  console.log(`FAIL: ${text}`);
  process.exit(1);
};
const check = (ok: boolean, text: string) =>
  ok ? say(`ok: ${text}`) : fail(text);

await mkdir(CODEX_HOME, { recursive: true });
// The pod's `daedal` hooks run this Mac's `daedal` from the home's bin.
const repo = dirname(import.meta.dir);
await mkdir(join(HOME, "bin"), { recursive: true });
await writeFile(
  join(HOME, "bin", "daedal"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "apps/cli/src/index.ts")}" "$@"\n`,
  { mode: 0o755 },
);
if (
  (
    await runCommand("codex", ["login", "--with-api-key"], {
      env: { ...process.env, CODEX_HOME, CODEX_SQLITE_HOME: CODEX_HOME },
      stdin: FAKE_KEY,
    })
  ).exitCode !== 0
)
  fail("codex login on this Mac");

const context = await createApplicationContext({
  env: {
    ...process.env,
    DAEDALUS_HOME: HOME,
    CODEX_HOME,
    CODEX_SQLITE_HOME: CODEX_HOME,
  },
  cloud: {
    log: (event, fields) =>
      event.startsWith("cloud_codex") || event === "cloud_seed_failed"
        ? say(`log ${event} ${JSON.stringify(fields)}`)
        : undefined,
  },
});
const { cloud, agents, repositories } = context;
const rpc = createDesktopRequestHandlers(context);

const until = async <T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  ms = 90_000,
): Promise<T> => {
  for (let waited = 0; waited < ms; waited += 1_000) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    await Bun.sleep(1_000);
  }
  return fail(`${what}: not within ${ms / 1000} s`);
};

// Turns that fail at OpenAI never send Codex's Stop hook, so they read as
// working: the move stops them, as the user's "Stop them and move" does.
const move = async (workspaceId: string, to: "cloud" | "mac") => {
  const started = Date.now();
  const answer = await rpc.workspaceMove({
    reference: workspaceId,
    to,
    stopWorking: true,
  });
  if (!answer.ok) return fail(`move to ${to}: ${answer.error.message}`);
  if (answer.data.status !== "moved")
    return fail(`move to ${to}: ${JSON.stringify(answer.data)}`);
  say(`moved to ${to} in ${Math.round((Date.now() - started) / 1000)} s`);
  if (answer.data.notice) fail(`notice: ${answer.data.notice}`);
};

/** The pod's rollout of a thread, by `find`, as the move finds it. */
const podRollout = async (host: RemoteSessionHost, thread: string) => {
  const found = await host.run({
    cwd: ".",
    executable: "find",
    args: [POD_SESSIONS, "-name", `rollout-*-${thread}.jsonl`],
  });
  return found.stdout.trim().split("\n").filter(Boolean)[0];
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
    name: `codex-${Date.now().toString(36)}`,
  });
  const word = `HERON${Math.floor(Math.random() * 9000 + 1000)}`;

  // A Codex conversation on this Mac.
  const spawned = await agents.spawn({
    workspace: workspace.id,
    provider: "codex",
    name: "codex try",
    message: `Remember ${word}.`,
  });
  // This home's own Codex asks about Daedalus's hooks once, as the user's
  // would on this Mac; then the prompt goes in and the rollout appears.
  const local = await until("Codex wrote its rollout here", async () => {
    const shown = await context.hosts.local.capture(spawned.tmuxSession);
    if (shown.includes("Hooks need review"))
      await context.hosts.local.sendKeys(spawned.tmuxSession, [
        "Down",
        "Enter",
      ]);
    const found = await agents.recoverCodexThread(await agents.get(spawned.id));
    return found.providerSessionId ? found : undefined;
  });
  const thread = local.providerSessionId!;
  say(`thread ${thread}`);
  // The id can come from Codex's writer lock, before the turn is written.
  await until("the turn is in the rollout", async () => {
    const found = await runCommand("find", [
      join(CODEX_HOME, "sessions"),
      "-name",
      `rollout-*-${thread}.jsonl`,
    ]);
    const path = found.stdout.trim().split("\n")[0];
    return path ? (await readFile(path, "utf8")).includes(word) : false;
  });

  // To the cloud.
  await move(workspace.id, "cloud");
  const hostId = cloudHostId(repositories.cloudWorkspaceId(workspace.id)!);
  const host = context.hosts.get(hostId) as RemoteSessionHost;
  const inCloud = await agents.get(spawned.id);
  check(
    inCloud.hostId === hostId && inCloud.status === "running",
    "the Codex session runs in the pod",
  );
  const rollout = await podRollout(host, thread);
  check(Boolean(rollout), `its rollout is in the pod: ${rollout}`);
  const sent = (await host.readText(rollout!))!;
  check(sent.includes(word), "with the conversation");
  check(
    !sent.includes(workspace.path) && sent.includes('"cwd":"/workspace/'),
    "its paths are the pod's",
  );
  const config = (await host.readText(".home/.codex/config.toml"))!;
  check(
    config.includes("'daedal' agent event Stop || true") &&
      !config.includes(HOME),
    "the pod's config.toml holds Daedalus's hooks and no path of this Mac",
  );

  // Signed out in the pod: Daedalus picks ChatGPT, the page waits.
  const offer = await until("the ChatGPT page is offered", async () => {
    const signIn = cloud.signIns.get(spawned.id);
    return signIn?.phase === "waiting" ? signIn : undefined;
  });
  check(
    offer.kind === "codex" && offer.host === "auth.openai.com",
    `the sign-in waits for the click on ${offer.host}`,
  );
  cloud.signIns.dismiss({ sessionId: spawned.id });

  // Signed in (with the fake key) and started again: it resumes.
  const login = await host.run({
    cwd: ".",
    executable: "bash",
    args: ["-c", `printf %s '${FAKE_KEY}' | codex login --with-api-key`],
  });
  check(login.exitCode === 0, "Codex in the pod signed in with an API key");
  await agents.resumeAfterMove(await agents.stopForMove(spawned.id));
  const resumed = await agents.get(spawned.id);
  const screen = await until(
    "Codex in the pod shows the conversation",
    async () => {
      const shown = await host.capture(resumed.tmuxSession);
      return shown.includes(word) && shown.includes("Ask Codex")
        ? shown
        : undefined;
    },
  );
  check(
    !/Hooks need review|Trust this folder/.test(screen),
    "no hook review or folder question is left on screen",
  );
  check(
    (await host.readText(".home/.codex/config.toml"))!.includes("trusted_hash"),
    "Daedalus trusted its own hooks, and Codex recorded it",
  );

  // A turn in the pod, added to the rollout.
  const word2 = `${word}-POD`;
  await agents.send(spawned.id, `And ${word2}.`);
  await until("the pod's turn reached the rollout", async () =>
    (await host.readText(rollout!))?.includes(word2),
  );
  check(
    (await host.readText(rollout!))!.startsWith(sent),
    "Codex only added to what this Mac sent",
  );

  // A Codex session born in the cloud; its first hook names its thread.
  const born = await rpc.agentSpawn({
    workspace: workspace.id,
    provider: "codex",
    name: "born in the cloud",
    message: "BORN",
  });
  if (!born.ok) fail(`spawn in the cloud: ${born.error.message}`);
  const bornThread = born.ok
    ? await until(
        "the born session's hook named its thread",
        async () =>
          (await agents.get(born.data.id)).providerSessionId ?? undefined,
      )
    : "";
  check(
    Boolean(await podRollout(host, bornThread)),
    "the born session has a rollout in the pod",
  );

  // Home.
  await move(workspace.id, "mac");
  const home = await agents.get(spawned.id);
  check(
    home.hostId === null && home.status === "running",
    "the session runs on this Mac again",
  );
  const macFiles = (
    await runCommand("find", [
      join(CODEX_HOME, "sessions"),
      "-name",
      `rollout-*-${thread}.jsonl`,
    ])
  ).stdout
    .trim()
    .split("\n");
  const macText = await readFile(macFiles[0]!, "utf8");
  check(macText.includes(word2), "the pod's turn came home");
  check(!macText.includes('"cwd":"/workspace/'), "its paths are this Mac's");
  await until("Codex on this Mac shows both turns", async () => {
    const shown = await context.hosts.local.capture(home.tmuxSession);
    if (shown.includes("Hooks need review"))
      await context.hosts.local.sendKeys(home.tmuxSession, ["Down", "Enter"]);
    return shown.includes(word) && shown.includes(word2);
  });
  say("ok: Codex on this Mac resumed with both turns");
  const bornHome = await agents.get(born.ok ? born.data.id : "");
  check(
    bornHome.hostId === null &&
      (
        await runCommand("find", [
          join(CODEX_HOME, "sessions"),
          "-name",
          `rollout-*-${bornThread}.jsonl`,
        ])
      ).stdout.trim() !== "",
    "the born session came home with its rollout",
  );
  for (const session of repositories.listAgents({ workspaceId: workspace.id }))
    await agents.stop(session.id, true).catch(() => undefined);
  say("PASS: Codex ran in the cloud, moved there and home, and resumed");
  process.exit(0);
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
}
