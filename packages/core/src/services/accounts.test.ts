import { chmod, lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { keychainReadCommand, pathExists } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  AccountService,
  accountConfig,
  accountEnvironment,
  createApplicationContext,
  DaedalusError,
  loadConfig,
  parseAwsCallerIdentity,
  parseClaudeAuthStatus,
  parseCodexAccount,
  parseCodexLoginStatus,
  recordSessionCost,
} from "../index";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly launches: TmuxLaunch[] = [];
  async probe() {
    return "tmux 3.7c";
  }
  async createSession(launch: TmuxLaunch) {
    this.launches.push(launch);
    this.sessions.add(launch.session);
  }
  async hasSession(session: string) {
    return this.sessions.has(session);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async attach() {
    return 0;
  }
  screen = "Claude Code v2.1.289\nshift+tab to cycle";
  readonly keys: string[][] = [];
  async capture() {
    return this.screen;
  }
  async sendKeys(_session: string, keys: string[]) {
    this.keys.push(keys);
  }
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    return false;
  }
}

/**
 * A stand-in `claude` whose `auth status` answers from the folder it is
 * pointed at: the default account (no `CLAUDE_CONFIG_DIR`) is signed in, and
 * a profile is signed in once a `signed-in` file exists in its folder.
 */
async function fakeClaude(home: string): Promise<string> {
  const path = join(home, "fake-claude");
  await Bun.write(
    path,
    `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -z "$CLAUDE_CONFIG_DIR" ] || [ -f "$CLAUDE_CONFIG_DIR/signed-in" ]; then
    printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"me@example.com","subscriptionType":"max"}\\n'
    exit 0
  fi
  printf '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\\n'
  exit 1
fi
exit 0
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function setup(home: string) {
  const claude = await fakeClaude(home);
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      agents: { claude: { executable: claude, args: [] } },
    }),
  );
  const tmux = new FakeTmux();
  const context = await createApplicationContext({
    env: {
      DAEDALUS_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude-default"),
      DAEDALUS_AGENTS_HOME: join(home, "agents"),
    },
    tmux,
  });
  return { context, tmux };
}

describe("provider sign-in status", () => {
  test("reads Claude's structured status", () => {
    expect(
      parseClaudeAuthStatus({
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "me@example.com",
          orgName: "Acme",
          subscriptionType: "team",
        }),
        stderr: "",
      }),
    ).toEqual({
      state: "signed-in",
      method: "Claude subscription",
      email: "me@example.com",
      organization: "Acme",
      plan: "team",
    });
    expect(
      parseClaudeAuthStatus({
        exitCode: 1,
        stdout:
          '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
        stderr: "",
      }).state,
    ).toBe("signed-out");
  });

  test("never calls a Bedrock setup or an old Claude signed out", () => {
    expect(
      parseClaudeAuthStatus({
        exitCode: 1,
        stdout: '{"loggedIn":false,"apiProvider":"bedrock"}',
        stderr: "",
      }),
    ).toEqual({ state: "signed-in", method: "Amazon Bedrock" });
    expect(
      parseClaudeAuthStatus({
        exitCode: 1,
        stdout: "",
        stderr: "error: unknown command 'auth'",
      }),
    ).toEqual({ state: "unknown", detail: "error: unknown command 'auth'" });
    // JSON that is not a status at all is not a "no".
    expect(
      parseClaudeAuthStatus({
        exitCode: 0,
        stdout: '{"models":[]}',
        stderr: "",
      }).state,
    ).toBe("unknown");
  });

  test("reads AWS's answer for a Bedrock account's profile", () => {
    expect(
      parseAwsCallerIdentity({
        exitCode: 0,
        stdout: JSON.stringify({
          UserId: "AROAEXAMPLE:me@example.com",
          Account: "123456789012",
          Arn: "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Dev_abc/me@example.com",
        }),
        stderr: "",
      }),
    ).toEqual({
      state: "signed-in",
      method: "Amazon Bedrock",
      email: "me@example.com",
      organization: "AWS 123456789012",
    });
    // An expired or missing SSO token is a sign-in away from working.
    for (const stderr of [
      "Error when retrieving token from sso: Token has expired and refresh failed",
      "Error loading SSO Token: Token for work does not exist",
    ])
      expect(
        parseAwsCallerIdentity({ exitCode: 255, stdout: "", stderr }),
      ).toEqual({
        state: "signed-out",
        method: "Amazon Bedrock",
      });
    // Anything else is shown, not treated as signed out.
    expect(
      parseAwsCallerIdentity({
        exitCode: 255,
        stdout: "",
        stderr: "The config profile (nope) could not be found",
      }),
    ).toEqual({
      state: "unknown",
      method: "Amazon Bedrock",
      detail: "The config profile (nope) could not be found",
    });
  });

  test("reads Codex's text status without keeping an API key", () => {
    expect(
      parseCodexLoginStatus({
        exitCode: 0,
        stdout: "",
        stderr: "Logged in using ChatGPT\n",
      }),
    ).toEqual({ state: "signed-in", method: "ChatGPT" });
    const apiKey = parseCodexLoginStatus({
      exitCode: 0,
      stdout: "Logged in using an API key - sk-proj-***ABCD\n",
      stderr: "",
    });
    expect(apiKey).toEqual({ state: "signed-in", method: "API key" });
    expect(JSON.stringify(apiKey)).not.toContain("sk-");
    expect(
      parseCodexLoginStatus({
        exitCode: 1,
        stdout: "Not logged in\n",
        stderr: "",
      }).state,
    ).toBe("signed-out");
    expect(
      parseCodexLoginStatus({ exitCode: 2, stdout: "", stderr: "boom" }).state,
    ).toBe("unknown");
  });

  test("reads the Codex app server's account detail", () => {
    expect(
      parseCodexAccount({
        account: { type: "chatgpt", email: "me@example.com", planType: "plus" },
      }),
    ).toEqual({ method: "ChatGPT", email: "me@example.com", plan: "plus" });
    expect(parseCodexAccount({ account: null })).toBeUndefined();
  });
});

describe("account profiles", () => {
  test("point a provider at the profile's folder and leave the default alone", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const config = await loadConfig({ DAEDALUS_HOME: home });
      expect(accountEnvironment(config, "claude", null)).toEqual({});
      expect(accountEnvironment(config, "claude", "default")).toEqual({});
      expect(accountConfig(config, "claude", null)).toBe(config);
      const folder = join(home, "accounts", "claude", "personal-1a2b");
      expect(accountEnvironment(config, "claude", "personal-1a2b")).toEqual({
        CLAUDE_CONFIG_DIR: folder,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: folder,
      });
      const codex = join(home, "accounts", "codex", "side-0000");
      expect(accountEnvironment(config, "codex", "side-0000")).toEqual({
        CODEX_HOME: codex,
        CODEX_SQLITE_HOME: codex,
      });
      const scoped = accountConfig(config, "codex", "side-0000");
      expect(scoped.codexHome).toBe(codex);
      expect(scoped.codexSessionsDirectory).toBe(join(codex, "sessions"));
      expect(scoped.claudeHome).toBe(config.claudeHome);
    });
  });

  test("a new profile is an empty folder with Daedalus's skills linked in", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      expect(profile).toMatchObject({ provider: "claude", name: "Personal" });
      expect(profile.id).toMatch(/^personal-[0-9a-f]{4}$/);
      const folder = join(home, "accounts", "claude", profile.id);
      // Onboarding is marked done, and that is all that is written.
      expect(await Bun.file(join(folder, ".claude.json")).json()).toEqual({
        hasCompletedOnboarding: true,
      });
      expect(await pathExists(join(folder, "settings.json"))).toBe(false);
      const link = join(folder, "skills", "daedalus-control");
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readlink(link)).toBe(
        join(home, "skills", "daedalus-control"),
      );
      // Stored, and read back by the next process.
      const reloaded = await loadConfig({ DAEDALUS_HOME: home });
      expect(reloaded.accounts.map((entry) => entry.id)).toEqual([profile.id]);
      await expect(context.accounts.add("claude", "personal")).rejects.toThrow(
        "already a Claude account named",
      );
      await expect(context.accounts.add("claude", "Default")).rejects.toThrow(
        DaedalusError,
      );
      context.close();
    });
  });

  test("a session starts on the workspace's default account and keeps it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, tmux } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      const folder = join(home, "accounts", "claude", profile.id);
      await Bun.write(join(folder, "signed-in"), "");
      const workspace = await context.workspaces.create({ name: "Side" });
      await context.workspaces.update(workspace.id, {
        defaultClaudeAccount: "personal",
      });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      expect(agent.account).toBe(profile.id);
      expect(tmux.launches[0]!.env).toMatchObject({
        CLAUDE_CONFIG_DIR: folder,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: folder,
      });
      // The default account is still one choice away, and sets nothing.
      const other = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        account: "default",
      });
      expect(other.account).toBeNull();
      expect(tmux.launches[1]!.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      // A restore points the provider at the same folder again.
      tmux.sessions.clear();
      await context.agents.archive(agent.id);
      await context.agents.restore(agent.id);
      expect(tmux.launches.at(-1)!.env).toMatchObject({
        CLAUDE_CONFIG_DIR: folder,
      });
      context.close();
    });
  });

  test("refuses to start on a signed-out account instead of opening a dead terminal", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, tmux } = await setup(home);
      await context.accounts.add("claude", "Work");
      const workspace = await context.workspaces.create({ name: "Office" });
      const refusal = await context.agents
        .spawn({ workspace: workspace.id, provider: "claude", account: "Work" })
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(DaedalusError);
      expect((refusal as DaedalusError).code).toBe("DEPENDENCY");
      expect((refusal as DaedalusError).message).toContain(
        "not signed in on the Work account",
      );
      expect(tmux.launches).toHaveLength(0);
      // Nothing was left behind for the refused session.
      expect(context.repositories.listAgents()).toHaveLength(0);
      context.close();
    });
  });

  test("status reports each account, and removal is refused while a session runs on it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      const folder = join(home, "accounts", "claude", profile.id);
      const statuses = await context.accounts.status({ provider: "claude" });
      expect(
        statuses.map(({ account, name, state, email }) => ({
          account,
          name,
          state,
          email,
        })),
      ).toEqual([
        {
          account: "default",
          name: "Default",
          state: "signed-in",
          email: "me@example.com",
        },
        {
          account: profile.id,
          name: "Personal",
          state: "signed-out",
          email: undefined,
        },
      ]);

      await Bun.write(join(folder, "signed-in"), "");
      const workspace = await context.workspaces.create({ name: "Side" });
      await context.workspaces.update(workspace.id, {
        defaultClaudeAccount: profile.id,
      });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        account: "Personal",
      });
      await expect(
        context.accounts.remove("claude", "Personal"),
      ).rejects.toThrow("Stop or archive it before removing the account");
      // A stopped session no longer holds the account.
      await context.agents.stop(agent.id, true);
      await context.accounts.remove("claude", "Personal");
      expect(await pathExists(folder)).toBe(false);
      expect(
        (await context.workspaces.get(workspace.id)).defaultClaudeAccount,
      ).toBeNull();
      // Archived afterwards, it cannot come back on an account that is gone.
      await context.agents.archive(agent.id);
      await expect(context.agents.restore(agent.id)).rejects.toThrow(
        "which was removed",
      );
      context.close();
    });
  });

  test("the usage footer has an entry per account and keeps a reading after its session ends", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      await Bun.write(
        join(home, "accounts", "claude", profile.id, "signed-in"),
        "",
      );
      const workspace = await context.workspaces.create({ name: "Side" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        account: profile.id,
      });
      const resets = Math.floor(Date.now() / 1_000) + 3_600;
      await Bun.write(
        join(home, "telemetry", `${agent.id}.json`),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          rate_limits: {
            five_hour: { used_percentage: 21, resets_at: resets },
          },
        }),
      );
      const usage = (await context.telemetry.read()).providerUsage;
      expect(
        usage.map((item) => [item.account ?? "default", item.windows.length]),
      ).toEqual([
        ["default", 0],
        [profile.id, 1],
      ]);
      context.close();

      // Another process, the session gone: the reading is still there until
      // its window resets.
      const later = await createApplicationContext({
        env: {
          DAEDALUS_HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "claude-default"),
          DAEDALUS_AGENTS_HOME: join(home, "agents"),
        },
        tmux: new FakeTmux(),
      });
      later.repositories.deleteAgent(agent.id);
      const kept = (await later.telemetry.read()).providerUsage.find(
        (item) => item.account === profile.id,
      );
      expect(kept?.windows).toEqual([
        {
          label: "5h",
          usedPercent: 21,
          resetsAt: new Date(resets * 1_000).toISOString(),
        },
      ]);
      later.close();
    });
  });

  test("a usage-billed account shows its estimated spend, a plan account does not", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const keychain = { write: async () => {}, remove: async () => {} };
      const accounts = new AccountService(
        context.config,
        context.repositories,
        keychain,
      );
      const billed = await accounts.add("claude", "API", "api-key");
      const plan = await accounts.add("claude", "Personal");
      for (const profile of [billed, plan])
        await Bun.write(
          join(home, "accounts", "claude", profile.id, "signed-in"),
          "",
        );
      const workspace = await context.workspaces.create({ name: "Spend" });
      const spawn = (account: string) =>
        context.agents.spawn({
          workspace: workspace.id,
          provider: "claude",
          account,
        });
      const first = await spawn(billed.id);
      const second = await spawn(billed.id);
      const onPlan = await spawn(plan.id);
      const now = new Date();
      await recordSessionCost(home, first.id, 1.25, now);
      await recordSessionCost(home, second.id, 0.5, now);
      await recordSessionCost(home, onPlan.id, 9, now);
      for (const [agent, total] of [
        [first, 1.25],
        [onPlan, 9],
      ] as const)
        await Bun.write(
          join(home, "telemetry", `${agent.id}.json`),
          JSON.stringify({
            observedAt: now.toISOString(),
            model: { display_name: "Opus" },
            cost: { total_cost_usd: total },
          }),
        );

      const snapshot = await context.telemetry.read();
      const footer = (account: string) =>
        snapshot.providerUsage.find((item) => item.account === account);
      expect(footer(billed.id)).toMatchObject({
        billing: "usage",
        cost: { todayUsd: 1.75, monthUsd: 1.75 },
      });
      // On a plan the estimate is a price nobody pays, so it is not shown.
      expect(footer(plan.id)?.billing).toBeUndefined();
      expect(footer(plan.id)?.cost).toBeUndefined();
      const session = (id: string) =>
        snapshot.sessionTelemetry.find((item) => item.sessionId === id);
      expect(session(first.id)?.costUsd).toBe(1.25);
      expect(session(onPlan.id)?.costUsd).toBeUndefined();
      context.close();
    });
  });

  test("an Enterprise seat shows this month's estimated credits", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // A Claude whose default account is a Claude Enterprise seat.
      const claude = join(home, "fake-claude-enterprise");
      await Bun.write(
        claude,
        `#!/bin/sh
printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"enterprise"}\\n'
`,
      );
      await chmod(claude, 0o755);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: claude, args: [] } },
        }),
      );
      const context = await createApplicationContext({
        env: {
          DAEDALUS_HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "claude-default"),
          DAEDALUS_AGENTS_HOME: join(home, "agents"),
        },
        tmux: new FakeTmux(),
      });
      const workspace = await context.workspaces.create({ name: "Org" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      await recordSessionCost(home, agent.id, 2.5);
      await Bun.write(
        join(home, "telemetry", `${agent.id}.json`),
        JSON.stringify({
          observedAt: new Date().toISOString(),
          model: { display_name: "Opus" },
          cost: { total_cost_usd: 2.5 },
        }),
      );
      const snapshot = await context.telemetry.read();
      expect(
        snapshot.providerUsage.find((item) => item.provider === "claude"),
      ).toMatchObject({
        billing: "credits",
        windows: [],
        cost: { todayUsd: 2.5, monthUsd: 2.5 },
      });
      expect(snapshot.sessionTelemetry[0]?.costUsd).toBe(2.5);
      context.close();
    });
  });

  test("a workspace can be created with a default account", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      const workspace = await context.workspaces.create({
        name: "Side",
        defaultClaudeAccount: "personal",
      });
      expect(workspace.defaultClaudeAccount).toBe(profile.id);
      expect(workspace.defaultCodexAccount).toBeNull();
      // A name with no account behind it refuses before a folder is made.
      await expect(
        context.workspaces.create({
          name: "Other",
          defaultClaudeAccount: "nobody",
        }),
      ).rejects.toThrow("No Claude account named 'nobody'");
      expect(await pathExists(join(home, "workspaces", "other"))).toBe(false);
      context.close();
    });
  });

  test("a session that stops on a question at startup stays open and asks for the user", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, tmux } = await setup(home);
      // A consumer account's new terms: not Daedalus's to answer.
      tmux.screen = [
        "Updates to Consumer Terms and Policies",
        "❯ 1. Accept terms · Help improve our AI models: ON",
        "  2. Accept terms · Help improve our AI models: OFF",
        "Enter to confirm · Esc to cancel",
      ].join("\n");
      const workspace = await context.workspaces.create({ name: "Terms" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
      });
      expect(agent.status).toBe("running");
      expect(tmux.sessions.has(agent.tmuxSession)).toBe(true);
      expect(tmux.keys).toEqual([]);
      await Bun.sleep(50);
      expect(
        JSON.stringify(context.activity.attentionFor(agent.id)?.reasons),
      ).toContain("Claude is asking something before it starts");
      context.close();
    });
  });

  test("an API-key account keeps its key in the Keychain and points Claude at it", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const keychain = new Map<string, string>();
      const accounts = new AccountService(
        context.config,
        context.repositories,
        {
          write: async (service, account, secret) => {
            keychain.set(`${service}|${account}`, secret);
          },
          remove: async (service, account) => {
            keychain.delete(`${service}|${account}`);
          },
        },
      );
      const profile = await accounts.add("claude", "Work API", "api-key");
      expect(profile.kind).toBe("api-key");
      const folder = join(home, "accounts", "claude", profile.id);
      await expect(
        accounts.setApiKey("claude", "Work API", "not-a-key"),
      ).rejects.toThrow("does not look like an Anthropic API key");
      // A login is not how this account authenticates.
      expect(() => accounts.signInCommand("claude", "Work API")).toThrow(
        "uses an API key",
      );

      const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
      await accounts.setApiKey("claude", "Work API", `  ${key}\n`);
      expect(keychain.get(`Daedalus Claude API key|${folder}`)).toBe(key);
      const settings = await Bun.file(join(folder, "settings.json")).json();
      expect(settings).toEqual({
        apiKeyHelper: keychainReadCommand("Daedalus Claude API key", folder),
      });
      // No file Daedalus wrote holds the key.
      expect(JSON.stringify(settings)).not.toContain(key);
      expect(await Bun.file(join(home, "config.json")).text()).not.toContain(
        key,
      );

      await accounts.signOut("claude", "Work API");
      expect(keychain.size).toBe(0);
      expect(await Bun.file(join(folder, "settings.json")).json()).toEqual({});
      context.close();
    });
  });

  test("Claude's sign-in can be its subscription, SSO or the Console", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      expect(context.accounts.signInCommand("claude").args).toEqual([
        "auth",
        "login",
      ]);
      expect(
        context.accounts.signInCommand("claude", null, "sso").args,
      ).toEqual(["auth", "login", "--sso"]);
      expect(
        context.accounts.signInCommand("claude", null, "console").args,
      ).toEqual(["auth", "login", "--console"]);
      context.close();
    });
  });

  test("an account remembers how it signs in, so Sign in needs no choice", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      await context.accounts.add("claude", "Work", "login", "sso");
      expect(context.accounts.signInCommand("claude", "Work").args).toEqual([
        "auth",
        "login",
        "--sso",
      ]);
      // A one-off choice still wins over the stored one.
      expect(
        context.accounts.signInCommand("claude", "Work", "console").args,
      ).toEqual(["auth", "login", "--console"]);
      // The default account has one too, and it survives a restart.
      await context.accounts.setLogin("claude", "default", "console");
      expect(context.accounts.signInCommand("claude").args).toEqual([
        "auth",
        "login",
        "--console",
      ]);
      const reloaded = await loadConfig({ DAEDALUS_HOME: home });
      expect(reloaded.defaultLogins).toEqual({ claude: "console" });
      expect(reloaded.accounts[0]?.login).toBe("sso");
      expect(
        context.accounts.list().find((item) => item.name === "Work")?.login,
      ).toBe("sso");
      await expect(
        context.accounts.setLogin("codex", "default", "sso"),
      ).rejects.toThrow("Only Claude has more than one login");
      context.close();
    });
  });

  test("Remove can archive the sessions running on an account instead of refusing", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context } = await setup(home);
      const profile = await context.accounts.add("claude", "Personal");
      await Bun.write(
        join(home, "accounts", "claude", profile.id, "signed-in"),
        "",
      );
      const workspace = await context.workspaces.create({ name: "Side" });
      const agent = await context.agents.spawn({
        workspace: workspace.id,
        provider: "claude",
        account: profile.id,
        name: "Accept terms",
      });
      await expect(
        context.accounts.remove("claude", "Personal"),
      ).rejects.toThrow("'Accept terms' is running on 'Personal'");
      await context.accounts.remove("claude", "Personal", {
        archiveSessions: true,
      });
      expect((await context.agents.get(agent.id)).archivedAt).not.toBeNull();
      expect(context.config.accounts).toEqual([]);
      context.close();
    });
  });

  test("a Bedrock account points Claude at Bedrock and signs in through AWS SSO", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // A stand-in `aws` that is signed in once a marker file exists, and
      // records the arguments it was asked with.
      const aws = join(home, "fake-aws");
      await Bun.write(
        aws,
        `#!/bin/sh
echo "$@" >> "${home}/aws-calls"
if [ -f "${home}/aws-signed-in" ]; then
  printf '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Dev_abc/me@example.com"}\n'
  exit 0
fi
echo "Error loading SSO Token: Token for work does not exist" >&2
exit 255
`,
      );
      await chmod(aws, 0o755);
      const claude = await fakeClaude(home);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { claude: { executable: claude, args: [] } },
          awsExecutable: aws,
        }),
      );
      const context = await createApplicationContext({
        env: {
          DAEDALUS_HOME: home,
          CLAUDE_CONFIG_DIR: join(home, "claude-default"),
          DAEDALUS_AGENTS_HOME: join(home, "agents"),
        },
        tmux: new FakeTmux(),
      });

      await expect(
        context.accounts.add("claude", "Bedrock", "bedrock"),
      ).rejects.toThrow("needs the AWS profile");
      // Both values end up in a command Claude runs through a shell.
      await expect(
        context.accounts.add("claude", "Bedrock", "bedrock", undefined, {
          profile: "work; rm -rf ~",
          region: "us-east-1",
        }),
      ).rejects.toThrow("characters AWS does not use");
      await expect(
        context.accounts.add("codex", "Bedrock", "bedrock", undefined, {
          profile: "work",
          region: "us-east-1",
        }),
      ).rejects.toThrow("Bedrock accounts are for Claude");

      const profile = await context.accounts.add(
        "claude",
        "Bedrock",
        "bedrock",
        undefined,
        { profile: " work ", region: "us-east-1" },
      );
      expect(profile.aws).toEqual({ profile: "work", region: "us-east-1" });
      const folder = join(home, "accounts", "claude", profile.id);
      expect(await Bun.file(join(folder, "settings.json")).json()).toEqual({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "work",
          AWS_REGION: "us-east-1",
        },
        awsAuthRefresh: "aws sso login --profile work",
      });

      // Signed out until AWS says the profile's credentials work.
      let [status] = await context.accounts.status({
        provider: "claude",
        account: "Bedrock",
      });
      expect(status).toMatchObject({
        kind: "bedrock",
        aws: { profile: "work", region: "us-east-1" },
        state: "signed-out",
      });
      expect(await Bun.file(join(home, "aws-calls")).text()).toContain(
        "sts get-caller-identity --output json --profile work --region us-east-1",
      );
      await Bun.write(join(home, "aws-signed-in"), "");
      [status] = await context.accounts.status({
        provider: "claude",
        account: "Bedrock",
      });
      expect(status).toMatchObject({
        state: "signed-in",
        method: "Amazon Bedrock",
        email: "me@example.com",
      });

      const signIn = context.accounts.signInCommand("claude", "Bedrock");
      expect(signIn.executable).toBe(aws);
      expect(signIn.args).toEqual(["sso", "login", "--profile", "work"]);
      // Signing out of AWS SSO would end every SSO session on the Mac.
      expect(() =>
        context.accounts.signOutCommand("claude", "Bedrock"),
      ).toThrow("every SSO session");
      await expect(
        context.accounts.setLogin("claude", "Bedrock", "sso"),
      ).rejects.toThrow("uses Bedrock");

      // Changing the profile keeps any other setting the user added.
      await Bun.write(
        join(folder, "settings.json"),
        JSON.stringify({
          ...(await Bun.file(join(folder, "settings.json")).json()),
          env: {
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_PROFILE: "work",
            AWS_REGION: "us-east-1",
            ANTHROPIC_MODEL: "us.anthropic.claude-opus",
          },
          theme: "dark",
        }),
      );
      await context.accounts.setAws("claude", "Bedrock", {
        profile: "prod",
        region: "eu-west-1",
      });
      expect(await Bun.file(join(folder, "settings.json")).json()).toEqual({
        env: {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "prod",
          AWS_REGION: "eu-west-1",
          ANTHROPIC_MODEL: "us.anthropic.claude-opus",
        },
        awsAuthRefresh: "aws sso login --profile prod",
        theme: "dark",
      });
      const reloaded = await loadConfig({ DAEDALUS_HOME: home });
      expect(reloaded.accounts[0]).toMatchObject({
        kind: "bedrock",
        aws: { profile: "prod", region: "eu-west-1" },
      });

      // Removing it leaves the AWS login alone.
      await Bun.write(join(home, "aws-calls"), "");
      await context.accounts.remove("claude", "Bedrock");
      expect(await Bun.file(join(home, "aws-calls")).text()).toBe("");
      expect(await pathExists(folder)).toBe(false);
      context.close();
    });
  });
});
