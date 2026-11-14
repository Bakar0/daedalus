import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  HOME_WORKSPACE_ID,
  type ApplicationContext,
  type TeamTransport,
} from "../index";

class FakeTmux implements TmuxClient {
  openPty() {
    return { start: async () => {}, write() {}, resize() {}, close() {} };
  }
  async pinWindowSize() {}
  async unpinWindowSize() {}
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
  async capture() {
    return "❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)";
  }
  async sendKeys() {}
  async send() {}
  async stop(session: string) {
    this.sessions.delete(session);
  }
  async killServer() {
    this.sessions.clear();
    return true;
  }
}

const silentTransport: TeamTransport = { deliver: async () => {} };

async function withHome(
  run: (harness: {
    home: string;
    context: ApplicationContext;
    tmux: FakeTmux;
  }) => Promise<void>,
) {
  await withTemporaryDaedalusHome(async (home) => {
    await Bun.write(
      join(home, "config.json"),
      JSON.stringify({
        agents: { claude: { executable: process.execPath, args: ["run"] } },
      }),
    );
    const tmux = new FakeTmux();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
      teamTransport: silentTransport,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app" as const,
        degraded: false,
      }),
    });
    try {
      await context.workspaces.create({ name: "Checkout", slug: "checkout" });
      await context.workspaces.create({ name: "Docs", slug: "docs" });
      await run({ home, context, tmux });
    } finally {
      context.close();
    }
  });
}

describe("Home", () => {
  test("the main agent is made once, in a hidden Home row under the workspaces root", async () => {
    await withHome(async ({ context, tmux }) => {
      expect(context.home.workspace()).toBeUndefined();
      const first = await context.home.agent();
      expect(first.workspace).toMatchObject({
        id: HOME_WORKSPACE_ID,
        kind: "home",
        name: "Home",
        path: join(context.config.workspaceRoot, ".home"),
      });
      expect(first.session.name).toBe("Main agent");
      expect(
        first.session.workingDirectory.startsWith(first.workspace.path),
      ).toBe(true);
      // Its prompt is the coordinator's, with the memory file.
      const prompt = tmux.launches[0]!.args.at(-1)!;
      expect(prompt).toContain("Start one thread per piece of work");
      expect(prompt).toContain(join(first.workspace.path, "MEMORY.md"));
      expect(
        await Bun.file(join(first.workspace.path, "MEMORY.md")).exists(),
      ).toBe(true);
      // Its launch reaches every workspace.
      expect(tmux.launches[0]!.args).toContain(context.config.workspaceRoot);

      const again = await context.home.agent();
      expect(again.session.id).toBe(first.session.id);
      expect(tmux.launches).toHaveLength(1);
      expect(context.home.isHome(first.session)).toBe(true);
    });
  });

  test("lists of workspaces leave the Home row out", async () => {
    await withHome(async ({ context }) => {
      await context.home.agent();
      expect((await context.workspaces.list()).map((item) => item.id)).toEqual([
        "docs",
        "checkout",
      ]);
      // The snapshot still carries it, marked, so the app can open it.
      const all = await context.workspaces.listWithHealth();
      expect(
        all.find((item) => item.workspace.id === HOME_WORKSPACE_ID)?.workspace
          .kind,
      ).toBe("home");
    });
  });

  test("a thread of the main agent runs in another workspace", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      const { session } = await context.teams.spawnMember({
        team: main.id,
        addedBy: "lead",
        workspace: "checkout",
        name: "endpoints",
        instructions: "Build the cart endpoints",
      });
      expect(session.workspaceId).toBe("checkout");
      expect(context.teams.led(main.id)?.lead.id).toBe(main.id);
      // The main agent stays the main agent once it leads threads.
      expect(context.home.current()?.id).toBe(main.id);
    });
  });
});

describe("threads", () => {
  test("a suggested thread waits for Start, then runs as a member where it was suggested", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      const suggestion = await context.threads.suggest({
        lead: main.id,
        title: "  Load-test GET /cart  ",
        workspace: "checkout",
        message: "Hit it at 2,400 reads/s and report p99",
      });
      expect(suggestion).toMatchObject({
        title: "Load-test GET /cart",
        workspaceId: "checkout",
      });
      expect(context.threads.suggestions(main.id)).toHaveLength(1);

      const thread = await context.threads.start(suggestion.id);
      expect(thread).toMatchObject({
        name: "Load-test GET /cart",
        workspaceId: "checkout",
      });
      expect(context.teams.memberOf(thread.id)?.team.lead.id).toBe(main.id);
      expect(context.threads.suggestions(main.id)).toEqual([]);
      await expect(context.threads.start(suggestion.id)).rejects.toThrow(
        "already started",
      );
    });
  });

  test("a dismissed suggestion is gone; a thread at Home is refused", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      const suggestion = await context.threads.suggest({
        lead: main.id,
        title: "Add cart_events table",
      });
      context.threads.dismiss(suggestion.id);
      expect(context.threads.suggestions(main.id)).toEqual([]);
      await expect(
        context.threads.suggest({
          lead: main.id,
          title: "Here",
          workspace: HOME_WORKSPACE_ID,
        }),
      ).rejects.toThrow("not at Home");
      await expect(
        context.threads.suggest({ lead: main.id, title: "   " }),
      ).rejects.toThrow("needs a title");
    });
  });

  test("a resolved thread does not count against its lead's five", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      const threads = [];
      for (let index = 0; index < 5; index += 1)
        threads.push(
          (
            await context.teams.spawnMember({
              team: main.id,
              addedBy: "lead",
              workspace: "docs",
              name: `t${index}`,
              instructions: "Work",
            })
          ).session,
        );
      const sixth = () =>
        context.teams.spawnMember({
          team: main.id,
          addedBy: "lead",
          workspace: "docs",
          name: "t5",
          instructions: "Work",
        });
      await expect(sixth()).rejects.toThrow("already has 5 members");
      const resolved = context.threads.resolve(threads[0]!.id, true);
      expect(resolved.resolvedAt).toEqual(expect.any(String));
      expect(
        context.repositories.findAgent(threads[0]!.id)?.resolvedAt,
      ).toEqual(expect.any(String));
      await expect(sixth()).resolves.toBeDefined();
      expect(() => context.threads.resolve(main.id, true)).toThrow(
        "not a thread",
      );
    });
  });
});
