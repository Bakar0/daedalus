import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { TmuxClient, TmuxLaunch } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import {
  createApplicationContext,
  HOME_WORKSPACE_ID,
  type AgentSession,
  type ApplicationContext,
  type TeamDelivery,
  type TeamTransport,
} from "../index";
import { HOME_VISIBLE_FOLDERS } from "./workspace-files";

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

/** Records every delivery, by the session it went to. */
class RecordingTransport implements TeamTransport {
  readonly sent: TeamDelivery[] = [];
  async deliver(delivery: TeamDelivery) {
    this.sent.push(delivery);
  }
  to(session: Pick<AgentSession, "id">): TeamDelivery[] {
    return this.sent.filter((each) => each.session.id === session.id);
  }
}

async function withHome(
  run: (harness: {
    home: string;
    context: ApplicationContext;
    tmux: FakeTmux;
    transport: RecordingTransport;
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
    const transport = new RecordingTransport();
    const context = await createApplicationContext({
      env: {
        DAEDALUS_HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      },
      tmux,
      teamTransport: transport,
      sendNativeNotification: async () => ({
        delivered: true,
        backend: "app" as const,
        degraded: false,
      }),
    });
    try {
      await context.workspaces.create({ name: "Checkout", slug: "checkout" });
      await context.workspaces.create({ name: "Docs", slug: "docs" });
      await run({ home, context, tmux, transport });
    } finally {
      context.close();
    }
  });
}

/** A plain agent in the Home row, as an older build's main agent was. */
async function spawnAtHome(context: ApplicationContext): Promise<AgentSession> {
  await context.home.open();
  return context.agents.spawn({
    workspace: HOME_WORKSPACE_ID,
    provider: "claude",
    name: "Main agent",
  });
}

describe("Home", () => {
  test("Home opens a hidden row without an agent, and a session left there from before is archived", async () => {
    await withHome(async ({ context, tmux }) => {
      const workspace = await context.home.open();
      expect(workspace).toMatchObject({
        id: HOME_WORKSPACE_ID,
        kind: "home",
        name: "Home",
        path: join(context.config.workspaceRoot, ".home"),
      });
      expect(tmux.launches).toHaveLength(0);
      const session = await spawnAtHome(context);
      expect(session.workingDirectory).toBe(context.config.home);
      expect(await context.home.retireMainAgent()).toEqual([session.id]);
      expect((await context.agents.get(session.id)).archivedAt).toBeTruthy();
      expect(await context.home.retireMainAgent()).toEqual([]);
    });
  });

  test("nothing Daedalus writes for Home lands at the top of its home", async () => {
    await withHome(async ({ context, tmux }) => {
      const before = await readdir(context.config.home);
      const session = await spawnAtHome(context);
      await context.workspaceContent.get(HOME_WORKSPACE_ID);
      await context.workspaces.ensureHome();
      const { session: next } = await context.agents.continueSession({
        id: session.id,
        note: "# Rebirth\n\nGreet the user.",
      });
      const added = (await readdir(context.config.home)).filter(
        (name) => !before.includes(name),
      );
      for (const name of ["CLAUDE.md", "AGENTS.md", "REBIRTH.md", "MEMORY.md"])
        expect(added).not.toContain(name);
      // The successor runs there too and finds its note in the Home folder.
      const folder = context.repositories.findHomeWorkspace()!.path;
      expect(next.workingDirectory).toBe(context.config.home);
      expect(await Bun.file(join(folder, "REBIRTH.md")).text()).toBe(
        "# Rebirth\n\nGreet the user.\n",
      );
      expect(tmux.launches.at(-1)!.args.at(-1)!).toContain(
        `It left a note in ${join(folder, "REBIRTH.md")}.`,
      );
    });
  });

  test("Home's files are the whole Daedalus home, its top level kept", async () => {
    await withHome(async ({ context }) => {
      await context.home.open();
      const top =
        await context.workspaceContent.listDirectory(HOME_WORKSPACE_ID);
      const workspacesEntry = top.find((entry) => entry.name === "workspaces");
      expect(workspacesEntry).toMatchObject({ kind: "directory" });
      expect(workspacesEntry!.mutable).toBe(false);
      // Its database, logs and credentials stay out of the panel.
      await Bun.write(join(context.config.home, "logs", "app.log"), "x");
      const shown = (
        await context.workspaceContent.listDirectory(HOME_WORKSPACE_ID)
      ).map((entry) => entry.name);
      expect(shown.every((name) => HOME_VISIBLE_FOLDERS.includes(name))).toBe(
        true,
      );
      expect(shown).not.toContain("logs");
      expect(shown).not.toContain("state.db");
      const checkout = await context.workspaceContent.readFile(
        HOME_WORKSPACE_ID,
        "workspaces/checkout/BRIEF.md",
      );
      expect(checkout.path).toBe("workspaces/checkout/BRIEF.md");
      // Nothing is made at the top, and a workspace's own rules hold inside it.
      await expect(
        context.workspaceContent.createEntry({
          workspace: HOME_WORKSPACE_ID,
          name: "CLAUDE.md",
          kind: "file",
        }),
      ).rejects.toThrow("top of its home folder");
      const inCheckout = await context.workspaceContent.listDirectory(
        HOME_WORKSPACE_ID,
        "workspaces/checkout",
      );
      expect(
        inCheckout.find((entry) => entry.name === "artifacts")!.mutable,
      ).toBe(false);
      expect(inCheckout.map((entry) => entry.name)).not.toContain(".daedalus");
      const note = await context.workspaceContent.createEntry({
        workspace: HOME_WORKSPACE_ID,
        parentPath: "workspaces/checkout/artifacts",
        name: "note.md",
        kind: "file",
      });
      expect(note.path).toBe("workspaces/checkout/artifacts/note.md");
      expect(note.mutable).toBe(true);
      // Other workspaces still list their own folder.
      expect(
        (await context.workspaceContent.listDirectory("checkout")).map(
          (entry) => entry.name,
        ),
      ).toContain("BRIEF.md");
    });
  });

  test("Home's repos/ lists the library by name and reads its default branch", async () => {
    await withHome(async ({ context }) => {
      await context.home.open();
      const git = (args: string[], cwd?: string) => {
        const result = Bun.spawnSync(
          [
            "git",
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "init.defaultBranch=main",
            ...args,
          ],
          { cwd },
        );
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      };
      const source = join(context.config.home, "source");
      await mkdir(join(source, "src"), { recursive: true });
      await Bun.write(join(source, "README.md"), "# Policy\n");
      await Bun.write(join(source, "src", "app.ts"), "export const a = 1;\n");
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
      await Bun.write(join(source, "logo.png"), png);
      await Bun.write(join(source, "blob.bin"), new Uint8Array([1, 0, 2]));
      await symlink("README.md", join(source, "link.md"));
      git(["init", "--quiet"], source);
      git(["add", "."], source);
      git(["commit", "--quiet", "-m", "first"], source);
      const id = crypto.randomUUID();
      const mirror = join(context.config.repositoryRoot, `${id}.git`);
      git(["clone", "--quiet", "--bare", source, mirror]);
      const now = new Date().toISOString();
      const library = (fields: { id: string; name: string; branch: string }) =>
        context.repositories.createRepositoryLibraryEntry({
          id: fields.id,
          name: fields.name,
          remoteUrl: `https://example.com/${fields.name}.git`,
          gitDirectory: join(context.config.repositoryRoot, `${fields.id}.git`),
          defaultBranch: fields.branch,
          lastFetchedAt: now,
          createdAt: now,
        });
      library({ id, name: "policy", branch: "main" });
      // Its mirror was never cloned, and this one names a branch it lacks.
      library({ id: crypto.randomUUID(), name: "missing", branch: "main" });
      const otherId = crypto.randomUUID();
      git([
        "clone",
        "--quiet",
        "--bare",
        source,
        join(context.config.repositoryRoot, `${otherId}.git`),
      ]);
      library({ id: otherId, name: "nobranch", branch: "trunk" });

      const list = (path: string) =>
        context.workspaceContent.listDirectory(HOME_WORKSPACE_ID, path);
      const repos = await list("repos");
      expect(repos.map((entry) => entry.name)).toEqual([
        "missing",
        "nobranch",
        "policy",
      ]);
      expect(repos[0]).toMatchObject({
        path: "repos/missing",
        kind: "directory",
        mutable: false,
        immutableReason: "Library repositories are read-only",
      });
      expect(await list("repos/missing")).toEqual([]);
      expect(await list("repos/nobranch")).toEqual([]);
      const policy = await list("repos/policy");
      expect(
        policy.map((entry) => [entry.name, entry.kind, entry.mutable]),
      ).toEqual([
        ["src", "directory", false],
        ["blob.bin", "file", false],
        ["logo.png", "file", false],
        ["README.md", "file", false],
        ["link.md", "symlink", false],
      ]);
      expect(policy.find((entry) => entry.name === "src")!.path).toBe(
        "repos/policy/src",
      );
      expect((await list("repos/policy/src")).map((e) => e.path)).toEqual([
        "repos/policy/src/app.ts",
      ]);
      await expect(list("repos/policy/README.md")).rejects.toThrow(
        "not a directory",
      );
      await expect(list("repos/policy/nowhere")).rejects.toThrow(
        "was not found",
      );
      await expect(list("repos/policy/../policy")).rejects.toThrow(
        "not visible",
      );
      await expect(list("repos/policy/.git")).rejects.toThrow("not visible");

      const readme = await context.workspaceContent.readFile(
        HOME_WORKSPACE_ID,
        "repos/policy/README.md",
      );
      expect(readme).toEqual({
        name: "README.md",
        path: "repos/policy/README.md",
        content: "# Policy\n",
        format: "markdown",
      });
      expect(
        (
          await context.workspaceContent.readFile(
            HOME_WORKSPACE_ID,
            "repos/policy/src/app.ts",
          )
        ).content,
      ).toBe("export const a = 1;\n");
      await expect(
        context.workspaceContent.readFile(
          HOME_WORKSPACE_ID,
          "repos/policy/blob.bin",
        ),
      ).rejects.toThrow("Binary files");
      await expect(
        context.workspaceContent.readFile(
          HOME_WORKSPACE_ID,
          "repos/policy/src",
        ),
      ).rejects.toThrow("not a file");
      await expect(
        context.workspaceContent.readFile(
          HOME_WORKSPACE_ID,
          "repos/policy/link.md",
        ),
      ).rejects.toThrow("Symbolic links");
      const image = await context.workspaceContent.readImage(
        HOME_WORKSPACE_ID,
        "repos/policy/logo.png",
      );
      expect(image.mimeType).toBe("image/png");
      expect(new Uint8Array(Buffer.from(image.base64, "base64"))).toEqual(png);

      // Nothing under it changes, and the mirrors' git internals stay out.
      const readOnly = "Library repositories are read-only";
      await expect(
        context.workspaceContent.writeFile({
          workspace: HOME_WORKSPACE_ID,
          path: "repos/policy/README.md",
          content: "x",
          expectedContent: "# Policy\n",
        }),
      ).rejects.toThrow(readOnly);
      await expect(
        context.workspaceContent.createEntry({
          workspace: HOME_WORKSPACE_ID,
          parentPath: "repos/policy",
          name: "new.md",
          kind: "file",
        }),
      ).rejects.toThrow(readOnly);
      await expect(
        context.workspaceContent.removeEntry({
          workspace: HOME_WORKSPACE_ID,
          path: `repos/${id}.git`,
        }),
      ).rejects.toThrow(readOnly);
      await expect(
        context.workspaceContent.renameEntry({
          workspace: HOME_WORKSPACE_ID,
          path: "repos/policy",
          name: "other",
        }),
      ).rejects.toThrow(readOnly);
      await expect(
        context.workspaceContent.readFile(
          HOME_WORKSPACE_ID,
          `repos/${id}.git/HEAD`,
        ),
      ).rejects.toThrow("was not found");
    });
  });

  test("lists of workspaces leave the Home row out", async () => {
    await withHome(async ({ context }) => {
      await context.home.open();
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
});

describe("resolving a member", () => {
  test("a resolved member does not count against its lead's five", async () => {
    await withHome(async ({ context }) => {
      const main = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "Checkout lead",
      });
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
        "is in no lead's team",
      );
    });
  });
});
