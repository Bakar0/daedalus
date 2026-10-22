/**
 * The Claude setup sync, end to end on the kind cluster, with this Mac's
 * real code and a made-up Claude folder (never the user's own): a skill, a
 * command, a plugin, three MCP servers (one remote without a secret, one
 * with a header, one local command), a fake credentials file and a link
 * out of the folder. A cloud Claude launches, and the script checks what
 * reached the pod and what Claude there lists.
 *
 *   bun run scripts/cloud-sync-try.ts           # launch and check
 *   bun run scripts/cloud-sync-try.ts cleanup   # deletes the pod and its volume
 *
 * It runs from a home of its own (~/.daedalus-sync-try-dev, file vault), as
 * user sync-try@test.com on the gateway at http://localhost:8080.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cloudHostId, createApplicationContext } from "@daedalus/core";
import { RemoteSessionHost } from "../packages/core/src/cloud/remote-session-host";

process.env.DAEDALUS_REMOTE_VAULT = "file";
const HOME = join(homedir(), ".daedalus-sync-try-dev");
const CLAUDE = join(HOME, "claude");
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8080";
const EMAIL = "sync-try@test.com";
const WORKSPACE = "sync-try";

const mode = process.argv[2] ?? "check";
const say = (text: string) => console.log(`[sync-try] ${text}`);
let failures = 0;
const check = (ok: boolean, text: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${text}`);
  if (!ok) failures += 1;
};

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

/** The made-up Claude folder this Mac's code copies from. */
async function writeClaudeFolder() {
  await rm(CLAUDE, { recursive: true, force: true });
  await put(
    join(CLAUDE, "skills/sync-try-skill/SKILL.md"),
    "---\nname: sync-try-skill\ndescription: A skill the sync try copied from the Mac.\n---\n\nSay hello.\n",
  );
  await put(
    join(CLAUDE, "commands/sync-try-command.md"),
    "---\ndescription: A command the sync try copied from the Mac.\n---\n\nSay hello.\n",
  );
  await put(join(CLAUDE, ".credentials.json"), '{"claudeAiOauth":"fake"}');
  await put(join(HOME, "outside/SKILL.md"), "outside the Claude folder");
  await symlink(join(HOME, "outside"), join(CLAUDE, "skills/linked-out"));
  const plugin = join(CLAUDE, "plugins/cache/sync-try/greeter/1.0.0");
  await put(
    join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "greeter", version: "1.0.0" }),
  );
  await put(
    join(plugin, "commands/greet.md"),
    "---\ndescription: A plugin command the sync try copied.\n---\n\nGreet.\n",
  );
  await put(
    join(
      CLAUDE,
      "plugins/marketplaces/sync-try/.claude-plugin/marketplace.json",
    ),
    JSON.stringify({
      name: "sync-try",
      owner: { name: "sync try" },
      plugins: [{ name: "greeter", source: "./greeter", version: "1.0.0" }],
    }),
  );
  await put(
    join(CLAUDE, "plugins/known_marketplaces.json"),
    JSON.stringify({
      "sync-try": {
        source: { source: "github", repo: "example/sync-try" },
        installLocation: join(CLAUDE, "plugins/marketplaces/sync-try"),
        lastUpdated: new Date().toISOString(),
      },
    }),
  );
  await put(
    join(CLAUDE, "plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "greeter@sync-try": [
          { scope: "user", installPath: plugin, version: "1.0.0" },
        ],
      },
    }),
  );
  await put(
    join(CLAUDE, "settings.json"),
    JSON.stringify({
      enabledPlugins: { "greeter@sync-try": true },
      env: { SYNC_TRY_SECRET: "must-not-reach-the-pod" },
    }),
  );
  await put(
    join(CLAUDE, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        context7: { type: "http", url: "https://mcp.context7.com/mcp" },
        keyed: {
          type: "http",
          url: "https://mcp.example.com/",
          headers: { Authorization: "Bearer must-not-reach-the-pod" },
        },
        local: { type: "stdio", command: "npx", args: ["something"] },
      },
    }),
  );
}

if (mode === "check") await writeClaudeFolder();
const logs: { event: string; fields?: Record<string, unknown> }[] = [];
const context = await createApplicationContext({
  env: { ...process.env, DAEDALUS_HOME: HOME, CLAUDE_CONFIG_DIR: CLAUDE },
  cloud: { log: (event, fields) => logs.push({ event, fields }) },
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
    if (tries > 90)
      throw new Error(`the runner never answered: ${unavailable}`);
    await Bun.sleep(2_000);
  }
  say("pod ready");
  if (!(host instanceof RemoteSessionHost)) throw new Error("not a cloud host");

  const session = await context.agents.spawn({
    workspace: workspace.id,
    host: host.id,
    name: "sync try",
  });
  say(`cloud Claude session ${session.id.slice(0, 8)} is running`);
  const line = logs.find((one) => one.event === "cloud_claude_sync");
  console.log(`[sync-try] log line: ${JSON.stringify(line?.fields)}`);

  const pod = async (...argv: string[]) =>
    (await host.run(argv[0]!, argv.slice(1))).stdout;
  const files = await pod("find", ".home/.claude", "-type", "f");
  check(
    files.includes(".home/.claude/skills/sync-try-skill/SKILL.md"),
    "the user's skill is in the pod",
  );
  check(
    files.includes(".home/.claude/commands/sync-try-command.md"),
    "the user's command is in the pod",
  );
  check(
    files.includes(".home/.claude/skills/daedalus-team"),
    "the Daedalus team skill is in the pod",
  );
  check(
    !files.includes(".home/.claude/skills/daedalus-control") &&
      !files.includes(".home/.claude/skills/daedalus-orchestration"),
    "Daedalus control and orchestration are not",
  );
  check(!files.includes("linked-out"), "the link out of ~/.claude is not");
  check(
    !(await host.exists(".home/.claude/.credentials.json")),
    "no credentials file in the pod",
  );
  const grep = await host.run("grep", [
    "-rl",
    "must-not-reach-the-pod",
    ".home",
  ]);
  check(
    grep.stdout.trim() === "",
    "no secret value anywhere in the pod's home",
  );

  const mcp = await host.run("claude", ["mcp", "list"]);
  console.log(mcp.stdout.trim());
  check(
    /context7/.test(mcp.stdout) && !/keyed|local/.test(mcp.stdout),
    "Claude in the pod lists the remote MCP server, and only it",
  );
  const plugins = await host.run("claude", ["plugin", "list"]);
  console.log(plugins.stdout.trim() || plugins.stderr.trim());
  // `plugin list` also looks for the plugin's source in its marketplace's
  // clone, which the pod does not have; sessions load it from the cache,
  // which the slash menu below shows.
  check(
    /greeter@sync-try/.test(plugins.stdout),
    "Claude in the pod lists the plugin",
  );

  // Claude's own list of skills and commands: its slash menu, filtered.
  await Bun.sleep(8_000);
  await host.sendKeys(session.tmuxSession, ["Escape"]);
  await Bun.sleep(1_000);
  await host.sendKeys(session.tmuxSession, ["Escape"]);
  for (const [typed, expected] of [
    [
      "/sync-try",
      /sync-try-skill[\s\S]*sync-try-command|sync-try-command[\s\S]*sync-try-skill/,
    ],
    // A plugin command shows only when the session loaded the plugin.
    ["/greet", /greeter:greet/],
  ] as const) {
    // Typed without Enter, so the menu stays open.
    await host.sendKeys(session.tmuxSession, [typed]);
    await Bun.sleep(2_000);
    const screen = await host.capture(session.tmuxSession);
    console.log(
      screen
        .split("\n")
        .filter((row) => row.trim())
        .slice(-12)
        .join("\n"),
    );
    check(expected.test(screen), `Claude's slash menu shows ${typed}`);
    await host.sendKeys(session.tmuxSession, ["C-u"]);
  }

  // A second launch copies nothing new.
  logs.length = 0;
  await context.agents.spawn({
    workspace: workspace.id,
    host: host.id,
    name: "sync try again",
  });
  const again = logs.find((one) => one.event === "cloud_claude_sync")?.fields;
  check(
    again?.written === 0,
    `a second launch writes nothing (${JSON.stringify(again?.written)})`,
  );
  console.log(
    failures ? `FAIL: ${failures} checks failed` : "PASS: all checks",
  );
  process.exit(failures ? 1 : 0);
} finally {
  cloud.close();
}
