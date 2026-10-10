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
import {
  CommandTmuxClient,
  runCommand,
  TmuxPtyBridge,
} from "@daedalus/platform";
import type { DesktopSnapshotDto, RpcResult } from "@daedalus/protocol";
import {
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
  pass(
    `paired by code (${code.length} characters for the QR) after the Mac's user allowed it, with the same six digits on both screens; the Mac rejoined as Alice's and knows the account`,
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
  pass(
    "removing a phone from the account disconnects it for good and ends its sign-in",
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
  connection?.close();
  connector?.stop();
  relay.kill();
  await relay.exited;
  google.stop(true);
  pushService.stop(true);
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
  await rm(secondHome, { recursive: true, force: true });
  await rm(relayState, { recursive: true, force: true });
}
