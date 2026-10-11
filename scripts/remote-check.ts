// Remote access (#53), end to end: a scripted phone signs in, pairs with a
// Mac and drives a real Daedalus session through the relay running locally
// on Cloudflare's runtime (workerd, via `wrangler dev`, with a local D1). A
// small server stands in for Google's sign-in endpoints. Covers the access
// lock (invites, entitlements, device revocation) and prints what crossed the
// relay per minute, so the cost per user is measured rather than guessed.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "@daedalus/core";
import {
  CommandTmuxClient,
  runCommand,
  TmuxPtyBridge,
} from "@daedalus/platform";
import type { DesktopSnapshotDto, RpcResult } from "@daedalus/protocol";
import {
  claimKey,
  createIdentity,
  type DeviceIdentity,
  decodePairingOffer,
  encodePairingOffer,
  type PairedMac,
  type PairingOffer,
  PhoneConnection,
  pairingCode,
  pairWithMac,
  RELAY_CLOSE,
  RelayAccount,
  relayConnectUrl,
  relayProtocols,
  RelayError,
  sodiumReady,
  type WireStats,
} from "@daedalus/remote-protocol";
import {
  agentTerminalOpener,
  type PairingRequest,
  PhoneWindowSize,
  RemoteAudit,
  RemoteConnector,
  RemoteHost,
  macRelayCall,
  type RemoteStatus,
  RemoteStore,
} from "../apps/desktop/src/bun/remote";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

// The Mac's key goes to a file here, never to the user's Keychain.
process.env.DAEDALUS_REMOTE_VAULT = "file";
const root = join(import.meta.dir, "..");
const relayDir = join(root, "apps/relay");
const wrangler = join(relayDir, "node_modules/.bin/wrangler");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await mkdtemp(join(tmpdir(), "daedalus-remote-"));
const secondHome = await mkdtemp(join(tmpdir(), "daedalus-remote-host-"));
const thirdHome = await mkdtemp(join(tmpdir(), "daedalus-remote-signin-"));
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
// A push service: records each push, so the check sees what the relay sent.
const pushes: Array<{ path: string; authorization: string; length: number }> =
  [];
const pushService = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    pushes.push({
      path: new URL(request.url).pathname,
      authorization: request.headers.get("Authorization") ?? "",
      length: (await request.arrayBuffer()).byteLength,
    });
    return new Response(null, { status: 201 });
  },
});
const pushOrigin = `http://127.0.0.1:${pushService.port}`;
const vapid = (await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
)) as CryptoKeyPair;
const vapidPublic = Buffer.from(
  await crypto.subtle.exportKey("raw", vapid.publicKey),
).toString("base64url");

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

/**
 * Runs the browser's part of a Google sign-in; returns the URL fragment.
 * The relay's cookie goes back with the callback, as a browser sends it;
 * `withoutCookie` finishes the sign-in somewhere else instead.
 */
async function signIn(
  email: string,
  invite?: string,
  options: { device?: string; withoutCookie?: boolean } = {},
): Promise<URLSearchParams> {
  const start = new URL("/auth/google/start", relayHttp);
  start.searchParams.set("return", `${APP}/signed-in`);
  if (invite) start.searchParams.set("invite", invite);
  if (options.device) start.searchParams.set("device", options.device);
  const toGoogle = await fetch(start, { redirect: "manual" });
  const state = new URL(
    toGoogle.headers.get("Location") ?? "",
  ).searchParams.get("state");
  const cookie = (toGoogle.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const callback = new URL("/auth/google/callback", relayHttp);
  callback.searchParams.set("state", state ?? "");
  callback.searchParams.set("code", email);
  const back = await fetch(callback, {
    redirect: "manual",
    headers: options.withoutCookie ? {} : { Cookie: cookie },
  });
  if (options.withoutCookie)
    return new URLSearchParams({ status: String(back.status) });
  const location = new URL(back.headers.get("Location") ?? "");
  if (location.origin !== APP)
    throw new Error(`Sign-in returned to ${location.origin}`);
  return new URLSearchParams(location.hash.slice(1));
}

/**
 * A Mac's sign-in as the browser runs it: the address Daedalus opens, then
 * Google, then the relay's page.
 */
async function browserSignIn(
  startUrl: string,
  email: string,
): Promise<{ status: number; page: string }> {
  const toGoogle = await fetch(startUrl, { redirect: "manual" });
  if (toGoogle.status !== 302)
    return { status: toGoogle.status, page: await toGoogle.text() };
  const state = new URL(
    toGoogle.headers.get("Location") ?? "",
  ).searchParams.get("state");
  const cookie = (toGoogle.headers.get("Set-Cookie") ?? "").split(";")[0]!;
  const callback = new URL("/auth/google/callback", relayHttp);
  callback.searchParams.set("state", state ?? "");
  callback.searchParams.set("code", email);
  const back = await fetch(callback, {
    redirect: "manual",
    headers: { Cookie: cookie },
  });
  return { status: back.status, page: await back.text() };
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
  DEV_MODE: "1",
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "test-secret",
  GOOGLE_AUTH_URL: `http://127.0.0.1:${google.port}/auth`,
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.port}/token`,
  ADMIN_KEY,
  APP_ORIGINS: APP,
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_JWK: JSON.stringify(
    await crypto.subtle.exportKey("jwk", vapid.privateKey),
  ),
  VAPID_SUBJECT: "https://relay.test",
  PUSH_TEST_ENDPOINT: `${pushOrigin}/`,
  // The check signs in many accounts from one address; the relay's limit
  // of 30 a minute would refuse some.
  AUTH_LIMIT_OFF: "1",
  // Dave's Mac manages keys and plans from Settings › Account. Alice is
  // listed with someone else's Google id, so she is not an admin: the id
  // decides, the email only names the entry.
  ADMIN_ACCOUNTS:
    "dave@example.com=sub-dave@example.com, alice@example.com=sub-not-alice",
  // A room flushes usage after this many frames, so the frame limit is
  // reached within the check rather than at the next 5-minute alarm.
  FRAME_FLUSH_EVERY: "100",
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
    "--test-scheduled",
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

/** A sign-in that belongs to this phone from the start. */
async function signInPhone(email: string, phone: DeviceIdentity) {
  const token = (await signIn(email, undefined, { device: phone.id })).get(
    "token",
  );
  if (!token) throw new Error(`${email} could not sign in`);
  return token;
}

/**
 * Pairs as the app does, with the Mac's user answering: the Mac asks, and
 * the six digits it shows must be the phone's.
 */
async function pairAndAnswer(
  phone: DeviceIdentity,
  offer: PairingOffer,
  name: string,
  token: string,
  mac: {
    request(): PairingRequest | undefined;
    confirm(allow: boolean): Promise<unknown>;
  },
  allow = true,
): Promise<PairedMac> {
  let waited = false;
  const pairing = pairWithMac(phone, offer, name, token, {
    onWaiting: () => {
      waited = true;
    },
  });
  void pairing.catch(() => undefined);
  await until(
    "the Mac asks its user",
    () => mac.request() !== undefined,
    20_000,
  );
  await until("the phone hears the Mac is asking", () => waited);
  const asked = mac.request()!;
  if (asked.code !== pairingCode(offer, phone) || asked.phoneName !== name)
    throw new Error(`The Mac asked about ${JSON.stringify(asked)}`);
  await mac.confirm(allow);
  return pairing;
}

let connector: RemoteConnector | undefined;
let host: RemoteHost | undefined;
let signInHost: RemoteHost | undefined;
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

  // Anyone can sign up; without a plan the account reaches nothing.
  const strangerToken = (
    await signIn("stranger@example.com", "WRONG-CODE")
  ).get("token");
  if (!strangerToken) throw new Error("Sign-up without an invite failed");
  const stranger = new RelayAccount(relayUrl, strangerToken);
  const strangerMe = await stranger.me();
  const strangerClaim = await stranger
    .claimMac(createIdentity().id, "x", "no-code")
    .then(
      () => "claimed",
      (error: RelayError) => error.code,
    );
  if (strangerMe.entitlement !== null || strangerClaim !== "NO_ENTITLEMENT")
    throw new Error(
      `A plan without an invite: ${JSON.stringify(strangerMe.entitlement)} ${strangerClaim}`,
    );
  pass(
    "anyone can sign up with Google; a wrong invite grants nothing, and an account without a plan cannot claim a Mac",
  );

  const invite = await newInvite();
  const aliceToken = (await signIn("alice@example.com", invite)).get("token");
  if (!aliceToken) throw new Error("Alice could not sign up with an invite");
  const alice = new RelayAccount(relayUrl, aliceToken);
  const me = await alice.me();
  if (me.entitlement?.plan !== "pro" || me.entitlement.expiresAt !== null)
    throw new Error(`Not Pro with no end after invite: ${JSON.stringify(me)}`);
  const reused = (await signIn("bob@example.com", invite)).get("token");
  if (
    !reused ||
    (await new RelayAccount(relayUrl, reused).me()).entitlement !== null
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
    "Google sign-in with an invite grants the Pro plan with no end; invites are one-use",
  );

  // A trial: the invite grants Pro for a number of days.
  const trial = (
    (await adminCall("POST", "/admin/invites", { grantDays: 14 })).data as {
      code: string;
    }
  ).code;
  const carolToken = (await signIn("carol@example.com", trial)).get("token");
  if (!carolToken) throw new Error("Carol could not sign up with a trial");
  const trialEnds = (await new RelayAccount(relayUrl, carolToken).me())
    .entitlement?.expiresAt;
  const days = (Date.parse(trialEnds ?? "") - Date.now()) / 86_400_000;
  if (!(days > 13.9 && days <= 14))
    throw new Error(`Trial ends in ${days} days, not 14`);
  const granted = (
    await adminCall("POST", "/admin/entitlements", {
      email: "carol@example.com",
      days: 30,
    })
  ).data as { plan: string; expiresAt: string | null };
  const kept = (
    await adminCall("POST", "/admin/entitlements", {
      email: "carol@example.com",
      monthlyFrames: 5_000_000,
    })
  ).data as { expiresAt: string | null; monthlyFrames: number };
  const forever = (
    await adminCall("POST", "/admin/entitlements", {
      email: "carol@example.com",
      days: 0,
    })
  ).data as { expiresAt: string | null };
  if (
    granted.plan !== "pro" ||
    !granted.expiresAt ||
    kept.expiresAt !== granted.expiresAt ||
    kept.monthlyFrames !== 5_000_000 ||
    forever.expiresAt !== null
  )
    throw new Error(
      `Admin grants: ${JSON.stringify({ granted, kept, forever })}`,
    );
  pass(
    "a trial invite grants Pro for its days; an admin grant sets the end, keeps it when only limits change, and clears it with 0",
  );
  const elsewhere = await signIn("alice@example.com", undefined, {
    withoutCookie: true,
  });
  if (elsewhere.get("status") !== "400")
    throw new Error(
      `A callback without the browser's cookie signed in: ${elsewhere.get("status")}`,
    );
  pass(
    "a sign-in finishes only in the browser that started it (cookie), so a callback link cannot sign someone in",
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
  const audit = new RemoteAudit(home);
  const phoneSizes = new PhoneWindowSize(context.tmux);
  const statuses: RemoteStatus[] = [];
  connector = new RemoteConnector({
    relay: relayUrl,
    macName: "Check Mac",
    store,
    handlers: createDesktopRequestHandlers(context) as unknown as Record<
      string,
      (params: never) => unknown
    >,
    openTerminal: agentTerminalOpener(context, context.tmux, phoneSizes),
    tap,
    lockedRetryMs: 1_000,
    audit,
  });
  connector.onStatus((status) => statuses.push(status));
  await connector.start();
  if (connector.status !== "waiting_for_phone")
    throw new Error(`Unclaimed Mac status: ${connector.status}`);
  pass("an unclaimed Mac connects out and waits for a phone");

  // Someone who read the Mac's id off a QR code cannot take its place.
  const squat = (token?: string) =>
    new Promise<number>((resolve) => {
      const socket = new WebSocket(
        `${relayUrl}/v1/connect?room=${connector!.macId}&role=mac&device=${connector!.macId}`,
        token ? ["daedalus.v1", `auth.${token}`] : ["daedalus.v1"],
      );
      socket.addEventListener("close", (event) => resolve(event.code));
      setTimeout(() => resolve(0), 3_000);
    });
  const squatted = [await squat(), await squat("guessed-secret")];
  await sleep(300);
  if (
    squatted.some((code) => code !== RELAY_CLOSE.unauthorized) ||
    connector.status !== "waiting_for_phone" ||
    statuses.includes("offline")
  )
    throw new Error(`A squatter got in: ${squatted.join()} ${statuses.join()}`);
  pass(
    "an unclaimed Mac proves itself with its own secret: a second connection with only its id is refused and the Mac stays",
  );

  // Pairing claims the Mac for Alice's account.
  const phone = createIdentity();
  const macAnswers = {
    request: () => connector!.pairingRequest,
    confirm: (allow: boolean) => connector!.confirmPairing(allow),
  };
  const beforeCode = await new RelayAccount(relayUrl, bobToken)
    .claimMac(connector.macId, "x", "no-code")
    .then(
      () => "claimed",
      (error: RelayError) => error.code,
    );
  const code = encodePairingOffer(await connector.createPairingOffer());
  const offer = decodePairingOffer(code);
  const wrongKey = await new RelayAccount(relayUrl, bobToken)
    .claimMac(connector.macId, "x", "not-the-claim-key")
    .then(
      () => "claimed",
      (error: RelayError) => error.code,
    );
  if (beforeCode !== "BAD_CLAIM" || wrongKey !== "BAD_CLAIM")
    throw new Error(`Claimed without the code: ${beforeCode} ${wrongKey}`);
  pass("claiming a Mac needs the claim key from its pairing code, not its id");

  const otherRelay = await pairWithMac(phone, offer, "x", aliceToken, {
    relay: "wss://elsewhere.example",
  }).then(
    () => "paired",
    (error: Error) => error.message,
  );
  if (!otherRelay.includes("different relay"))
    throw new Error(`A code for another relay was used: ${otherRelay}`);
  pass("a code naming another relay is refused before the token is sent");

  const mac: PairedMac = await pairAndAnswer(
    phone,
    offer,
    "Alice's phone",
    aliceToken,
    macAnswers,
  );
  if (!store.relayToken || connector.status !== "online")
    throw new Error(`Mac not claimed: ${connector.status}`);
  if (mac.macName !== "Check Mac") throw new Error("Mac name not passed on");
  await until("account notice", () => store.account === "alice@example.com");
  await until("plan notice", () => store.plan?.name === "pro");
  if (store.plan?.expiresAt !== null)
    throw new Error(`Plan end: ${JSON.stringify(store.plan)}`);
  pass(
    `paired by code (${code.length} characters for the QR) after the Mac's user allowed it, with the same six digits on both screens; the Mac rejoined as Alice's and knows the account and its Pro plan`,
  );

  await expectRefusal(
    "Bob's phone on Alice's Mac",
    PhoneConnection.connect(createIdentity(), mac, bobToken),
    RELAY_CLOSE.forbidden,
  );
  const bobClaim = await new RelayAccount(relayUrl, bobToken)
    .claimMac(mac.macId, "x", "x")
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
    await signIn("alice@example.com").then((fragment) =>
      fragment.get("token")!,
    ),
  ).then(
    () => "accepted",
    (error: Error) => error.message,
  );
  if (reuse === "accepted") throw new Error("A pairing code worked twice");
  await expectRefusal(
    "another phone with Alice's phone's sign-in",
    PhoneConnection.connect(createIdentity(), mac, aliceToken),
    RELAY_CLOSE.forbidden,
  );
  pass(
    "other accounts, signed-out phones, reused codes, and a sign-in used by a second phone are refused",
  );

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
  // A real Mac's snapshot passed 1 MB; a 2 MB message gets through.
  const large = (await phoneConnection.request("snapshot", {
    pad: "x".repeat(2_000_000),
  })) as RpcResult<DesktopSnapshotDto>;
  if (!large.ok) throw new Error("A 2 MB message did not get through");
  pass(
    `snapshot over the channel (${JSON.stringify(snapshot).length} bytes of JSON), and a 2 MB message gets through`,
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

  // The Mac's own view of the session, as the desktop window attaches it.
  const agentRow = (await cli(["agent", "get", agent.id])) as {
    tmuxSession: string;
  };
  const tmuxTarget = { socketName: socket, session: agentRow.tmuxSession };
  const windowSize = async () =>
    (
      await runCommand(
        context.tmux instanceof CommandTmuxClient
          ? context.tmux.executable
          : "tmux",
        [
          "-L",
          socket,
          "display-message",
          "-p",
          "-t",
          agentRow.tmuxSession,
          "#{window_width}x#{window_height} #{window-size}",
        ],
      )
    ).stdout.trim();
  const desktopView = new TmuxPtyBridge(() => {}, tmuxTarget, {
    cols: 150,
    rows: 40,
  });
  void desktopView.start();
  await sleep(400);
  if (!(await windowSize()).startsWith("150x40"))
    throw new Error(`Desktop view not attached: ${await windowSize()}`);

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

  if ((await windowSize()) !== "80x24 manual")
    throw new Error(`Phone open, window is ${await windowSize()}`);
  terminal.resize(60, 30);
  await sleep(400);
  if ((await windowSize()) !== "60x30 manual")
    throw new Error(`Phone resized, window is ${await windowSize()}`);
  // Typing on the Mac: the app's terminal tells the size keeper, as here.
  desktopView.write("x");
  await phoneSizes.yieldToMac(agentRow.tmuxSession);
  await sleep(300);
  if (!(await windowSize()).startsWith("150x40"))
    throw new Error(
      `Typing on the Mac kept the phone's size: ${await windowSize()}`,
    );
  desktopView.write("\u007f");
  terminal.write(" ");
  await sleep(500);
  if ((await windowSize()) !== "60x30 manual")
    throw new Error(
      `Typing on the phone did not take it back: ${await windowSize()}`,
    );
  terminal.write("\u007f");
  pass(
    "the phone sets the size while it has a session open; typing on the Mac gives it back, typing on the phone takes it again",
  );

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
  await sleep(500);
  if (!(await windowSize()).startsWith("150x40"))
    throw new Error(`Phone closed, window is ${await windowSize()}`);
  desktopView.close();
  pass("when the phone leaves, the window goes back to the Mac's size");

  const leaked = rawFrames.some((frame) => {
    const raw = decoder.decode(frame);
    return (
      markers.some((marker) => raw.includes(marker)) || raw.includes("NOISE-")
    );
  });
  if (leaked) throw new Error("Plaintext reached the relay");
  pass(`none of ${rawFrames.length} relay frames contained plaintext`);

  const logged = await audit.recent(500);
  const did = (action: string) =>
    logged.find(
      (entry) => entry.action === action && entry.phone === "Alice's phone",
    );
  const closed = did("terminal.close");
  const auditText = await Bun.file(join(home, "remote", "audit.log")).text();
  if (
    !did("agentSend")?.ok ||
    did("agentSend")?.target !== agent.id ||
    !did("terminal.open") ||
    !closed?.bytesIn ||
    !closed.bytesOut ||
    did("workspaceDelete")?.ok !== false ||
    markers.some((marker) => auditText.includes(marker))
  )
    throw new Error(`Audit log: ${JSON.stringify(logged.slice(0, 8))}`);
  pass(
    `the Mac logs what the phone did (${logged.length} entries: requests with the ids they touched, refusals, terminals with byte counts) and never what it typed`,
  );

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
  if (connector!.lockedBy !== "no_plan")
    throw new Error(`Locked by ${connector!.lockedBy}, not no_plan`);
  await expectRefusal(
    "a phone on a revoked account",
    PhoneConnection.connect(phone, mac, aliceToken),
    RELAY_CLOSE.unauthorized,
  );
  const revokedToken = await signInPhone("alice@example.com", phone);
  await expectRefusal(
    "a revoked account signing in again",
    PhoneConnection.connect(phone, mac, revokedToken),
    RELAY_CLOSE.noEntitlement,
  );
  const redeemed = await new RelayAccount(relayUrl, revokedToken)
    .redeemInvite(await newInvite())
    .then(
      () => "redeemed",
      (error: RelayError) => error.code,
    );
  if (redeemed !== "INVITE_INVALID")
    throw new Error(`An invite undid the revoke: ${redeemed}`);
  pass(
    "revoking an account closes its Mac and phones, ends its sign-ins, and an invite does not undo it",
  );

  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "active",
  });
  await until("Mac back online", () => connector!.status === "online", 15_000);
  connection = await PhoneConnection.connect(phone, mac, revokedToken);
  pass("granting access again brings the Mac and phone back");

  // A plan that ends, as a trial does: the Mac locks, the phone's sign-in
  // stays, and an invite code from the Account page renews it.
  let endedReason = "";
  connection.onClose((reason) => {
    endedReason = reason;
  });
  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "expired",
  });
  await until("ended plan closes the phone", () => endedReason !== "");
  await until(
    "Mac locked for no plan",
    () => connector!.status === "locked" && connector!.lockedBy === "no_plan",
  );
  await expectRefusal(
    "a phone whose plan ended",
    PhoneConnection.connect(phone, mac, revokedToken),
    RELAY_CLOSE.noEntitlement,
  );
  const renewing = new RelayAccount(relayUrl, revokedToken);
  if ((await renewing.me()).entitlement !== null)
    throw new Error("An ended plan still shows as active");
  await renewing.redeemInvite(await newInvite());
  if ((await renewing.me()).entitlement?.plan !== "pro")
    throw new Error("An invite did not renew an ended plan");
  await until("Mac back online", () => connector!.status === "online", 15_000);
  connection = await PhoneConnection.connect(phone, mac, revokedToken);
  pass(
    "an ended plan locks the Mac (no_plan) and refuses the phone but keeps its sign-in, and an invite code renews it",
  );

  // The Mac's connection is replaced (as a network change does): the phone
  // hears it, drops its channel, and connects again with a new handshake.
  let staleReason = "";
  connection.onClose((reason) => {
    staleReason ||= reason;
  });
  const rival = new WebSocket(
    relayConnectUrl(relayUrl, connector.macId, "mac", connector.macId),
    relayProtocols(store.relayCredential),
  );
  await until("the phone hears its Mac reconnect", () => staleReason !== "");
  rival.close();
  await until("Mac online again", () => connector!.status === "online", 15_000);
  await sleep(500);
  connection = await PhoneConnection.connect(phone, mac, revokedToken);
  const fresh = (await connection.request("snapshot")) as RpcResult<unknown>;
  if (staleReason !== "Your Mac reconnected" || !fresh.ok)
    throw new Error(`After the Mac reconnected: ${staleReason}`);
  pass(
    "when the Mac reconnects, the phone drops its old channel and connects again with a new handshake",
  );

  let removedReason = "";
  connection.onClose((reason) => {
    removedReason = reason;
  });
  // From another browser, as the owner of a lost phone would.
  const owner = new RelayAccount(
    relayUrl,
    (await signIn("alice@example.com")).get("token")!,
  );
  await owner.removeDevice(phone.id);
  await until("removed phone closed", () => removedReason !== "");
  await expectRefusal(
    "a removed phone",
    PhoneConnection.connect(phone, mac, revokedToken),
    RELAY_CLOSE.unauthorized,
  );
  await expectRefusal(
    "a removed phone's sign-in on a new phone id",
    PhoneConnection.connect(createIdentity(), mac, revokedToken),
    RELAY_CLOSE.unauthorized,
  );
  const removedMe = await new RelayAccount(relayUrl, revokedToken).me().then(
    () => "answered",
    (error: RelayError) => error.code,
  );
  if (removedMe !== "UNAUTHORIZED")
    throw new Error(`A removed phone's sign-in still works: ${removedMe}`);
  // Its owner adds it back with a Google sign-in made on it after the
  // removal; the old sign-in stays dead.
  const backToken = await signInPhone("alice@example.com", phone);
  const back = await PhoneConnection.connect(phone, mac, backToken);
  const readded = (await new RelayAccount(relayUrl, backToken).me()).devices;
  back.close();
  if (!readded.some((item) => item.id === phone.id))
    throw new Error("The re-added phone is not on the account");
  // Removed again, so the account's phone limit is as the steps after
  // expect.
  await owner.removeDevice(phone.id);
  pass(
    "removing a phone from the account disconnects it and ends its sign-in; its old sign-in stays dead, and a new Google sign-in on it adds it back",
  );

  const oldMacId = connector.macId;
  await owner.removeDevice(oldMacId);
  await until("Mac removed", () => connector!.status === "removed", 15_000);
  if (connector.macId !== oldMacId || store.phones.length === 0)
    throw new Error("A removed Mac erased itself without asking");
  await connector.startOver();
  await until(
    "Mac reset",
    () =>
      connector!.macId !== oldMacId &&
      connector!.status === "waiting_for_phone",
    15_000,
  );
  if (store.relayToken || store.phones.length !== 0)
    throw new Error("Starting over kept the token or phones");
  pass(
    "a removed Mac stops and keeps its keys until its user starts over, then pairs as a new device",
  );

  // The app's own path: Settings › Remote's switch and pairing code, on a
  // second Mac with its own home.
  const macNotified: string[] = [];
  const hostContext = await createApplicationContext({
    sendNativeNotification: async (notification) => {
      macNotified.push(notification.body);
      return { delivered: true, backend: "app", degraded: false };
    },
    env: { ...env, DAEDALUS_HOME: secondHome, DAEDALUS_REMOTE_RELAY: relayUrl },
  });
  host = new RemoteHost({
    context: hostContext,
    macName: "Second Mac",
    handlers: () => createDesktopRequestHandlers(hostContext),
    openTerminal: agentTerminalOpener(context, context.tmux),
    lockedRetryMs: 1_000,
  });
  await host.start();
  if (host.state().status !== "off")
    throw new Error("Remote started while off");
  await host.setEnabled(true);
  await until(
    "host waiting",
    () => host!.state().status === "waiting_for_phone",
  );
  const hostAnswers = {
    request: () => host!.state().pairingRequest,
    confirm: (allow: boolean) => host!.confirmPairing(allow),
  };
  // Someone else saw the code and was faster: their account claims the
  // Mac, and its user declines their phone. The Mac leaves that account.
  const firstHostId = host.state().phones.length;
  const seenOffer = decodePairingOffer((await host.pairingCode()).url);
  const intruder = createIdentity();
  const declined = await pairAndAnswer(
    intruder,
    seenOffer,
    "iPhone",
    await signInPhone("bob@example.com", intruder),
    hostAnswers,
    false,
  ).then(
    () => "paired",
    (error: Error) => error.message,
  );
  await until(
    "the declined Mac starts over",
    () =>
      host!.state().status === "waiting_for_phone" && !host!.state().account,
    15_000,
  );
  if (!declined.includes("declined") || firstHostId !== 0)
    throw new Error(`Declining: ${declined}`);
  pass(
    "declining a Mac's first phone takes the Mac off the account that claimed it, and it waits to be paired again",
  );

  const hostOffer = decodePairingOffer((await host.pairingCode()).url);
  const secondPhone = createIdentity();
  const tabletToken = await signInPhone("alice@example.com", secondPhone);
  const secondMac = await pairAndAnswer(
    secondPhone,
    hostOffer,
    "Alice's tablet",
    tabletToken,
    hostAnswers,
  );
  await until("host online", () => host!.state().status === "online");
  if (
    host
      .state()
      .phones.map((item) => item.name)
      .join() !== "Alice's tablet"
  )
    throw new Error(`Host phones: ${JSON.stringify(host.state().phones)}`);
  const viaHost = await PhoneConnection.connect(
    secondPhone,
    secondMac,
    tabletToken,
  );
  await until("phone connected notice", () =>
    macNotified.some((body) => body.startsWith("Alice's tablet is connected")),
  );
  const hostSnapshot = (await viaHost.request(
    "snapshot",
  )) as RpcResult<unknown>;
  if (!hostSnapshot.ok) throw new Error("Snapshot through the host failed");
  viaHost.close();

  // Push: the tablet subscribes; a session on the second Mac starts needing
  // the user while nobody is at that Mac (no app has written presence).
  const aliceAccount = new RelayAccount(relayUrl, tabletToken);
  if ((await aliceAccount.pushKey()).publicKey !== vapidPublic)
    throw new Error("The relay handed out the wrong push key");
  const badEndpoint = await aliceAccount
    .setPushSubscription(secondPhone.id, "https://evil.example/push")
    .then(
      () => "accepted",
      (error: RelayError) => error.code,
    );
  if (badEndpoint !== "BAD_ENDPOINT")
    throw new Error(`An unknown push host was accepted: ${badEndpoint}`);
  await aliceAccount.setPushSubscription(
    secondPhone.id,
    `${pushOrigin}/tablet`,
  );
  const hostEnv = { ...env, DAEDALUS_HOME: secondHome };
  const hostCli = async (args: string[]) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        join(root, "apps/cli/src/index.ts"),
        ...args,
        "--json",
      ],
      { cwd: root, env: hostEnv, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(child.stdout).text();
    await child.exited;
    return (JSON.parse(out) as { data: unknown }).data;
  };
  await Bun.write(
    join(secondHome, "config.json"),
    JSON.stringify({
      ...((await Bun.file(join(secondHome, "config.json")).json()) as object),
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const hostWorkspace = (await hostCli(["workspace", "create", "Second"])) as {
    id: string;
  };
  const spawnShell = async () =>
    (
      (await hostCli([
        "agent",
        "spawn",
        "--workspace",
        hostWorkspace.id,
        "--command",
        "shell",
      ])) as { id: string }
    ).id;
  // The app is running in the background and the user idle `seconds`.
  const idleFor = (seconds: number) =>
    Bun.write(
      join(secondHome, "presence.json"),
      JSON.stringify({
        appForeground: false,
        workspaceId: null,
        sessionId: null,
        userIdleSeconds: seconds,
        observedAt: new Date().toISOString(),
        pid: process.pid,
      }),
    );
  /** A hook raises attention in a CLI; the app's next tick delivers it. */
  const raiseAndDeliver = async (sessionId: string, reason: string) => {
    await hostCli(["attention", reason, "--session", sessionId]);
    const reports: string[] = [];
    await hostContext.notifications.flushDesktop(
      5,
      60_000,
      Date.now(),
      (_n, result) =>
        reports.push(result === "phone" ? "phone" : `mac:${result.backend}`),
    );
    return reports;
  };

  await idleFor(600);
  const onScreen = await PhoneConnection.connect(
    secondPhone,
    secondMac,
    tabletToken,
  );
  onScreen.setVisible(true);
  await sleep(300);
  const whileOpen = await raiseAndDeliver(await spawnShell(), "Look here");
  onScreen.close();
  await sleep(500);
  if (whileOpen.join() !== "phone" || pushes.length !== 0)
    throw new Error(
      `Phone on screen: ${JSON.stringify({ whileOpen, pushes: pushes.length })}`,
    );

  const away = await raiseAndDeliver(await spawnShell(), "Pick a database");
  await until("push", () => pushes.length > 0, 10_000);
  if (away.join() !== "phone") throw new Error(`Away: ${away.join()}`);
  const push = pushes[0]!;
  const [jwt, key] =
    /^vapid t=([^,]+), k=(.+)$/.exec(push.authorization)?.slice(1) ?? [];
  const [head, claims, signature] = (jwt ?? "").split(".");
  const verifies = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    vapid.publicKey,
    Buffer.from(signature ?? "", "base64url"),
    new TextEncoder().encode(`${head}.${claims}`),
  );
  const aud = (
    JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as {
      aud: string;
    }
  ).aud;
  if (
    push.path !== "/tablet" ||
    push.length !== 0 ||
    key !== vapidPublic ||
    !verifies ||
    aud !== pushOrigin
  )
    throw new Error(
      `Push is wrong: ${JSON.stringify({ push, aud, verifies })}`,
    );

  const soonAfter = await raiseAndDeliver(await spawnShell(), "Pick a port");
  await sleep(1_000);
  if (soonAfter.join() !== "phone" || pushes.length !== 1)
    throw new Error("A second push inside 15 s went out");

  await idleFor(20);
  const atMac = await raiseAndDeliver(await spawnShell(), "Pick a name");
  await sleep(1_000);
  if (atMac.join() !== "mac:app" || pushes.length !== 1)
    throw new Error(
      `At the Mac: ${JSON.stringify({ atMac, pushes: pushes.length })}`,
    );
  pass(
    "alerts go to one place: the phone app on screen shows them, away (idle 5 min) gets one empty VAPID-signed push and no macOS notification, at most one push per 15 s, and at the Mac only macOS",
  );
  await runCommand("tmux", [
    "-L",
    `daedalus-${createHash("sha256").update(secondHome).digest("hex").slice(0, 12)}`,
    "kill-server",
  ]);

  await host.removePhone(secondPhone.id);
  const forgotten = await PhoneConnection.connect(
    secondPhone,
    secondMac,
    tabletToken,
  ).then(
    (open) => {
      open.close();
      return "connected";
    },
    (error: Error) => error.message,
  );
  if (forgotten === "connected") throw new Error("A forgotten phone connected");

  // The cost caps (artifacts/remote-work/cost-analysis.md).
  const capPhone = createIdentity();
  const capToken = await signInPhone("alice@example.com", capPhone);
  const capMac = await pairAndAnswer(
    capPhone,
    decodePairingOffer((await host.pairingCode()).url),
    "Cap phone",
    capToken,
    hostAnswers,
  );
  const closedWith = (open: PhoneConnection) =>
    new Promise<string>((resolve) => open.onClose(resolve));
  const busy = async (open: PhoneConnection, closed: Promise<string>) => {
    let done = false;
    void closed.then(() => {
      done = true;
    });
    for (let index = 0; index < 400 && !done; index += 1)
      await open.request("snapshot");
    return closed;
  };

  // 1. An account's frames for the month: past them, its connections close.
  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "active",
    monthlyFrames: 1,
  });
  let capConnection = await PhoneConnection.connect(capPhone, capMac, capToken);
  const overLimit = await busy(capConnection, closedWith(capConnection));
  if (overLimit !== "Monthly limit reached")
    throw new Error(`Frame limit: closed with ${overLimit}`);
  await adminCall("POST", "/admin/entitlements", {
    email: "alice@example.com",
    status: "active",
    monthlyFrames: 30_000_000,
  });
  await until(
    "Mac back after the frame limit",
    () => host!.state().status === "online",
    15_000,
  );
  pass(
    "an account past its monthly frames is closed at once, and raising the limit lets it back",
  );

  // 2. The relay's own monthly budget: closed, nothing connects; reopened,
  // everything comes back.
  capConnection = await PhoneConnection.connect(capPhone, capMac, capToken);
  const paused = closedWith(capConnection);
  await adminCall("POST", "/admin/budget", { open: false });
  if ((await paused) === "") throw new Error("Budget close left a phone open");
  await expectRefusal(
    "a phone while the budget is closed",
    PhoneConnection.connect(capPhone, capMac, capToken),
    RELAY_CLOSE.budgetExhausted,
  );
  const status = (await adminCall("GET", "/admin/budget")).data as {
    open: boolean;
    closedBy: string | null;
    units: { frames: number; workerRequests: number };
  };
  if (status.open || status.closedBy !== "admin" || status.units.frames < 100)
    throw new Error(`Budget status: ${JSON.stringify(status)}`);
  const phonePage = await fetch(`${relayHttp}/health`);
  if (!phonePage.ok)
    throw new Error("The relay stopped answering while paused");
  await adminCall("POST", "/admin/budget", { open: true });
  await until(
    "Mac back after the budget",
    () => host!.state().status === "online",
    15_000,
  );
  (await PhoneConnection.connect(capPhone, capMac, capToken)).close();
  pass(
    `the monthly budget pauses the whole relay and reopens it (counted ${status.units.frames} frames, ${status.units.workerRequests} Worker requests)`,
  );
  // Keep awake: a caffeinate tied to this process, while phone access is on.
  const caffeinate = () =>
    Bun.spawnSync(["pgrep", "-f", `caffeinate -i -w ${process.pid}`])
      .stdout.toString()
      .trim();
  if (caffeinate()) throw new Error("Keeping awake before it was asked");
  if (!(await host.setKeepAwake(true)).keepAwake || !caffeinate())
    throw new Error("Keep awake did not start caffeinate");
  await host.setKeepAwake(false);
  await sleep(200);
  if (caffeinate()) throw new Error("caffeinate outlived Keep awake");
  await host.setKeepAwake(true);
  await host.setEnabled(false);
  await sleep(200);
  if (caffeinate()) throw new Error("caffeinate outlived phone access");
  await host.setKeepAwake(false);
  pass(
    "Keep the Mac awake holds caffeinate only while phone access and the setting are on",
  );

  const stored = (await Bun.file(join(secondHome, "config.json")).json()) as {
    remoteEnabled?: boolean;
  };
  if (host.state().status !== "off" || stored.remoteEnabled !== false)
    throw new Error("Turning remote off did not stick");
  pass("Settings › Remote's host: on, pairing code, paired phone, forget, off");

  // A Mac that signs itself in, as Settings › Remote does now: the browser
  // signs in, the relay puts the Mac on that account, and with no plan the
  // Mac shows the account and takes an invite code.
  const signInContext = await createApplicationContext({
    env: { ...env, DAEDALUS_HOME: thirdHome, DAEDALUS_REMOTE_RELAY: relayUrl },
  });
  signInHost = new RemoteHost({
    context: signInContext,
    macName: "Dave's Mac",
    handlers: () => createDesktopRequestHandlers(signInContext),
    openTerminal: agentTerminalOpener(context, context.tmux),
    lockedRetryMs: 60_000,
  });
  await signInHost.start();
  await signInHost.setEnabled(true);
  await until(
    "signing-in Mac waiting",
    () => signInHost!.state().status === "waiting_for_phone",
  );
  if (signInHost.state().signedIn) throw new Error("Signed in before it was");
  const { url: macSignIn } = await signInHost.signIn();
  const signedInPage = await browserSignIn(macSignIn, "dave@example.com");
  if (
    signedInPage.status !== 200 ||
    !signedInPage.page.includes("Your Mac is signed in") ||
    !signedInPage.page.includes("dave@example.com") ||
    !signedInPage.page.includes("needs Daedalus Pro")
  )
    throw new Error(`Mac sign-in page: ${signedInPage.status}`);
  await until(
    "the Mac signed in without a plan",
    () => {
      const state = signInHost!.state();
      return (
        state.signedIn &&
        state.status === "locked" &&
        state.lockedBy === "no_plan" &&
        state.account === "dave@example.com"
      );
    },
    15_000,
  );
  const replayed = await browserSignIn(macSignIn, "eve@example.com");
  if (replayed.status !== 400 || !replayed.page.includes("Sign-in expired"))
    throw new Error(`A spent Mac sign-in worked again: ${replayed.status}`);
  pass(
    "a Mac signs itself in through the browser: the relay puts it on that account and says so on a page; without a plan the Mac shows the account and why it is locked; the sign-in address works once",
  );

  const badInvite = await signInHost.redeemInvite("WRONG-CODE").then(
    () => "redeemed",
    (error: Error) => error.message,
  );
  if (!badInvite.includes("not valid"))
    throw new Error(`A wrong invite on the Mac: ${badInvite}`);
  await signInHost.redeemInvite(await newInvite());
  await until(
    "the Mac online with Pro",
    () =>
      signInHost!.state().status === "online" &&
      signInHost!.state().plan?.name === "pro",
    15_000,
  );
  pass(
    "an invite code typed on the Mac gives its account Pro, and the Mac connects at once",
  );

  const daveOffer = decodePairingOffer((await signInHost.pairingCode()).url);
  const wrongAccount = await new RelayAccount(
    relayUrl,
    (await signIn("alice@example.com")).get("token")!,
  )
    .claimMac(daveOffer.macId, "x", claimKey(daveOffer))
    .then(
      () => "claimed",
      (error: RelayError) => `${error.code}: ${error.message}`,
    );
  if (
    !wrongAccount.startsWith("WRONG_ACCOUNT") ||
    !wrongAccount.includes("dave@example.com")
  )
    throw new Error(`Another account's phone: ${wrongAccount}`);
  const davePhone = createIdentity();
  const daveMac = await pairAndAnswer(
    davePhone,
    daveOffer,
    "Dave's phone",
    await signInPhone("dave@example.com", davePhone),
    {
      request: () => signInHost!.state().pairingRequest,
      confirm: (allow: boolean) => signInHost!.confirmPairing(allow),
    },
  );
  if (daveMac.macName !== "Dave's Mac")
    throw new Error(`Paired with ${daveMac.macName}`);
  // Alice's tablet signs in as Dave on the same device: it moves to Dave's
  // account and pairs, and Alice's account no longer has it.
  const movedToken = await signInPhone("dave@example.com", secondPhone);
  await pairAndAnswer(
    secondPhone,
    decodePairingOffer((await signInHost.pairingCode()).url),
    "Alice's tablet",
    movedToken,
    {
      request: () => signInHost!.state().pairingRequest,
      confirm: (allow: boolean) => signInHost!.confirmPairing(allow),
    },
  );
  const aliceDevices = (
    await new RelayAccount(
      relayUrl,
      (await signIn("alice@example.com")).get("token")!,
    ).me()
  ).devices;
  if (aliceDevices.some((item) => item.id === secondPhone.id))
    throw new Error("The tablet stayed on Alice's account");
  pass(
    "a phone on another account is told which account the Mac is on; one on the Mac's account pairs; a phone signed in to another account moves to it and pairs there",
  );

  // Settings › Account's admin section, for an account on ADMIN_ACCOUNTS.
  if (!(await signInHost.refreshAccount()).admin)
    throw new Error("Dave is on ADMIN_ACCOUNTS but not an admin");
  // E: sudo mode. Admin is locked until a Google sign-in in the browser,
  // as the Mac's own account, approves an unlock.
  const lockedOut = await signInHost.adminKeys().then(
    () => "listed",
    (error: Error) => error.message,
  );
  if (
    !lockedOut.includes("Admin is locked") ||
    (await signInHost.adminStatus()).unlockedUntil !== null
  )
    throw new Error(`Admin before unlocking: ${lockedOut}`);
  const { url: unlockUrl } = await signInHost.adminUnlock();
  const wrongApprover = await browserSignIn(unlockUrl, "alice@example.com");
  if (
    wrongApprover.status !== 403 ||
    !wrongApprover.page.includes("Not the admin account") ||
    (await signInHost.adminStatus()).unlockedUntil !== null
  )
    throw new Error(
      `Another account approved the unlock: ${wrongApprover.status}`,
    );
  const approved = await browserSignIn(unlockUrl, "dave@example.com");
  const unlockedFor =
    (Date.parse((await signInHost.adminStatus()).unlockedUntil ?? "") -
      Date.now()) /
    60_000;
  if (
    approved.status !== 200 ||
    !approved.page.includes("Admin unlocked") ||
    !(unlockedFor > 14 && unlockedFor <= 15)
  )
    throw new Error(`Unlocking: ${approved.status} ${unlockedFor}`);
  // The device token alone, without the unlock's secret, is what an agent
  // that read the Keychain would hold. It is refused.
  const daveStore = await RemoteStore.open(thirdHome, null);
  const tokenOnly = await macRelayCall(
    relayUrl,
    daveStore,
    "/v1/macs/admin/invites",
  );
  if (tokenOnly.error?.code !== "ADMIN_LOCKED")
    throw new Error(`The device token alone: ${JSON.stringify(tokenOnly)}`);
  pass(
    "sudo mode: admin is locked until a Google sign-in in the browser approves an unlock (15 minutes); another account cannot approve it; the device token without the unlock's in-memory secret is refused",
  );
  const madeKey = await signInHost.adminCreateKey({
    maxUses: 2,
    grantDays: 7,
    days: 30,
    note: "for the check",
  });
  const listed = (await signInHost.adminKeys()).find(
    (key) => key.code === madeKey.code,
  );
  if (
    listed?.plan !== "pro" ||
    listed.maxUses !== 2 ||
    listed.grantDays !== 7 ||
    !listed.expiresAt ||
    listed.note !== "for the check"
  )
    throw new Error(`Admin key: ${JSON.stringify(listed)}`);
  const accounts = await signInHost.adminAccounts();
  const carol = accounts.find((item) => item.email === "carol@example.com");
  if (!carol || "macs" in carol || "phones" in carol)
    throw new Error(`Admin accounts: ${JSON.stringify(carol)}`);
  const carolAccount = new RelayAccount(
    relayUrl,
    (await signIn("carol@example.com")).get("token")!,
  );
  await signInHost.adminSetPlan({
    email: "carol@example.com",
    status: "expired",
  });
  const carolEnded = (await carolAccount.me()).entitlement;
  await signInHost.adminSetPlan({
    email: "carol@example.com",
    status: "active",
    days: 10,
  });
  const carolDays =
    (Date.parse((await carolAccount.me()).entitlement?.expiresAt ?? "") -
      Date.now()) /
    86_400_000;
  if (carolEnded !== null || !(carolDays > 9.9 && carolDays <= 10))
    throw new Error(`Admin plan: ${JSON.stringify(carolEnded)} ${carolDays}`);
  await signInHost.adminRenameKey(madeKey.code, "Dave's friends");
  if (
    (await signInHost.adminKeys()).find((key) => key.code === madeKey.code)
      ?.note !== "Dave's friends"
  )
    throw new Error("Renaming a key did not stick");
  // A used-up key leaves the list; the account it went to shows its plan.
  const oneUse = await signInHost.adminCreateKey({ maxUses: 1 });
  const erinToken = (await signIn("erin@example.com", oneUse.code)).get(
    "token",
  );
  const erinPlan = (await new RelayAccount(relayUrl, erinToken!).me())
    .entitlement?.plan;
  if (
    erinPlan !== "pro" ||
    (await signInHost.adminKeys()).some((key) => key.code === oneUse.code)
  )
    throw new Error(`A used-up key: Erin ${erinPlan}, still listed`);
  await signInHost.adminDeleteKey(madeKey.code);
  if ((await signInHost.adminKeys()).some((key) => key.code === madeKey.code))
    throw new Error("A deleted key is still listed");
  // B: every change is in the log, with who made it.
  const log = await signInHost.adminLog();
  const adminLogged = log
    .filter((entry) => entry.actor === "dave@example.com")
    .map((entry) => entry.action);
  for (const action of [
    "invites.create",
    "invites.rename",
    "invites.delete",
    "plan.set",
  ] as const)
    if (!adminLogged.includes(action))
      throw new Error(`The admin log has no ${action}: ${adminLogged.join()}`);
  // A: the Mac's door makes and grants Pro only, within caps, whatever
  // it is sent. Called as the Mac itself, past the app, with an unlock of
  // its own (which replaces the app's: one per Mac).
  const secret = randomBytes(32).toString("base64url");
  const unlockAs = { "X-Daedalus-Admin": secret };
  const ownUnlock = await macRelayCall<{ url: string }>(
    relayUrl,
    daveStore,
    "/v1/macs/admin/unlock",
    { secretHash: createHash("sha256").update(secret).digest("base64url") },
  );
  await browserSignIn(ownUnlock.data!.url, "dave@example.com");
  const forced = await macRelayCall<{ code: string }>(
    relayUrl,
    daveStore,
    "/v1/macs/admin/invites/create",
    { plan: "admin", maxUses: 5_000, grantDays: 9_999, days: 9_999 },
    unlockAs,
  );
  const forcedKey = (
    await macRelayCall<
      Array<{
        code: string;
        plan: string;
        maxUses: number;
        grantDays: number;
        expiresAt: string;
      }>
    >(relayUrl, daveStore, "/v1/macs/admin/invites", {}, unlockAs)
  ).data?.find((key) => key.code === forced.data?.code);
  const forcedDays =
    (Date.parse(forcedKey?.expiresAt ?? "") - Date.now()) / 86_400_000;
  const forcedGrant = await macRelayCall<{ plan: string }>(
    relayUrl,
    daveStore,
    "/v1/macs/admin/plan",
    { email: "carol@example.com", status: "active", plan: "admin" },
    unlockAs,
  );
  if (
    forcedKey?.plan !== "pro" ||
    forcedKey.maxUses !== 100 ||
    forcedKey.grantDays !== 365 ||
    !(forcedDays > 364 && forcedDays <= 365) ||
    forcedGrant.data?.plan !== "pro"
  )
    throw new Error(
      `The Mac's door went past its caps: ${JSON.stringify({ forcedKey, forcedGrant })}`,
    );
  // D: Alice is listed by email, but with another Google id.
  const notAdmin = await host!.adminKeys().then(
    () => "listed",
    (error: Error) => error.message,
  );
  if (!notAdmin.includes("not an admin"))
    throw new Error(`Alice's Mac read the keys: ${notAdmin}`);
  // C: at most 60 changes an hour through the Mac's door.
  let limited = 0;
  for (let attempt = 0; attempt < 70 && !limited; attempt++) {
    const renamed = await macRelayCall(
      relayUrl,
      daveStore,
      "/v1/macs/admin/invites/rename",
      { code: forced.data?.code, note: `try ${attempt}` },
      unlockAs,
    );
    if (!renamed.ok) limited = attempt;
  }
  const changes = (
    (
      await macRelayCall<Array<{ actor: string }>>(
        relayUrl,
        daveStore,
        "/v1/macs/admin/log",
        {},
        unlockAs,
      )
    ).data ?? []
  ).filter((entry) => entry.actor === "dave@example.com").length;
  if (!limited || changes !== 60)
    throw new Error(
      `Admin rate limit: refused at ${limited}, ${changes} logged`,
    );
  // Lock ends the unlock at once.
  await macRelayCall(relayUrl, daveStore, "/v1/macs/admin/lock", {}, unlockAs);
  const afterLock = await macRelayCall(
    relayUrl,
    daveStore,
    "/v1/macs/admin/invites",
    {},
    unlockAs,
  );
  if (afterLock.error?.code !== "ADMIN_LOCKED")
    throw new Error(`Admin after Lock: ${JSON.stringify(afterLock)}`);
  pass(
    "Lock ends the unlock; the Mac's admin door makes and grants Pro only, capped at 100 uses and 365 days whatever it is sent; every change is logged with who made it; 60 changes an hour at most; an email on the list with another Google id is not an admin",
  );
  pass(
    "an account on ADMIN_ACCOUNTS manages Pro keys (create with uses, trial and expiry, list, rename, delete; a used-up key leaves the list) and plans (end, grant for days) from its Mac, and sees accounts without devices; another account's Mac is refused",
  );

  // Settings › Account works with phone access off: it still shows the
  // account and plan, reads them from the relay, and signs out.
  await signInHost.setEnabled(false);
  const offState = await signInHost.refreshAccount();
  if (
    offState.status !== "off" ||
    !offState.signedIn ||
    offState.account !== "dave@example.com" ||
    offState.plan?.name !== "pro"
  )
    throw new Error(
      `Account with phone access off: ${JSON.stringify(offState)}`,
    );
  await signInHost.leaveAccount();
  if (signInHost.state().signedIn || signInHost.state().phones.length)
    throw new Error("Signing out kept the account or phones");
  pass(
    "with phone access off the Mac still shows and refreshes its account and plan, and signing out forgets the account and its phones",
  );

  // 3. Hourly housekeeping drops unclaimed Macs older than a day.
  const d1 = (command: string) =>
    Bun.spawnSync(
      [
        wrangler,
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        relayState,
        "--json",
        "--command",
        command,
      ],
      {
        cwd: relayDir,
        env: { ...process.env, CI: "1" },
        stdout: "pipe",
        stderr: "pipe",
      },
    ).stdout.toString();
  const inserted = d1(
    `INSERT INTO devices (id, user_id, kind, created_at) VALUES ('stale-unclaimed-mac', NULL, 'mac', '${new Date(Date.now() - 2 * 86_400_000).toISOString()}')`,
  );
  // `/__scheduled` is now the phone app's page; this one reaches the Worker.
  if (
    !d1("SELECT id FROM devices WHERE id = 'stale-unclaimed-mac'").includes(
      "stale-unclaimed-mac",
    )
  )
    throw new Error(`Could not plant a stale Mac: ${inserted.slice(0, 200)}`);
  await fetch(`${relayHttp}/cdn-cgi/handler/scheduled?cron=17+*+*+*+*`);
  await sleep(1_000);
  if (
    d1("SELECT id FROM devices WHERE id = 'stale-unclaimed-mac'").includes(
      "stale-unclaimed-mac",
    )
  )
    throw new Error("Housekeeping kept a day-old unclaimed Mac");
  pass("hourly housekeeping removes unclaimed Macs older than a day");

  // 4. Unclaimed Macs connect without sign-in, so they are limited per IP.
  const attempts = await Promise.all(
    Array.from({ length: 14 }, async () => {
      const id = createIdentity().id;
      const socket = new WebSocket(
        `${relayUrl}/v1/connect?room=${id}&role=mac&device=${id}`,
        ["daedalus.v1", `auth.secret-${id}`],
      );
      return new Promise<number>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event.code));
        setTimeout(() => {
          socket.close();
          resolve(0);
        }, 3_000);
      });
    }),
  );
  if (!attempts.includes(RELAY_CLOSE.rateLimited))
    throw new Error(`No unclaimed connect was limited: ${attempts.join(",")}`);
  pass(
    `unclaimed Macs are limited per IP (${attempts.filter((code) => code === RELAY_CLOSE.rateLimited).length} of 14 refused)`,
  );

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
  // Duration is billed only while a handler runs: about 1.45 ms a frame.
  const hourDuration = 0.125 * 0.00145 * working.frames * 60;
  console.log(
    `  one hour of watching a busy session: ~$${(hourRequests * requestPrice + hourDuration * durationPrice).toFixed(4)} at list price`,
  );
  console.log(`  Mac status changes: ${statuses.join(" → ")}`);
} finally {
  host?.stop();
  signInHost?.stop();
  connection?.close();
  connector?.stop();
  relay.kill();
  await relay.exited;
  google.stop(true);
  pushService.stop(true);
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
  await rm(secondHome, { recursive: true, force: true });
  await rm(thirdHome, { recursive: true, force: true });
  await rm(relayState, { recursive: true, force: true });
}
