// Phase 0 of remote access (#53): a phone script drives a real Daedalus
// session through a local relay running on Cloudflare's runtime (workerd,
// via `wrangler dev`), end-to-end encrypted. Prints what crossed the relay
// per minute so the cost per user is measured, not guessed.
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
  emptyWireStats,
  encodePairingOffer,
  PhoneConnection,
  pairWithMac,
  sodiumReady,
  type WireStats,
} from "@daedalus/remote-protocol";
import {
  agentTerminalOpener,
  RemoteConnector,
  RemoteStore,
} from "../apps/desktop/src/bun/remote";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

const root = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await mkdtemp(join(tmpdir(), "daedalus-remote-"));
const relayState = await mkdtemp(join(tmpdir(), "daedalus-relay-"));
const socket = `daedalus-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;
const port = 18_700 + Math.floor(Math.random() * 1_000);
const relayUrl = `ws://127.0.0.1:${port}`;
const env = { ...process.env, DAEDALUS_HOME: home };

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

const relay = Bun.spawn(
  [
    join(root, "apps/relay/node_modules/.bin/wrangler"),
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    relayState,
    "--log-level",
    "warn",
  ],
  {
    cwd: join(root, "apps/relay"),
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
let phoneConnection: PhoneConnection | undefined;
try {
  await sodiumReady();
  const health = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const ok = await fetch(health).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    if (Date.now() > deadline) throw new Error("The local relay did not start");
    await sleep(250);
  }
  console.log(`PASS local relay on Cloudflare's runtime at ${relayUrl}`);

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
  connector = new RemoteConnector({
    relay: relayUrl,
    macName: "Spike Mac",
    store,
    handlers: createDesktopRequestHandlers(context) as unknown as Record<
      string,
      (params: never) => unknown
    >,
    openTerminal: agentTerminalOpener(context, context.tmux),
    tap,
  });
  await connector.start();
  console.log("PASS Mac connector reached the relay (outbound only)");

  // Pairing: the code goes through the QR text form and back.
  const phone = createIdentity();
  const code = encodePairingOffer(connector.createPairingOffer());
  const offer = decodePairingOffer(code);
  const mac = await pairWithMac(phone, offer, "Spike phone");
  if (!store.phone(phone.id)) throw new Error("Paired phone was not stored");
  console.log(`PASS paired by code (${code.length} characters for the QR)`);

  const reuse = await pairWithMac(createIdentity(), offer, "Second phone").then(
    () => "accepted",
    (error: Error) => error.message,
  );
  if (reuse === "accepted") throw new Error("A pairing code worked twice");
  console.log("PASS a used pairing code is refused");

  const stranger = await PhoneConnection.connect(createIdentity(), mac).then(
    (c) => {
      c.close();
      return "connected";
    },
    (error: Error) => error.message,
  );
  if (stranger === "connected") throw new Error("An unpaired phone connected");
  console.log("PASS an unpaired phone is refused");

  phoneConnection = await PhoneConnection.connect(phone, mac, { tap });
  const connection = phoneConnection;
  console.log("PASS encrypted handshake through the relay");

  const snapshot = (await connection.request(
    "snapshot",
  )) as RpcResult<DesktopSnapshotDto>;
  if (!snapshot.ok || !snapshot.data.agents.some((a) => a.id === agent.id))
    throw new Error(
      `Snapshot failed: ${JSON.stringify(snapshot).slice(0, 300)}`,
    );
  const snapshotBytes = JSON.stringify(snapshot).length;
  console.log(
    `PASS snapshot over the channel (${snapshot.data.agents.length} session, ${snapshotBytes} bytes of JSON)`,
  );

  const forbidden = (await connection.request("workspaceDelete", {
    reference: workspace.id,
  })) as RpcResult<unknown>;
  if (forbidden.ok) throw new Error("A phone deleted a workspace");
  console.log("PASS requests outside the allowlist are refused");

  let changed = 0;
  connection.onDataChanged(() => {
    changed += 1;
  });
  connector.announce();
  await until("dataChanged", () => changed > 0);
  console.log("PASS data-changed events reach the phone");

  const decoder = new TextDecoder();
  let screen = "";
  const terminal = connection.openTerminal(
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
  console.log(
    "PASS live terminal: phone typing reaches tmux, output comes back",
  );

  const sent = (await connection.request("agentSend", {
    id: agent.id,
    text: `printf '%s\\n' ${markers[1]}`,
  })) as RpcResult<unknown>;
  if (!sent.ok) throw new Error(`agentSend failed: ${JSON.stringify(sent)}`);
  await until("agentSend marker", () => screen.includes(markers[1]!));
  console.log("PASS agentSend from the phone");

  terminal.write(
    "i=0; while [ $i -lt 5000 ]; do printf 'NOISE-%04d-abcdefghijklmnopqrstuvwxyz\\n' $i; i=$((i+1)); done; printf 'NOISE_DONE\\n'\r",
  );
  await until("burst output", () => screen.includes("NOISE_DONE"), 20_000);
  console.log("PASS 5,000-line burst arrives intact");

  const leaked = rawFrames.some((frame) => {
    const raw = decoder.decode(frame);
    return (
      markers.some((marker) => raw.includes(marker)) || raw.includes("NOISE-")
    );
  });
  if (leaked) throw new Error("Plaintext reached the relay");
  console.log(
    `PASS none of ${rawFrames.length} relay frames contained plaintext`,
  );

  // Measure: what one phone watching one working session costs.
  const measure = async (
    label: string,
    seconds: number,
    start?: () => void,
  ) => {
    const before = {
      mac: { ...connector!.stats },
      phone: { ...connection.stats },
    };
    start?.();
    await sleep(seconds * 1_000);
    const delta = (now: WireStats, then: WireStats): WireStats => ({
      framesIn: now.framesIn - then.framesIn,
      framesOut: now.framesOut - then.framesOut,
      bytesIn: now.bytesIn - then.bytesIn,
      bytesOut: now.bytesOut - then.bytesOut,
    });
    const mac = delta(connector!.stats, before.mac);
    const phoneStats = delta(connection.stats, before.phone);
    const perMinute = 60 / seconds;
    // Every frame a device sends is one incoming WebSocket message to the
    // room, billed at 20 messages per request.
    const framesToRelay = (mac.framesOut + phoneStats.framesOut) * perMinute;
    const bytes = (mac.bytesOut + phoneStats.bytesOut) * perMinute;
    return { label, framesToRelay, bytes };
  };

  const idle = await measure("terminal open, nothing printing", 10);
  const working = await measure("agent printing ~20 lines a second", 20, () =>
    terminal.write(
      "i=0; while [ $i -lt 400 ]; do printf 'step %03d: reading files, running tests, writing a patch to the module\\n' $i; sleep 0.05; i=$((i+1)); done\r",
    ),
  );
  terminal.close();

  const requestPrice = 0.15 / 1_000_000;
  const durationPrice = 12.5 / 1_000_000;
  console.log("\nMeasured relay traffic per minute (one phone, one session):");
  for (const row of [idle, working]) {
    const requests = row.framesToRelay / 20;
    console.log(
      `  ${row.label}: ${Math.round(row.framesToRelay)} frames, ${(row.bytes / 1024).toFixed(1)} KiB, ~${requests.toFixed(1)} billed requests`,
    );
  }
  const hourRequests = (working.framesToRelay / 20) * 60;
  // A room that keeps receiving messages stays awake: 128 MB for the hour.
  const hourDuration = 0.128 * 3_600;
  console.log(
    `  one hour of watching a busy session: ~$${(hourRequests * requestPrice + hourDuration * durationPrice).toFixed(4)} (requests $${(hourRequests * requestPrice).toFixed(5)} + duration $${(hourDuration * durationPrice).toFixed(4)}), before the plan's included amounts`,
  );
  console.log("  a connected idle Mac: pings are auto-answered, so ~$0");
} finally {
  phoneConnection?.close();
  connector?.stop();
  relay.kill();
  await relay.exited;
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
  await rm(relayState, { recursive: true, force: true });
}
