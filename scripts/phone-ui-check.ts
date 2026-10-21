// The phone app (#53), end to end in a phone-sized headless Chrome: the
// relay (wrangler dev, local D1) serves the built app, a stand-in for Google
// signs the user in, a Mac connector serves a real shell session. The page
// opens a scanned pairing link, signs in, takes an invite code, pairs, finds the
// waiting session in its workspace, and drives it: a message, a quick key, the
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

// The Mac's key goes to a file here, never to the user's Keychain.
process.env.DAEDALUS_REMOTE_VAULT = "file";
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
// A host name, not an IP: passkeys (the app lock) refuse an IP as their site.
const origin = `http://localhost:${port}`;
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
  DEV_MODE: "1",
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
  const admin = async <T>(path: string, body: unknown): Promise<T> =>
    (
      (await (
        await fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ADMIN_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        })
      ).json()) as { data: T }
    ).data;
  const newInvite = async () =>
    (await admin<{ code: string }>("/admin/invites", {})).code;
  const invite = await newInvite();

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
  // A brief longer than the phone's snapshot carries, so the task screen
  // has to fetch the rest.
  const longBrief = `${"Make the phone app ready to ship. ".repeat(12)}BRIEF_END`;
  const task = (await cli([
    "task",
    "create",
    "--workspace",
    workspace.id,
    "--title",
    "Ship the phone app",
    "--description",
    longBrief,
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
    relay: `ws://localhost:${port}`,
    macName: "Studio Mac",
    store,
    handlers: withTeam(
      // As in the app: a change made from a phone tells the phones.
      createDesktopRequestHandlers(context, {
        onMutation: () => connector?.announce(),
      }),
      lead.id,
      member.id,
    ),
    openTerminal: agentTerminalOpener(context),
    lockedRetryMs: 1_000,
  });
  await connector.start();

  // The Mac signs in first, in a browser, as Settings › Remote does. The
  // account has no plan yet, so the relay holds the Mac back.
  for (
    let attempt = 0;
    connector.status !== "waiting_for_phone" && attempt < 100;
    attempt++
  )
    await sleep(100);
  let next = await connector.signInUrl();
  let cookie = "";
  let page = "";
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(next, {
      redirect: "manual",
      headers: cookie ? { Cookie: cookie } : {},
    });
    cookie = (response.headers.get("Set-Cookie") ?? cookie).split(";")[0]!;
    const location = response.headers.get("Location");
    if (!location) {
      page = await response.text();
      break;
    }
    next = new URL(location, next).toString();
  }
  if (!page.includes("Your Mac is signed in"))
    throw new Error(`Mac sign-in: ${page.slice(0, 200)}`);
  for (
    let attempt = 0;
    connector.status !== "locked" && attempt < 100;
    attempt++
  )
    await sleep(100);
  if (connector.lockedBy !== "no_plan")
    throw new Error(`The Mac is ${connector.status}, not waiting for a plan`);
  console.log(
    "PASS the Mac signs in through the browser and waits for its account to get Pro",
  );
  const scanned = pairingUrl(await connector.createPairingOffer());

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
          `Timed out waiting for ${label}. Page: ${await evaluate<string>("document.body.innerText.slice(0, 300) + ' | terminal: ' + (document.querySelector('.xterm-rows')?.textContent ?? '').slice(-400)")}. Errors: ${errors.join(" | ") || "none"}`,
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

  // A link with someone else's token in it signs nobody in.
  await send("Page.navigate", { url: `${origin}/#token=planted-token` });
  await waitFor("sign-in", byText("button", "Continue with Google"));
  if (
    (
      await evaluate<string>("localStorage.getItem('daedalus.phone.v1') ?? ''")
    ).includes("planted-token") ||
    (await evaluate<string>("location.hash")) !== ""
  )
    throw new Error("A token in a link was taken");
  console.log("PASS a #token= link from elsewhere does not sign the phone in");

  // The camera opens the scanned link.
  await send("Page.navigate", { url: scanned });
  await waitFor("sign-in", byText("button", "Continue with Google"));
  if (
    !(await evaluate<string>("document.body.innerText")).includes(
      "finish pairing",
    )
  )
    throw new Error("The scanned code was not kept for after sign-in");
  if ((await evaluate<string>("location.hash")) !== "")
    throw new Error("The pairing code stayed in the address bar");
  const signInText = await evaluate<string>("document.body.innerText");
  if (
    !signInText.includes("Sign in to Daedalus") ||
    !signInText.includes("Daedalus Pro")
  )
    throw new Error(`Sign-in screen: ${signInText.slice(0, 300)}`);
  await screenshot("sign-in");
  console.log(
    "PASS a scanned pairing link opens Sign in to Daedalus, says phone access is Pro, and keeps the code",
  );

  await tap(byText("button", "Continue with Google"));
  // No plan yet: the phone says who is signed in and what Pro is, and takes
  // an invite code before pairing.
  await waitFor(
    "the Pro screen",
    byText("h2", "Phone access needs Daedalus Pro"),
    30_000,
  );
  if (
    (await evaluate<string>(
      "document.querySelector('.signed-in-as strong')?.textContent ?? ''",
    )) !== "phone@example.com"
  )
    throw new Error("The Pro screen does not say who is signed in");
  await evaluate(`(() => {
    const input = document.querySelector('.invite input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(invite.replace("-", "").toLowerCase())});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  // Typed in lower case with no dash, the field shows the code as it is.
  const typedInvite = await evaluate<string>(
    "document.querySelector('.invite input').value",
  );
  if (typedInvite !== invite)
    throw new Error(`The invite field shows ${typedInvite}, not ${invite}`);
  await screenshot("pro");
  await tap(byText("button", "Get Pro with this code"));
  console.log(
    "PASS signed in without a plan, the phone shows who is signed in and what Pro gives, and takes an invite code, formatted as it is typed",
  );
  // A link can come from anywhere, so the phone asks before pairing.
  await waitFor("pairing question", byText("h2", "Pair with"), 30_000);
  if (
    !(await evaluate<string>("document.body.innerText")).includes("Studio Mac")
  )
    throw new Error("The pairing question does not name the Mac");
  if (
    !(await evaluate<string>("document.body.innerText")).includes(
      "Use a different account",
    )
  )
    throw new Error("Pairing does not offer another account");
  await screenshot("pair-ask");
  await tap(byText("button", "Pair"));
  await waitFor("the code to compare", "document.querySelector('.pair-code')");
  await waitFor("the Mac asks", "true");
  for (let attempt = 0; !connector.pairingRequest && attempt < 100; attempt++)
    await sleep(100);
  const shown = (
    await evaluate<string>("document.querySelector('.pair-code').textContent")
  ).replace(/\s/g, "");
  if (!connector.pairingRequest || shown !== connector.pairingRequest.code)
    throw new Error(
      `Codes differ: phone ${shown}, Mac ${connector.pairingRequest?.code}`,
    );
  await screenshot("pair-code");
  await connector.confirmPairing(true);
  console.log(
    "PASS the phone asks before pairing, then shows the same six digits the Mac asks its user to allow",
  );
  await waitFor("paired home", byText(".bar h1", "Studio Mac"), 30_000);
  await waitFor(
    "the Pro badge in the top bar",
    byText(".bar h1 .pro-badge", "Pro"),
  );
  await waitFor(
    "waiting session row",
    byText(".session-row", "Approve the database migration"),
  );
  if ((await evaluate<string>("location.hash")) !== "")
    throw new Error("The session token stayed in the address bar");
  const homeView = await evaluate<{
    needs: string[];
    title: string;
    subtitle: string;
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
      title: document.querySelector('.bar-title h1')?.firstChild?.textContent ?? '',
      subtitle: document.querySelector('.bar-title small')?.textContent ?? '',
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
    homeView.needs.length !== 0 ||
    homeView.title !== "Studio Mac" ||
    homeView.subtitle !== "Connected" ||
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
    "PASS sign-in, pairing, the title bar (Mac name, Connected), and the Mac's list: no separate Needs me, the workspace box, tool icons, a session colour, and a team member indented under its lead",
  );

  // Renaming the Mac (Settings › Remote) reaches the open phone at once.
  connector.setMacName("Desk Mac");
  await waitFor("renamed Mac", byText(".bar h1", "Desk Mac"));
  connector.setMacName("Studio Mac");
  await waitFor("name back", byText(".bar h1", "Studio Mac"));
  console.log("PASS renaming the Mac updates the open phone's title");

  await tap(
    byText(".workspace-group .session-row", "Approve the database migration"),
  );
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
  // Scrolling the keys row presses nothing.
  const beforeSwipe = await evaluate<string>(
    "document.querySelector('.xterm-rows').textContent",
  );
  const start = await evaluate<{ x: number; y: number }>(`(() => {
    const rect = document.querySelector('.keys button[aria-label="2"]').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [start],
  });
  for (let step = 1; step <= 6; step += 1)
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: start.x - step * 20, y: start.y }],
    });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(600);
  if (
    (await evaluate<string>(
      "document.querySelector('.xterm-rows').textContent",
    )) !== beforeSwipe
  )
    throw new Error("Swiping the keys row typed a key");

  // Dragging the terminal scrolls tmux's history; Bottom ends it.
  await evaluate(`(() => {
    const box = document.querySelector('.compose textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "seq 1 300");
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await tap(byText(".compose button", "Send"));
  await waitFor(
    "long output",
    "document.querySelector('.xterm-rows').textContent.includes('300')",
  );
  const drag = async (distance: number) => {
    const from = await evaluate<{ x: number; y: number }>(`(() => {
      const rect = document.querySelector('.terminal').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 + ${distance < 0 ? 100 : -100} };
    })()`);
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [from],
    });
    for (let step = 1; step <= 10; step += 1)
      await send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y: from.y + (distance * step) / 10 }],
      });
    await send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  const copyMode =
    "/\\[\\d+\\/\\d+\\]/.test(document.querySelector('.xterm-rows').textContent)";
  await drag(200);
  await waitFor("tmux history", copyMode);
  if (
    await evaluate<boolean>(
      "document.querySelector('.xterm-rows').textContent.includes('300')",
    )
  )
    throw new Error("Dragging down did not scroll back");
  await waitFor("Bottom button", "document.querySelector('.jump-bottom')");
  await tap("document.querySelector('.jump-bottom')");
  await waitFor("history closed", `!(${copyMode})`);
  await waitFor("Bottom gone", "!document.querySelector('.jump-bottom')");

  // Claude's turn marker draws from the bundled symbol font, not as emoji.
  await evaluate(`(() => {
    const box = document.querySelector('.compose textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, "printf '\\\\342\\\\217\\\\272 MARKED\\\\n'");
    box.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await tap(byText(".compose button", "Send"));
  await waitFor(
    "turn marker",
    "document.querySelector('.xterm-rows').textContent.includes('\u23fa MARKED')",
  );
  const symbols = await evaluate<string>(
    "[...document.fonts].find((face) => face.family.includes('Daedalus Terminal Symbols'))?.status ?? 'missing'",
  );
  if (symbols !== "loaded")
    throw new Error(`The terminal symbol font is ${symbols}`);
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
    "PASS the session opens on a live terminal; the box types into it as it changes, Send presses Enter, keys work, a swipe across them types nothing, a drag on the terminal scrolls its history, and Bottom ends it",
  );

  await send("Runtime.evaluate", { expression: "history.back()" });
  await waitFor("home again", byText(".bar h1", "Studio Mac"));
  await tap(`document.querySelector('button[aria-label="Account"]')`);
  await waitFor("account", byText(".card strong", "phone@example.com"));
  await waitFor("the plan", byText(".card small", "Pro plan ·"));
  const devices = await evaluate<string[]>(
    "[...document.querySelectorAll('.rows .row strong')].map((one) => one.textContent)",
  );
  if (devices.length !== 2)
    throw new Error(`Devices: ${JSON.stringify(devices)}`);
  await screenshot("account");
  console.log(
    `PASS Account shows the email, plan and both devices (${devices.join(", ")})`,
  );

  // The app lock, with a virtual passkey that has PRF, as a phone's does.
  await send("WebAuthn.enable");
  const added = await send<{ authenticatorId?: string; message?: string }>(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf: true,
      },
    },
  );
  if (!added.authenticatorId)
    throw new Error(`No virtual passkey: ${added.message}`);
  await tap(byText("button", "Lock with a passkey"));
  await waitFor("locked", byText(".card strong", "Locked with a passkey"));
  const stored = await evaluate<string>(
    "localStorage.getItem('daedalus.phone.v1')",
  );
  if (stored.includes('"token"') || stored.includes("secretKey"))
    throw new Error("The app lock left the key or token readable");
  await send("Page.reload");
  await waitFor("lock screen", byText("h1", "Daedalus is locked"));
  await screenshot("locked");
  await tap(byText("button", "Unlock"));
  await waitFor("unlocked home", byText(".bar h1", "Studio Mac"), 30_000);
  console.log(
    "PASS the app lock seals the key and sign-in under a passkey; a reload asks for it and the passkey opens the app",
  );

  // The board: the Mac's lanes, a task's own screen, and changes made from
  // the phone landing on the Mac.
  const setValue = (selector: string, value: string, kind: string) =>
    evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(${kind}.prototype, 'value').set.call(element, ${JSON.stringify(value)});
      element.dispatchEvent(new Event(${JSON.stringify(kind === "HTMLSelectElement" ? "change" : "input")}, { bubbles: true }));
    })()`);
  const taskOnMac = async (id: string) =>
    (await cli(["task", "get", id])) as {
      status: string;
      description: string;
    };
  await tap(
    `document.querySelector('.workspace-group .workspace-board-button')`,
  );
  await waitFor(
    "the Mac's board, with the task in Needs me",
    `document.querySelector('.mac-board .board-lane.lane-needs_me .board-card')?.textContent.includes('Ship the phone app')`,
  );
  const board = await evaluate<{
    lanes: string[];
    sessionLine: string;
    edge: string;
  }>(`(() => ({
    lanes: [...document.querySelectorAll('.mac-board .board-lane-header')].map((one) => one.textContent),
    sessionLine: document.querySelector('.mac-board .board-session-row')?.textContent ?? '',
    edge: getComputedStyle(document.querySelector('.mac-board .board-card'), '::before').backgroundColor,
  }))()`);
  if (
    !board.lanes.some((lane) => lane.includes("Needs me")) ||
    !board.sessionLine.includes("needs input") ||
    board.edge === "rgba(0, 0, 0, 0)"
  )
    throw new Error(`The board is not the Mac's: ${JSON.stringify(board)}`);
  await screenshot("board");
  await tap(
    `document.querySelector('.mac-board .board-lane.lane-needs_me .board-card-title')`,
  );
  await waitFor(
    "the task screen",
    byText(".task-head h2", "Ship the phone app"),
  );
  await waitFor(
    "the task's session",
    "document.querySelector('.task-screen .session-row')",
  );
  await setValue(".task-status select", "blocked", "HTMLSelectElement");
  for (
    let attempt = 0;
    attempt < 50 && (await taskOnMac(task.id)).status !== "blocked";
    attempt++
  )
    await sleep(100);
  if ((await taskOnMac(task.id)).status !== "blocked")
    throw new Error("The status set on the phone did not reach the Mac");
  // The snapshot carried the brief's start; the screen shows all of it,
  // and an edit starts from all of it.
  await waitFor("the whole brief", byText(".task-brief", "BRIEF_END"));
  await tap(byText(".task-section-head button", "Edit"));
  const editing = await evaluate<string>(
    "document.querySelector('.task-brief-edit').value",
  );
  if (editing !== longBrief)
    throw new Error(`The brief to edit is not all of it: ${editing.length}`);
  await setValue(
    ".task-brief-edit",
    `${longBrief} Written on the phone.`,
    "HTMLTextAreaElement",
  );
  await tap(byText(".task-section-head button", "Save"));
  await waitFor(
    "the saved brief",
    byText(".task-brief", "Written on the phone."),
  );
  if (
    (await taskOnMac(task.id)).description !==
    `${longBrief} Written on the phone.`
  )
    throw new Error("The brief edited on the phone did not reach the Mac");
  await screenshot("task");
  await evaluate("history.back()");
  await waitFor("back on the board", "document.querySelector('.mac-board')");
  // Capture, as on the Mac: a title and Enter.
  await setValue(".board-capture", "Captured on the phone", "HTMLInputElement");
  await tap(`document.querySelector('.board-capture')`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await waitFor(
    "the captured task in Queued",
    `document.querySelector('.mac-board .board-lane.lane-queued')?.textContent.includes('Captured on the phone')`,
  );
  await tap(`document.querySelector('.mac-board .create-button')`);
  await waitFor("the new task form", byText("button", "Create task"));
  await setValue(
    ".task-screen .field input",
    "Made on the phone",
    "HTMLInputElement",
  );
  await tap(byText(".task-screen button", "Create task"));
  await waitFor("the new task", byText(".task-head h2", "Made on the phone"));
  const listed = (await cli([
    "task",
    "list",
    "--workspace",
    workspace.id,
  ])) as Array<{ title: string }>;
  if (
    !listed.some((item) => item.title === "Made on the phone") ||
    !listed.some((item) => item.title === "Captured on the phone")
  )
    throw new Error("Tasks made on the phone are not on the Mac");
  await evaluate("history.back()");
  await waitFor("the board again", "document.querySelector('.mac-board')");
  console.log(
    "PASS a long brief comes to the phone shortened and the task screen fetches all of it before editing; a workspace's Board is the Mac's board (lanes, card edges, session lines); a task opens with its sessions; its status, brief, a captured task and a new task made on the phone land on the Mac",
  );

  // The plan ends, as a trial does: the phone says Pro is needed, and an
  // invite code on the Account page renews it.
  await admin("/admin/entitlements", {
    email: "phone@example.com",
    status: "expired",
  });
  await evaluate("history.back()");
  await waitFor("blocked home", byText("h2", "No active access"));
  await tap(`document.querySelector('button[aria-label="Account"]')`);
  await waitFor("no plan", byText(".card small", "No Pro plan"));
  await setValue(".invite input", await newInvite(), "HTMLInputElement");
  await screenshot("account-no-plan");
  await tap(byText("button", "Use invite code"));
  await waitFor("renewed plan", byText(".card small", "Pro plan ·"));
  console.log(
    "PASS when the plan ends, the phone says phone access needs Pro, and an invite code on Account renews it",
  );

  const blocking = errors.filter((text) => !text.includes("favicon"));
  if (blocking.length) throw new Error(`Page errors: ${blocking.join(" | ")}`);
  console.log(
    `Screenshots: ${["sign-in", "pair-ask", "pair-code", "home", "session", "account", "locked", "board", "task"].map(shot).join(", ")}`,
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
