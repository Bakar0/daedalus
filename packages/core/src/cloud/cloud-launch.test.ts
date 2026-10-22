import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient } from "@daedalus/platform";
import type { RunnerLaunch } from "@daedalus/remote-protocol";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import { cloudHostId, createApplicationContext } from "../index";
import type { RunnerTransport } from "./link";
import { RemoteSessionHost } from "./remote-session-host";

class NoTmux implements TmuxClient {
  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
  async probe() {
    return "tmux 3.7c";
  }
  async createSession() {}
  async hasSession() {
    return false;
  }
  async listSessions() {
    return [];
  }
  async attach() {
    return 0;
  }
  async capture() {
    return "";
  }
  async sendKeys() {}
  async send() {}
  async stop() {}
  async killServer() {
    return false;
  }
}

/** A pod's runner in memory: its files, its sessions and their launches. */
class FakePod {
  readonly files = new Map<string, string>();
  readonly launches: RunnerLaunch[] = [];
  readonly live = new Set<string>();
  writes = 0;

  readonly transport: RunnerTransport = {
    unavailable: async () => undefined,
    request: (async (_workspaceId: string, method: string, params: never) => {
      const p = params as Record<string, unknown>;
      switch (method) {
        case "host.probe":
          return { version: "test" };
        case "host.start": {
          const launch = params as RunnerLaunch;
          this.launches.push(launch);
          this.live.add(launch.session);
          return null;
        }
        case "host.isLive":
          return this.live.has(p.session as string);
        case "host.listLive":
          return [...this.live];
        case "host.capture":
          return "Claude Code v2.1.303\nshift+tab to cycle";
        case "host.send":
        case "host.sendKeys":
        case "host.stop":
          return null;
        case "fs.read": {
          const text = this.files.get(p.path as string);
          return text === undefined
            ? null
            : { base64: Buffer.from(text).toString("base64") };
        }
        case "fs.write":
          this.writes += 1;
          for (const file of p.files as { path: string; base64: string }[])
            this.files.set(
              file.path,
              Buffer.from(file.base64, "base64").toString("utf8"),
            );
          return null;
      }
      throw new Error(`unexpected ${method}`);
    }) as RunnerTransport["request"],
  };
}

const AWS_CONFIG = `[sso-session corp]
sso_start_url = https://d-1234567890.awsapps.com/start
sso_region = us-east-2

[profile bedrock]
sso_session = corp
sso_account_id = 111122223333
sso_role_name = Bedrock
region = us-east-1

[profile keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
`;

const setUp = async (home: string) => {
  const context = await createApplicationContext({
    env: { DAEDALUS_HOME: home },
    tmux: new NoTmux(),
    cloud: {
      awsConfig: async () => AWS_CONFIG,
      apiKey: async (profile) =>
        profile.name === "Keys" ? "sk-ant-test-key" : undefined,
    },
  });
  const workspace = await context.workspaces.create({ name: "Cloud" });
  const cloudId = crypto.randomUUID();
  context.repositories.setCloudOwner({
    gatewayUrl: "https://gateway.test",
    userId: "u1",
  });
  context.repositories.linkCloudWorkspace(workspace.id, cloudId);
  const pod = new FakePod();
  context.hosts.register(new RemoteSessionHost(cloudId, pod.transport));
  return { context, workspace, pod, hostId: cloudHostId(cloudId) };
};

describe("cloud launch seeding", () => {
  test("a cloud Claude starts with onboarding done and the workspace trusted", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      pod.files.set(
        ".home/.claude.json",
        JSON.stringify({ oauthAccount: { emailAddress: "a@b.c" } }),
      );
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: hostId,
      });
      expect(session.status).toBe("running");
      const state = JSON.parse(pod.files.get(".home/.claude.json")!);
      expect(state).toMatchObject({
        oauthAccount: { emailAddress: "a@b.c" },
        hasCompletedOnboarding: true,
        projects: { "/workspace": { hasTrustDialogAccepted: true } },
      });
      expect(JSON.parse(pod.files.get(".home/.claude/settings.json")!)).toEqual(
        { theme: "dark" },
      );
      expect(pod.writes).toBe(1);

      // A second launch finds it all there and writes nothing.
      await context.agents.spawn({ workspace: workspace.id, host: hostId });
      expect(pod.writes).toBe(1);
      context.close();
    });
  });

  test("this Mac's approval of the organization's settings goes to the pod", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      const consent = {
        version: 1,
        records: {
          "org-1": {
            accountUuid: "acc-1",
            dangerousSettingsHash: "f".repeat(64),
            updatedAt: 5,
          },
        },
      };
      await Bun.write(
        join(context.config.claudeHome, "remote-settings-consent.json"),
        JSON.stringify(consent),
      );
      await context.agents.spawn({ workspace: workspace.id, host: hostId });
      expect(
        JSON.parse(
          pod.files.get(".home/.claude/remote-settings-consent.json")!,
        ),
      ).toEqual(consent);
      context.close();
    });
  });

  test("a terminal is not seeded", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      await context.agents.spawn({
        workspace: workspace.id,
        host: hostId,
        terminal: true,
      });
      expect(pod.files.size).toBe(0);
      context.close();
    });
  });
});

describe("cloud accounts", () => {
  test("a Bedrock account brings its SSO profile, its variables and the sign-in renewal", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      await context.accounts.add("claude", "Work", "bedrock", undefined, {
        profile: "bedrock",
        region: "eu-west-1",
      });
      const session = await context.agents.spawn({
        workspace: workspace.id,
        host: hostId,
        account: "Work",
      });
      expect(session.account).not.toBeNull();
      const launch = pod.launches[0]!;
      expect(launch.env).toMatchObject({
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "bedrock",
        AWS_REGION: "eu-west-1",
      });
      expect(launch.secrets).toBeUndefined();
      const config = pod.files.get(".home/.aws/config")!;
      expect(config).toContain("[profile bedrock]");
      expect(config).toContain("[sso-session corp]");
      expect(config).not.toContain("aws_secret_access_key");
      expect(
        JSON.parse(pod.files.get(".home/.claude/settings.json")!),
      ).toMatchObject({
        awsAuthRefresh: "aws sso login --use-device-code --profile bedrock",
      });
      expect(
        context.repositories.cloudSsoHosts(hostId.slice("ws:".length)),
      ).toEqual(["d-1234567890.awsapps.com"]);
      context.close();
    });
  });

  test("a Bedrock profile without SSO is refused and leaves no session", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      await context.accounts.add("claude", "Keys", "bedrock", undefined, {
        profile: "keys",
        region: "us-east-1",
      });
      await expect(
        context.agents.spawn({
          workspace: workspace.id,
          host: hostId,
          account: "Keys",
        }),
      ).rejects.toThrow("does not sign in with AWS SSO");
      expect(pod.launches).toEqual([]);
      expect(
        context.repositories.listAgents({ workspaceId: workspace.id }),
      ).toEqual([]);
      context.close();
    });
  });

  test("an API-key account launches with its key; a login account with none", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, pod, hostId } = await setUp(home);
      context.agents.onCloudSecrets(async () => ({
        ANTHROPIC_API_KEY: "workspace-secret",
      }));
      await context.accounts.add("claude", "Keys", "api-key");
      await context.accounts.add("claude", "Me", "login");
      await context.agents.spawn({
        workspace: workspace.id,
        host: hostId,
        account: "Keys",
      });
      await context.agents.spawn({
        workspace: workspace.id,
        host: hostId,
        account: "Me",
      });
      await context.agents.spawn({ workspace: workspace.id, host: hostId });
      expect(pod.launches.map((launch) => launch.secrets)).toEqual([
        { ANTHROPIC_API_KEY: "sk-ant-test-key" },
        undefined,
        { ANTHROPIC_API_KEY: "workspace-secret" },
      ]);
      context.close();
    });
  });

  test("an unknown account is refused", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const { context, workspace, hostId } = await setUp(home);
      await expect(
        context.agents.spawn({
          workspace: workspace.id,
          host: hostId,
          account: "Nobody",
        }),
      ).rejects.toThrow("No Claude account named 'Nobody'");
      context.close();
    });
  });
});
