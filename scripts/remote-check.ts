// Remote access (#53), end to end: a scripted phone signs in, pairs with a
// Mac and drives a real Daedalus session through the relay running locally
// on Cloudflare's runtime (workerd, via `wrangler dev`, with a local D1). A
// small server stands in for Google's sign-in endpoints. Covers the access
// lock (invites, entitlements, device revocation) and prints what crossed the
// relay per minute, so the cost per user is measured rather than guessed.
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "@daedalus/core";
import { CommandTmuxClient, runCommand } from "@daedalus/platform";
import type { DesktopSnapshotDto, RpcResult } from "@daedalus/protocol";
import {
  createIdentity,
  decodePairingOffer,
  encodePairingOffer,
  type PairedMac,
  PhoneConnection,
  pairWithMac,
  RELAY_CLOSE,
  RelayAccount,
  RelayError,
  sodiumReady,
  type WireStats,
} from "@daedalus/remote-protocol";
import {
  agentTerminalOpener,
  RemoteConnector,
  type RemoteStatus,
  RemoteStore,
} from "../apps/desktop/src/bun/remote";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

const root = join(import.meta.dir, "..");
const relayDir = join(root, "apps/relay");
const wrangler = join(relayDir, "node_modules/.bin/wrangler");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await mkdtemp(join(tmpdir(), "daedalus-remote-"));
const relayState = await mkdtemp(join(tmpdir(), "daedalus-relay-"));
const socket = `daedalus-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;
const port = 18_700 + Math.floor(Math.random() * 1_000);
const relayUrl = `ws://127.0.0.1:${port}`;
const relayHttp = `http://127.0.0.1:${port}`;
const env = { ...process.env, DAEDALUS_HOME: home };
const APP = "http://app.test";
const ADMIN_KEY = "admin-test-key";
const CLIENT_ID = "test-client.apps.googleusercontent.com";

const pass = (message: string) => console.log(`PASS ${message}`);

async function until(
  label: string,
  condition: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await sleep(50);
  }
}

async function expectRefusal(
  label: string,
  attempt: Promise<unknown>,
  code: number,
): Promise<void> {
  const outcome = await attempt.then(
    () => "accepted",
    (error: unknown) =>
      error instanceof RelayError ? error.code : String(error),
  );
  if (outcome !== String(code))
    throw new Error(`${label}: expected close ${code}, got ${outcome}`);
}

async function cli(args: string[]): Promise<unknown> {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      join(root, "apps/cli/src/index.ts"),
      ...args,
      "--json",
    ],
    { cwd: root, env, stdout: "pipe", stderr: "pipe" },
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

// Google, as far as the relay talks to it: the token endpoint turns a code
// into an ID token. The code here is just the email to sign in as.
const google = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const form = new URLSearchParams(await request.text());
    if (
      form.get("client_secret") !== "test-secret" ||
      !form.get("code_verifier")
    )
      return new Response("bad client", { status: 400 });
    const email = form.get("code") ?? "";
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const idToken = [
      encode({ alg: "none" }),
      encode({
        iss: "https://accounts.google.com",
        aud: CLIENT_ID,
        sub: `sub-${email}`,
        email,
        email_verified: true,
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      "",
    ].join(".");
    return Response.json({ id_token: idToken });
  },
});

/** Runs the browser's part of a Google sign-in; returns the URL fragment. */
async function signIn(
  email: string,
  invite?: string,
): Promise<URLSearchParams> {
  const start = new URL("/auth/google/start", relayHttp);
  start.searchParams.set("return", `${APP}/signed-in`);
  if (invite) start.searchParams.set("invite", invite);
  const toGoogle = await fetch(start, { redirect: "manual" });
  const state = new URL(
    toGoogle.headers.get("Location") ?? "",
  ).searchParams.get("state");
  const callback = new URL("/auth/google/callback", relayHttp);
  callback.searchParams.set("state", state ?? "");
  callback.searchParams.set("code", email);
  const back = await fetch(callback, { redirect: "manual" });
  const location = new URL(back.headers.get("Location") ?? "");
  if (location.origin !== APP)
    throw new Error(`Sign-in returned to ${location.origin}`);
  return new URLSearchParams(location.hash.slice(1));
}

async function adminCall(method: string, path: string, body?: unknown) {
  const response = await fetch(new URL(path, relayHttp), {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await response.json()) as { ok: boolean; data: unknown };
}

const newInvite = async () =>
  ((await adminCall("POST", "/admin/invites", {})).data as { code: string })
    .code;

const migrate = Bun.spawnSync(
  [
    wrangler,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    relayState,
  ],
  {
    cwd: relayDir,
    env: { ...process.env, CI: "1" },
    stdout: "pipe",
    stderr: "pipe",
  },
);
if (migrate.exitCode !== 0)
  throw new Error(`D1 migrations failed: ${migrate.stderr.toString()}`);

const vars = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "test-secret",
  GOOGLE_AUTH_URL: `http://127.0.0.1:${google.port}/auth`,
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.port}/token`,
  ADMIN_KEY,
  APP_ORIGINS: APP,
};
const relay = Bun.spawn(
  [
    wrangler,
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    relayState,
    "--log-level",
    "warn",
    ...Object.entries(vars).flatMap(([name, value]) => [
      "--var",
      `${name}:${value}`,
    ]),
  ],
  {
    cwd: relayDir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  },
);

const markers = ["REMOTE_TERMINAL_MARKER", "REMOTE_SEND_MARKER"];
const rawFrames: Uint8Array[] = [];
const tap = (_direction: "in" | "out", frame: Uint8Array) => {
  if (rawFrames.length < 50_000) rawFrames.push(frame.slice());
};

let connector: RemoteConnector | undefined;
let connection: PhoneConnection | undefined;
try {
  await sodiumReady();
  const deadline = Date.now() + 60_000;
  while (
    !(await fetch(`${relayHttp}/health`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (Date.now() > deadline) throw new Error("The local relay did not start");
    await sleep(250);
  }
  pass(`local relay on Cloudflare's runtime with D1 at ${relayUrl}`);

  // The access lock.
  const noKey = await fetch(`${relayHttp}/admin/users`);
  if (noKey.status !== 401)
    throw new Error("Admin routes answered without a key");
  pass("admin routes need the admin key");

  if ((await signIn("stranger@example.com")).get("error") !== "invite_required")
    throw new Error("A new account was made without an invite");
  if (
    (await signIn("stranger@example.com", "WRONG-CODE")).get("error") !==
    "invite_invalid"
  )
    throw new Error("A wrong invite was accepted");
  const users = (await adminCall("GET", "/admin/users")).data as unknown[];
  if (users.length !== 0) throw new Error("A refused sign-up left an account");
  pass("sign-up without a valid invite is refused and stores nothing");

  const invite = await newInvite();
  const aliceToken = (await signIn("alice@example.com", invite)).get("token");
  if (!aliceToken) throw new Error("Alice could not sign up with an invite");
  const alice = new RelayAccount(relayUrl, aliceToken);
  const me = await alice.me();
  if (me.entitlement?.plan !== "beta")
    throw new Error("No entitlement after invite");
  if (
    (await signIn("bob@example.com", invite)).get("error") !== "invite_invalid"
  )
    throw new Error("A one-use invite worked twice");
  const bobToken = (await signIn("bob@example.com", await newInvite())).get(
    "token",
  );
  if (!bobToken) throw new Error("Bob could not sign up");
  const returning = (await signIn("alice@example.com")).get("token");
  if (!returning)
    throw new Error("An existing account could not sign in again");
  pass(
    "Google sign-in with an invite grants the beta plan; invites are one-use",
  );

  // The Mac.
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const workspace = (await cli(["workspace", "create", "Remote"])) as {
    id: string;
  };
  const agent = (await cli([
    "agent",
    "spawn",
    "--workspace",
    workspace.id,
    "--command",
    "shell",
  ])) as { id: string; status: string };
  if (agent.status !== "running") throw new Error("Agent did not start");

  const context = await createApplicationContext({ env });
  if (!(context.tmux instanceof CommandTmuxClient))
    throw new Error("Expected the command tmux client");
  const store = await RemoteStore.open(home);
  const statuses: RemoteStatus[] = [];
  connector = new RemoteConnector({
    relay: relayUrl,
    macName: "Check Mac",
    store,
    handlers: createDesktopRequestHandlers(context) as unknown as Record<
      string,
      (params: never) => unknown
    >,
    openTerminal: agentTerminalOpener(context, context.tmux),
    tap,
    lockedRetryMs: 1_000,
  });
  connector.onStatus((status) => statuses.push(status));
  await connector.start();
  if (connector.status !== "waiting_for_phone")
    throw new Error(`Unclaimed Mac status: ${connector.status}`);
  pass("an unclaimed Mac connects out and waits for a phone");

  // Pairing claims the Mac for Alice's account.
  const phone = createIdentity();
  const code = encodePairingOffer(connector.createPairingOffer());
  const offer = decodePairingOffer(code);
  const mac: PairedMac = await pairWithMac(
    phone,
    offer,
    "Alice's phone",
    aliceToken,
  );
  if (!store.relayToken || connector.status !== "online")
    throw new Error(`Mac not claimed: ${connector.status}`);
  if (mac.macName !== "Check Mac") throw new Error("Mac name not passed on");
  pass(
    `paired by code (${code.length} characters for the QR); the Mac rejoined as Alice's`,
  );

  await expectRefusal(
    "Bob's phone on Alice's Mac",
    PhoneConnection.connect(createIdentity(), mac, bobToken),
    RELAY_CLOSE.forbidden,
  );
  const bobClaim = await new RelayAccount(relayUrl, bobToken)
    .claimMac(mac.macId, "x")
    .then(
      () => "claimed",
      (error: RelayError) => error.code,
    );
  if (bobClaim !== "CLAIMED")
    throw new Error(`Bob claimed Alice's Mac: ${bobClaim}`);
  await expectRefusal(
    "a phone with no session",
    PhoneConnection.connect(createIdentity(), mac, "not-a-token"),
    RELAY_CLOSE.unauthorized,
  );
  const reuse = await pairWithMac(
    createIdentity(),
    offer,
    "Second phone",
    aliceToken,
  ).then(
    () => "accepted",
    (error: Error) => error.message,
  );
  if (reuse === "accepted") throw new Error("A pairing code worked twice");
  pass("other accounts, signed-out phones and reused codes are refused");

  connection = await PhoneConnection.connect(phone, mac, aliceToken, { tap });
  const phoneConnection = connection;
  pass("encrypted handshake through the relay");

  const snapshot = (await phoneConnection.request(
    "snapshot",
  )) as RpcResult<DesktopSnapshotDto>;
  if (!snapshot.ok || !snapshot.data.agents.some((a) => a.id === agent.id))
    throw new Error(
      `Snapshot failed: ${JSON.stringify(snapshot).slice(0, 300)}`,
    );
  pass(
    `snapshot over the channel (${JSON.stringify(snapshot).length} bytes of JSON)`,
  );

  const forbidden = (await phoneConnection.request("workspaceDelete", {
    reference: workspace.id,
  })) as RpcResult<unknown>;
  if (forbidden.ok) throw new Error("A phone deleted a workspace");
  pass("requests outside the allowlist are refused");

  let changed = 0;
  phoneConnection.onDataChanged(() => {
    changed += 1;
  });
  connector.announce();
  await until("dataChanged", () => changed > 0);
  pass("data-changed events reach the phone");

  const decoder = new TextDecoder();
  let screen = "";
  const terminal = phoneConnection.openTerminal(
    agent.id,
    { cols: 80, rows: 24 },
    (data) => {
      screen += decoder.decode(data, { stream: true });
      if (screen.length > 2_000_000) screen = screen.slice(-1_000_000);
    },
  );
  await sleep(500);
  terminal.write(`printf '%s\\n' ${markers[0]}\r`);
  await until("terminal marker", () => screen.includes(markers[0]!));
  pass("live terminal: phone typing reaches tmux, output comes back");

  const sent = (await phoneConnection.request("agentSend", {
    id: agent.id,
    text: `printf '%s\\n' ${markers[1]}`,
  })) as RpcResult<unknown>;
  if (!sent.ok) throw new Error(`agentSend failed: ${JSON.stringify(sent)}`);
  await until("agentSend marker", () => screen.includes(markers[1]!));
  pass("agentSend from the phone");

  terminal.write(
    "i=0; while [ $i -lt 5000 ]; do printf 'NOISE-%04d-abcdefghijklmnopqrstuvwxyz\\n' $i; i=$((i+1)); done; printf 'NOISE_DONE\\n'\r",
  );
  await until("burst output", () => screen.includes("NOISE_DONE"), 20_000);
  pass("5,000-line burst arrives intact");

  const measure = async (seconds: number, start?: () => void) => {
    const before = {
      mac: { ...connector!.stats },
      phone: { ...phoneConnection.stats },
    };
    start?.();
    await sleep(seconds * 1_000);
    const sentBy = (now: WireStats, then: WireStats) => ({
      frames: now.framesOut - then.framesOut,
      bytes: now.bytesOut - then.bytesOut,
    });
    const macSent = sentBy(connector!.stats, before.mac);
    const phoneSent = sentBy(phoneConnection.stats, before.phone);
    const perMinute = 60 / seconds;
    return {
      frames: (macSent.frames + phoneSent.frames) * perMinute,
      bytes: (macSent.bytes + phoneSent.bytes) * perMinute,
    };
  };
  const idle = await measure(10);
  const working = await measure(20, () =>
    terminal.write(
      "i=0; while [ $i -lt 400 ]; do printf 'step %03d: reading files, running tests, writing a patch to the module\\n' $i; sleep 0.05; i=$((i+1)); done\r",
    ),
  );
  terminal.close();

  const leaked = rawFrames.some((frame) => {
    const raw = decoder.decode(frame);
    return (
      markers.some((marker) => raw.includes(marker)) || raw.includes("NOISE-")
    );
  });
  if (leaked) throw new Error("Plaintext reached the relay");
  pass(`none of ${rawFrames.length} relay frames contained plaintext`);

  // Taking access away.
  let phoneClosed = "";
  phoneConnection.onClose((reason) => {
    phoneClosed = reason;
  });
  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "revoked",
  });
  await until("revoked phone closed", () => phoneClosed !== "");
  await until("Mac locked", () => connector!.status === "locked");
  await expectRefusal(
    "a phone on a revoked account",
    PhoneConnection.connect(phone, mac, aliceToken),
    RELAY_CLOSE.noEntitlement,
  );
  pass("revoking an account closes its Mac and phones and keeps them out");

  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "active",
  });
  await until("Mac back online", () => connector!.status === "online", 15_000);
  connection = await PhoneConnection.connect(phone, mac, aliceToken);
  pass("granting access again brings the Mac and phone back");

  let removedReason = "";
  connection.onClose((reason) => {
    removedReason = reason;
  });
  await alice.removeDevice(phone.id);
  await until("removed phone closed", () => removedReason !== "");
  await expectRefusal(
    "a removed phone",
    PhoneConnection.connect(phone, mac, aliceToken),
    RELAY_CLOSE.forbidden,
  );
  pass("removing a phone from the account disconnects it for good");

  const oldMacId = connector.macId;
  await alice.removeDevice(oldMacId);
  await until(
    "Mac reset",
    () =>
      connector!.macId !== oldMacId &&
      connector!.status === "waiting_for_phone",
    15_000,
  );
  if (store.relayToken || store.phones.length !== 0)
    throw new Error("A removed Mac kept its token or phones");
  pass("removing the Mac makes it start over as a new, unpaired device");

  const requestPrice = 0.15 / 1_000_000;
  const durationPrice = 12.5 / 1_000_000;
  console.log("\nMeasured relay traffic per minute (one phone, one session):");
  for (const [label, row] of [
    ["terminal open, nothing printing", idle],
    ["agent printing ~20 lines a second", working],
  ] as const)
    console.log(
      `  ${label}: ${Math.round(row.frames)} frames, ${(row.bytes / 1024).toFixed(1)} KiB, ~${(row.frames / 20).toFixed(1)} billed requests`,
    );
  const hourRequests = (working.frames / 20) * 60;
  const hourDuration = 0.128 * 3_600;
  console.log(
    `  one hour of watching a busy session: ~$${(hourRequests * requestPrice + hourDuration * durationPrice).toFixed(4)} at list price`,
  );
  console.log(`  Mac status changes: ${statuses.join(" → ")}`);
} finally {
  connection?.close();
  connector?.stop();
  relay.kill();
  await relay.exited;
  google.stop(true);
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
  await rm(relayState, { recursive: true, force: true });
}
