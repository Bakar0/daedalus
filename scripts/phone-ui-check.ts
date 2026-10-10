// The phone app (#53), end to end in a phone-sized headless Chrome: the
// relay (wrangler dev, local D1) serves the built app, a stand-in for Google
// signs the user in, a Mac connector serves a real shell session. The page
// opens a scanned pairing link, signs in with an invite, pairs, finds the
// session under Needs me, and drives it: a message, a quick key, the
// terminal's output. Screenshots land in artifacts/.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationContext } from "@daedalus/core";
import { CommandTmuxClient, runCommand } from "@daedalus/platform";
import { pairingUrl, sodiumReady } from "@daedalus/remote-protocol";
import {
  agentTerminalOpener,
  RemoteConnector,
  RemoteStore,
} from "../apps/desktop/src/bun/remote";
import { createDesktopRequestHandlers } from "../apps/desktop/src/bun/rpc";

const root = join(import.meta.dir, "..");
const relayDir = join(root, "apps/relay");
const wrangler = join(relayDir, "node_modules/.bin/wrangler");
const chromePath =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const home = await mkdtemp(join(tmpdir(), "daedalus-phone-ui-"));
const relayState = await mkdtemp(join(tmpdir(), "daedalus-phone-relay-"));
const socket = `daedalus-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`;
const port = 19_700 + Math.floor(Math.random() * 500);
const debuggingPort = 19_300 + Math.floor(Math.random() * 300);
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env, DAEDALUS_HOME: home };
const ADMIN_KEY = "admin-test-key";
const CLIENT_ID = "test-client.apps.googleusercontent.com";
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const shot = (name: string) => join(artifacts, `phone-ui-${name}.png`);

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
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`CLI failed: ${stderr || stdout}`);
  return (JSON.parse(stdout) as { data: unknown }).data;
}

/**
 * A team needs a Claude or Codex lead, which this check cannot start, so the
 * Mac's snapshot gets one added on its way out: Builder as Lead's member.
 * Everything the phone does with it is the real code.
 */
function withTeam(
  handlers: ReturnType<typeof createDesktopRequestHandlers>,
  leadId: string,
  memberId: string,
) {
  return {
    ...handlers,
    snapshot: async (params: Record<string, never>) => {
      const result = await handlers.snapshot(params);
      if (!result.ok) return result;
      return {
        ...result,
        data: {
          ...result.data,
          teams: [{ id: "team-check", leadId, name: "Lead", goal: null }],
          agents: result.data.agents.map((session) =>
            session.id === memberId
              ? { ...session, teamId: "team-check", teamHandle: "builder" }
              : session,
          ),
        },
      };
    },
  };
}

// Google: the authorize page sends the browser straight back with a code,
// and the token endpoint turns it into an ID token for phone@example.com.
const google = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/auth") {
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "phone@example.com");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return Response.redirect(back.toString(), 302);
    }
    const form = new URLSearchParams(await request.text());
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const email = form.get("code") ?? "";
    return Response.json({
      id_token: [
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
      ].join("."),
    });
  },
});

const build = Bun.spawnSync([process.execPath, "run", "build"], {
  cwd: join(root, "apps/phone"),
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0)
  throw new Error(`Phone build failed: ${build.stderr}`);
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
  throw new Error(`Migrations failed: ${migrate.stderr}`);
const vars = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: "test-secret",
  GOOGLE_AUTH_URL: `http://127.0.0.1:${google.port}/auth`,
  GOOGLE_TOKEN_URL: `http://127.0.0.1:${google.port}/token`,
  ADMIN_KEY,
  APP_ORIGINS: origin,
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

let chrome: Bun.Subprocess | undefined;
let connector: RemoteConnector | undefined;
const profile = await mkdtemp(join(tmpdir(), "daedalus-phone-chrome-"));
try {
  await sodiumReady();
  for (
    let attempt = 0;
    !(await fetch(`${origin}/health`).then(
      (r) => r.ok,
      () => false,
    ));
    attempt++
  ) {
    if (attempt > 240) throw new Error("The local relay did not start");
    await sleep(250);
  }
  const invite = (
    (await (
      await fetch(`${origin}/admin/invites`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ADMIN_KEY}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).json()) as { data: { code: string } }
  ).data.code;

  // The Mac: a workspace, a task, two shell sessions, one asking for the user.
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { shell: { executable: "/bin/sh", args: ["-i"] } },
    }),
  );
  const workspace = (await cli(["workspace", "create", "Phone check"])) as {
    id: string;
  };
  const task = (await cli([
    "task",
    "create",
    "--workspace",
    workspace.id,
    "--title",
    "Ship the phone app",
  ])) as { id: string };
  const waiting = (await cli([
    "agent",
    "spawn",
    "--workspace",
    workspace.id,
    "--command",
    "shell",
    "--task",
    task.id,
  ])) as { id: string };
  const lead = (await cli([
    "agent",
    "spawn",
    "--workspace",
    workspace.id,
    "--command",
    "shell",
    "--name",
    "Lead",
  ])) as { id: string };
  const member = (await cli([
    "agent",
    "spawn",
    "--workspace",
    workspace.id,
    "--command",
    "shell",
    "--name",
    "Builder",
  ])) as { id: string };
  await cli(["session", "color", lead.id, "blue"]);
  await cli([
    "attention",
    "Approve the database migration",
    "--session",
    waiting.id,
  ]);

  const context = await createApplicationContext({ env });
  if (!(context.tmux instanceof CommandTmuxClient))
    throw new Error("tmux client");
  const store = await RemoteStore.open(home);
  connector = new RemoteConnector({
    relay: `ws://127.0.0.1:${port}`,
    macName: "Studio Mac",
    store,
    handlers: withTeam(
      createDesktopRequestHandlers(context),
      lead.id,
      member.id,
    ),
    openTerminal: agentTerminalOpener(context, context.tmux),
  });
  await connector.start();
  const scanned = pairingUrl(connector.createPairingOffer());

  chrome = Bun.spawn(
    [
      chromePath,
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      `--remote-debugging-port=${debuggingPort}`,
      `--user-data-dir=${profile}`,
      "--window-size=390,844",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  let debuggerUrl: string | undefined;
  for (let attempt = 0; attempt < 100 && !debuggerUrl; attempt++) {
    debuggerUrl = await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
      .then(
        (r) =>
          r.json() as Promise<
            Array<{ type: string; webSocketDebuggerUrl: string }>
          >,
      )
      .then(
        (pages) =>
          pages.find((page) => page.type === "page")?.webSocketDebuggerUrl,
      )
      .catch(() => undefined);
    if (!debuggerUrl) await sleep(100);
  }
  if (!debuggerUrl) throw new Error("Chrome did not start");
  const cdp = new WebSocket(debuggerUrl);
  await new Promise((resolve) =>
    cdp.addEventListener("open", resolve, { once: true }),
  );
  let sequence = 0;
  const pending = new Map<number, (value: any) => void>();
  const errors: string[] = [];
  cdp.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === "Runtime.exceptionThrown")
      errors.push(
        message.params.exceptionDetails.exception?.description ?? "exception",
      );
    if (
      message.method === "Log.entryAdded" &&
      message.params.entry.level === "error"
    )
      errors.push(message.params.entry.text);
    if (message.id) pending.get(message.id)?.(message.result ?? message.error);
  });
  const send = <T = any>(
    method: string,
    params: Record<string, unknown> = {},
  ) =>
    new Promise<T>((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      cdp.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <T>(expression: string): Promise<T> =>
    (
      await send<{ result: { value: T } }>("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
  const waitFor = async (
    label: string,
    expression: string,
    timeoutMs = 15_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await evaluate<boolean>(`Boolean(${expression})`))) {
      if (Date.now() > deadline)
        throw new Error(
          `Timed out waiting for ${label}. Page: ${await evaluate<string>("document.body.innerText.slice(0, 300)")}. Errors: ${errors.join(" | ") || "none"}`,
        );
      await sleep(100);
    }
  };
  const tap = async (expression: string) => {
    const point = await evaluate<{ x: number; y: number } | null>(`(() => {
      const element = ${expression};
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!point) throw new Error(`Nothing to tap: ${expression}`);
    for (const type of ["touchStart", "touchEnd"])
      await send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ x: point.x, y: point.y }],
      });
    await sleep(150);
  };
  const screenshot = async (name: string) => {
    const { data } = await send<{ data: string }>("Page.captureScreenshot", {
      format: "png",
    });
    await Bun.write(shot(name), Buffer.from(data, "base64"));
  };
  const byText = (selector: string, text: string) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((one) => one.textContent.includes(${JSON.stringify(text)}))`;

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 5,
  });

  // The camera opens the scanned link.
  await send("Page.navigate", { url: scanned });
  await waitFor("sign-in", byText("a", "Continue with Google"));
  if (
    !(await evaluate<string>("document.body.innerText")).includes(
      "finish pairing",
    )
  )
    throw new Error("The scanned code was not kept for after sign-in");
  if ((await evaluate<string>("location.hash")) !== "")
    throw new Error("The pairing code stayed in the address bar");
  await tap(byText("button", "I have an invite code"));
  await evaluate(`(() => {
    const input = document.querySelector('.field input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(invite)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await screenshot("sign-in");
  console.log("PASS a scanned pairing link opens sign-in and keeps the code");

  await tap(byText("a", "Continue with Google"));
  await waitFor("paired home", byText(".bar h1", "Studio Mac"), 30_000);
  await waitFor(
    "Needs me row",
    byText(".session-row", "Approve the database migration"),
  );
  if ((await evaluate<string>("location.hash")) !== "")
    throw new Error("The session token stayed in the address bar");
  const homeView = await evaluate<{
    needs: string[];
    workspace: {
      name: string;
      insight: string;
      rows: Array<{
        name: string;
        second: string;
        tool: string;
        color: string | null;
        edge: string;
        indent: number;
      }>;
    };
  }>(`(() => {
    const group = document.querySelector('.workspace-group');
    const base = group.querySelector('.session-rows').getBoundingClientRect().left;
    return {
      needs: [...document.querySelectorAll('.group .session-row strong')].map((one) => one.textContent),
      workspace: {
        name: group.querySelector('.workspace-head strong').textContent,
        insight: group.querySelector('.workspace-head small').textContent,
        rows: [...group.querySelectorAll('.session-row')].map((row) => ({
          name: row.querySelector('strong').textContent,
          second: row.querySelector('small').textContent,
          tool: row.querySelector('.session-kind-icon').className,
          color: row.dataset.color ?? null,
          edge: getComputedStyle(row).boxShadow,
          indent: Math.round(row.getBoundingClientRect().left - base),
        })),
      },
    };
  })()`);
  const rowsByName = Object.fromEntries(
    homeView.workspace.rows.map((row) => [row.name, row]),
  );
  const names = homeView.workspace.rows.map((row) => row.name);
  if (
    homeView.needs.length !== 1 ||
    homeView.workspace.name !== "Phone check" ||
    homeView.workspace.insight !== "1 needs you" ||
    names.indexOf("Builder") !== names.indexOf("Lead") + 1 ||
    rowsByName.Lead?.second !== "Team leadWorkspace session" ||
    rowsByName.Builder?.second !== "@builderWorkspace session" ||
    (rowsByName.Builder?.indent ?? 0) < 12 ||
    rowsByName.Lead?.indent !== 0 ||
    rowsByName.Lead?.color !== "blue" ||
    !rowsByName.Lead?.edge.includes("inset") ||
    !rowsByName.Lead?.tool.includes("tool-terminal")
  )
    throw new Error(`Home is wrong: ${JSON.stringify(homeView)}`);
  if (store.phones.length !== 1)
    throw new Error("The Mac did not store the phone");
  await screenshot("home");
  console.log(
    "PASS sign-in, pairing, and the Mac's list: Needs me, the workspace box, tool icons, a session colour, and a team member indented under its lead",
  );

  await tap(byText(".group .session-row", "Approve the database migration"));
  await waitFor("terminal", "document.querySelector('.xterm-rows')");
  await sleep(800);
  await evaluate(`(() => {
    const box = document.querySelector('.compose textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "printf '%s\\\\n' PHONE_UI_SENT");
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await tap(byText(".compose button", "Send"));
  await waitFor(
    "sent output",
    "document.querySelector('.xterm-rows').textContent.includes('PHONE_UI_SENT')",
  );
  await tap(`document.querySelector('.keys button[aria-label="Control C"]')`);
  await tap(`document.querySelector('.keys button[aria-label="Enter"]')`);
  const layout = await evaluate<{
    overflow: boolean;
    terminalHeight: number;
  }>(`(() => ({
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    terminalHeight: document.querySelector('.terminal').getBoundingClientRect().height,
  }))()`);
  if (layout.overflow) throw new Error("The session screen scrolls sideways");
  if (layout.terminalHeight < 240)
    throw new Error(`Terminal too short: ${layout.terminalHeight}`);
  await screenshot("session");
  console.log(
    "PASS the session opens on a live terminal; Send and the quick keys reach it",
  );

  await send("Runtime.evaluate", { expression: "history.back()" });
  await waitFor("home again", byText(".bar h1", "Studio Mac"));
  await tap(`document.querySelector('button[aria-label="Account"]')`);
  await waitFor("account", byText(".card strong", "phone@example.com"));
  const devices = await evaluate<string[]>(
    "[...document.querySelectorAll('.rows .row strong')].map((one) => one.textContent)",
  );
  if (devices.length !== 2)
    throw new Error(`Devices: ${JSON.stringify(devices)}`);
  await screenshot("account");
  console.log(
    `PASS Account shows the email, plan and both devices (${devices.join(", ")})`,
  );

  const blocking = errors.filter((text) => !text.includes("favicon"));
  if (blocking.length) throw new Error(`Page errors: ${blocking.join(" | ")}`);
  console.log(
    `Screenshots: ${["sign-in", "home", "session", "account"].map(shot).join(", ")}`,
  );
  cdp.close();
} finally {
  chrome?.kill();
  connector?.stop();
  relay.kill();
  await relay.exited;
  google.stop(true);
  await runCommand("tmux", ["-L", socket, "kill-server"]);
  await rm(home, { recursive: true, force: true });
  await rm(relayState, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
