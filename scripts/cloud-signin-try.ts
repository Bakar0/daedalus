/**
 * Cloud sign-in, end to end on the kind cluster, with this Mac's real code:
 * a cloud Claude session that opens signed out gets /login from the Mac,
 * asks for a sign-in page (`daedal open-url` from the pod's BROWSER), this
 * Mac offers it, and with `--open` the page opens in
 * the browser, as the app's "Open sign-in page" does.
 *
 *   bun run scripts/cloud-signin-try.ts claude            # up to the offer
 *   bun run scripts/cloud-signin-try.ts claude --open     # the user signs in
 *   bun run scripts/cloud-signin-try.ts claude --fake-callback  # a made-up code through the forward
 *   bun run scripts/cloud-signin-try.ts aws --profile playground-power-user [--region eu-west-1] [--open]
 *   bun run scripts/cloud-signin-try.ts cleanup           # deletes the pod and its volume
 *
 * It runs from a home of its own (~/.daedalus-signin-try-dev, file vault), as
 * user signin-try@test.com on the gateway at http://localhost:8080, and holds
 * the link itself, standing in for the app. It prints no token, URL or code:
 * only the page's host, and for Claude whether the callback came back.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { cloudHostId, createApplicationContext } from "@daedalus/core";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-signin-try-dev");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "signin-try@test.com";
const WORKSPACE = "signin-try";

const [mode, ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const value = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
if (mode !== "claude" && mode !== "aws" && mode !== "cleanup") {
  console.error(
    "Usage: cloud-signin-try.ts claude|aws|cleanup [--open] [--profile <p>] [--region <r>]",
  );
  process.exit(2);
}

const say = (text: string) => console.log(`[signin-try] ${text}`);
const fail = (text: string): never => {
  console.log(`FAIL: ${text}`);
  process.exit(1);
};

const context = await createApplicationContext({
  env: { ...process.env, DAEDALUS_HOME: HOME },
});
const { cloud } = context;

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
    if (context.repositories.cloudWorkspaceId(workspace.id)) {
      await cloud.delete(workspace.id);
      say("deleted the cloud workspace, its pod and its volume");
    } else say("no cloud workspace to delete");
    process.exit(0);
  }

  if (!context.repositories.cloudWorkspaceId(workspace.id)) {
    await cloud.create(workspace.id);
    say("created the cloud workspace; waiting for its pod");
  }
  const cloudId = context.repositories.cloudWorkspaceId(workspace.id)!;
  const current = await cloud.get(cloudId);
  if (current.status === "sleeping" || !current.runnerOnline)
    await cloud.wakeForSessions(cloudId);
  const host = context.hosts.get(cloudHostId(cloudId));
  for (let tries = 0; ; tries++) {
    const unavailable = await host.probe();
    if (!unavailable) break;
    if (tries > 90) fail(`the pod's runner never answered: ${unavailable}`);
    await Bun.sleep(2_000);
  }
  say("pod ready");

  let account: string | undefined;
  if (mode === "aws") {
    const profile = value("profile") ?? fail("--profile is required for aws");
    const region = value("region") ?? "eu-west-1";
    const name = `Bedrock ${profile}`;
    const existing = context.accounts
      .list()
      .find((item) => item.provider === "claude" && item.name === name);
    account = existing
      ? existing.account
      : (
          await context.accounts.add("claude", name, "bedrock", undefined, {
            profile,
            region,
          })
        ).id;
    say(`Bedrock account on profile ${profile}, region ${region}`);
  }

  const before = new Set(cloud.signIns.list().map((offer) => offer.requestId));
  const session = await context.agents.spawn({
    workspace: workspace.id,
    host: host.id,
    name: `sign-in try (${mode})`,
    ...(account ? { account } : {}),
  });
  say(`cloud Claude session ${session.id.slice(0, 8)} is running`);
  // A Claude that opens signed out gets /login from the Mac by itself
  // (CloudService.autoSignIn); a signed-in one asks for no page.
  // Bedrock: Claude's first AWS call fails without an SSO sign-in and runs
  // awsAuthRefresh, whose device code page goes to BROWSER.

  let offer = undefined as
    ReturnType<typeof cloud.signIns.list>[number] | undefined;
  for (let waited = 0; waited < 120_000 && !offer; waited += 1_000) {
    offer = cloud.signIns
      .list()
      .find(
        (item) =>
          item.sessionId === session.id &&
          item.phase === "waiting" &&
          !before.has(item.requestId),
      );
    if (!offer) await Bun.sleep(1_000);
  }
  if (!offer) {
    const screen = await host.capture(session.tmuxSession).catch(() => "");
    console.log(screen.split("\n").slice(-15).join("\n"));
    fail("the session never offered a sign-in page");
  }
  say(
    `PASS: offered ${offer.kind === "aws" ? "an AWS" : "a Claude"} sign-in page on ${offer.host}`,
  );

  if (flag("fake-callback") && offer.kind === "claude") {
    // The browser's part, with a made-up code: proves the Mac's listener
    // takes the request over the link to Claude's listener in the pod,
    // which then refuses the code. Nothing real is signed in.
    const page = await cloud.openSignIn(offer.requestId!);
    if (page.paste) fail("this Mac could not take the callback's port");
    const opened = new URL(page.url);
    const redirect = new URL(opened.searchParams.get("redirect_uri")!);
    const state = opened.searchParams.get("state")!;
    const reply = await fetch(
      `http://127.0.0.1:${redirect.port}${redirect.pathname}?code=not-a-real-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    say(`the Mac's listener answered ${reply.status}`);
    for (let waited = 0; waited < 30_000; waited += 1_000) {
      const screen = await host.capture(session.tmuxSession).catch(() => "");
      if (/OAuth error|Invalid|failed|error/i.test(screen)) {
        say(
          "PASS: the callback reached Claude in the pod, which refused the made-up code",
        );
        process.exit(0);
      }
      await Bun.sleep(1_000);
    }
    const screen = await host.capture(session.tmuxSession).catch(() => "");
    console.log(screen.split("\n").slice(-12).join("\n"));
    fail("Claude in the pod showed no reaction to the callback");
  }

  if (!flag("open")) {
    say("stopping before the browser step (pass --open to sign in)");
    process.exit(0);
  }
  process.stdout.write(
    `[signin-try] Press Enter to open the sign-in page on ${offer.host} in your browser… `,
  );
  for await (const _ of console) break;
  const page = await cloud.openSignIn(offer.requestId!);
  Bun.spawnSync(["/usr/bin/open", page.url]);
  say(
    page.paste
      ? "opened in paste-code form: paste the code into the session's terminal"
      : "opened; sign in and allow access in the browser",
  );

  const signedIn =
    mode === "claude"
      ? /Login successful|Logged in as/i
      : /Successfully logged into Start URL|signed in|Authentication complete/i;
  for (let waited = 0; waited < 300_000; waited += 2_000) {
    const screen = await host.capture(session.tmuxSession).catch(() => "");
    if (signedIn.test(screen)) {
      say(`PASS: the ${mode} sign-in finished in the pod`);
      process.exit(0);
    }
    await Bun.sleep(2_000);
  }
  fail("no sign-in seen in the session within five minutes");
} finally {
  cloud.close();
}
