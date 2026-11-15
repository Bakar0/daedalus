import { Database } from "bun:sqlite";
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
      // It runs at the Daedalus home itself, not in a session folder.
      expect(first.session.workingDirectory).toBe(context.config.home);
      expect(tmux.launches[0]!.cwd).toBe(context.config.home);
      expect(
        await Bun.file(
          join(first.workspace.path, "worktrees", "unassigned"),
        ).exists(),
      ).toBe(false);
      // Its role is in the system prompt, with the memory file, and there is
      // no visible first message.
      const args = tmux.launches[0]!.args;
      const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
      expect(args.at(-1)).toBe("Main agent");
      expect(args.join(" ")).not.toContain("/daedalus-orchestration");
      expect(prompt).toContain("Start one thread per piece of work");
      expect(prompt).toContain("daedal thread new --workspace");
      expect(prompt).toContain("daedal thread track <session>");
      expect(prompt).toContain("daedal attention");
      expect(prompt).toContain(join(first.workspace.path, "MEMORY.md"));
      expect(prompt).toContain(
        `You run at the Daedalus home, ${context.config.home}`,
      );
      expect(prompt).toContain("start a thread there for the change");
      expect(prompt).toContain(
        "Do not read accounts/, remote/, claude-settings/, inbox/ or the .db files",
      );
      expect(prompt).toContain("Never create CLAUDE.md or AGENTS.md");
      expect(prompt).toContain(join(first.workspace.path, "REBIRTH.md"));
      expect(
        await Bun.file(join(first.workspace.path, "MEMORY.md")).exists(),
      ).toBe(true);

      const again = await context.home.agent();
      expect(again.session.id).toBe(first.session.id);
      expect(tmux.launches).toHaveLength(1);
      expect(context.home.isHome(first.session)).toBe(true);
    });
  });

  test("nothing Daedalus writes for Home lands at the top of its home", async () => {
    await withHome(async ({ context, tmux }) => {
      const before = await readdir(context.config.home);
      const { session } = await context.home.agent();
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
      const folder = context.home.workspace()!.path;
      expect(next.workingDirectory).toBe(context.config.home);
      expect(await Bun.file(join(folder, "REBIRTH.md")).text()).toBe(
        "# Rebirth\n\nGreet the user.\n",
      );
      expect(tmux.launches.at(-1)!.args.at(-1)!).toContain(
        `It left a note in ${join(folder, "REBIRTH.md")}.`,
      );
    });
  });

  test("a main agent started in its old folder keeps it; its successor moves to the home", async () => {
    await withHome(async ({ context, tmux }) => {
      const { session, workspace } = await context.home.agent();
      const old = join(workspace.path, "worktrees", "unassigned", "claude-1");
      await mkdir(old, { recursive: true });
      // As an earlier build left it: in a session folder under `.home`.
      const database = new Database(context.config.databasePath);
      database
        .query("UPDATE agent_sessions SET working_directory = ? WHERE id = ?")
        .run(old, session.id);
      database.close();
      expect(context.home.current()!.workingDirectory).toBe(old);
      const { session: next } = await context.agents.continueSession({
        id: session.id,
      });
      expect(next.workingDirectory).toBe(context.config.home);
      expect(tmux.launches.at(-1)!.cwd).toBe(context.config.home);
      expect(context.home.current()!.id).toBe(next.id);
    });
  });

  test("Home's files are the whole Daedalus home, its top level kept", async () => {
    await withHome(async ({ context }) => {
      await context.home.agent();
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
      await context.home.agent();
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

  test("a thread of the main agent is an ordinary session it tracks, in another workspace", async () => {
    await withHome(async ({ context, tmux }) => {
      const { session: main } = await context.home.agent();
      const session = await context.tracking.start({
        tracker: main.id,
        workspace: "checkout",
        name: "endpoints",
        message: "Build the cart endpoints",
      });
      expect(session).toMatchObject({
        workspaceId: "checkout",
        name: "endpoints",
        teamId: null,
        teamHandle: null,
        spawnedBy: main.id,
      });
      expect(context.tracking.tracks(main.id, session.id)).toBe(true);
      expect(context.teams.led(main.id)).toBeUndefined();
      expect(context.teams.memberOf(session.id)).toBeUndefined();
      // It is told where its replies go.
      const prompt = tmux.launches.at(-1)!.args.at(-1)!;
      expect(prompt).toContain("Build the cart endpoints");
      expect(prompt).toContain(
        "The main agent started this session and tracks it",
      );
      expect(context.home.current()?.id).toBe(main.id);
      // The main agent leads no team.
      await expect(
        context.teams.spawnMember({
          team: main.id,
          addedBy: "lead",
          workspace: "checkout",
          name: "other",
          instructions: "Work",
        }),
      ).rejects.toThrow("leads no team; start work with 'daedal thread new");
      await expect(
        context.tracking.start({
          tracker: main.id,
          workspace: HOME_WORKSPACE_ID,
          message: "Here",
        }),
      ).rejects.toThrow("not at Home");
    });
  });

  test("tracking, untracking and the All list", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      const mine = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "stale",
      });
      expect(context.tracking.track(main.id, mine.id).added).toBe(true);
      expect(context.tracking.track(main.id, mine.id).added).toBe(false);
      expect(() => context.tracking.track(main.id, main.id)).toThrow(
        "cannot track itself",
      );
      expect(
        context.tracking.sessions(main.id).map((row) => row.session.name),
      ).toEqual(["stale"]);
      const other = await context.agents.spawn({
        provider: "claude",
        workspace: "docs",
        name: "changelog",
      });
      // All: every live session in every workspace, never Home's.
      expect(
        context.tracking
          .sessions(main.id, { all: true })
          .map((row) => [row.session.name, row.tracked])
          .sort(),
      ).toEqual([
        ["changelog", false],
        ["stale", true],
      ]);
      expect(context.tracking.untrack(main.id, mine.id).removed).toBe(true);
      expect(context.tracking.sessions(main.id)).toEqual([]);
      expect(context.tracking.isTracked(other.id)).toBe(false);
      expect(context.repositories.findAgent(mine.id)?.status).toBe("running");
    });
  });
});

/** A turn of a session, as its hooks report it. */
async function turn(
  context: ApplicationContext,
  session: AgentSession,
  message: string,
) {
  await context.activity.record({
    sessionId: session.id,
    activity: "working",
    source: "hook",
  });
  return context.activity.record({
    sessionId: session.id,
    activity: "done",
    detail: message.slice(0, 40),
    message,
    source: "hook",
  });
}

/** Moves a session's last delivery a minute and more into the past. */
function minuteLater(context: ApplicationContext, sessionId: string) {
  context.repositories.database
    .query(
      "UPDATE track_notes SET delivered_at = ? WHERE recipient_session_id = ? AND delivered_at IS NOT NULL",
    )
    .run(new Date(Date.now() - 61_000).toISOString(), sessionId);
}

describe("reports to the tracker", () => {
  test("a tracked session's turn end reaches its tracker, at most once a minute", async () => {
    await withHome(async ({ context, transport }) => {
      const { session: main } = await context.home.agent();
      const docs = await context.tracking.start({
        tracker: main.id,
        workspace: "docs",
        name: "cart docs",
        message: "Document the cart",
      });
      const stale = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "stale",
      });
      context.tracking.track(main.id, stale.id);

      const finished = await turn(
        context,
        docs,
        "Wrote the discount section.\n\nLinks checked.",
      );
      expect(transport.to(main).map((each) => each.text)).toEqual([
        "[tracked 'cart docs' in Docs] finished:\n\n" +
          "  Wrote the discount section.\n\n" +
          "  Links checked.\n\n" +
          `Reply with: daedal thread say ${docs.id} "..."`,
      ]);
      // The main agent tells the user; the tracked turn is not notified.
      expect(finished.notification).toBeUndefined();

      // A second within the minute waits for the tick.
      await turn(context, stale, "Picked full cart.");
      expect(transport.to(main)).toHaveLength(1);
      expect(await context.tracking.flushDue()).toEqual([]);
      minuteLater(context, main.id);
      expect(await context.tracking.flushDue()).toMatchObject([
        { sessionId: main.id, delivered: true, messages: 1 },
      ]);
      expect(transport.to(main).at(-1)!.text).toContain(
        "[tracked 'stale' in Checkout] finished:\n\n  Picked full cart.",
      );
    });
  });

  test("a tracked session waiting on the user wakes no one alone", async () => {
    await withHome(async ({ context, transport }) => {
      const { session: main } = await context.home.agent();
      const screen = await context.tracking.start({
        tracker: main.id,
        workspace: "docs",
        name: "cart screen",
        message: "Spec the cart screen",
      });
      await context.activity.raise({
        sessionId: screen.id,
        reason: "Keep files in the session folder?",
      });
      expect(transport.to(main)).toHaveLength(0);
      minuteLater(context, main.id);
      await context.tracking.flushDue();
      expect(transport.to(main)).toHaveLength(0);
      // The next report takes it along.
      await turn(context, screen, "Moved them to the root.");
      const [both] = transport.to(main);
      expect(both!.text).toContain(
        "[tracked 'cart screen' in Docs] is waiting on the user: Keep files in the session folder?",
      );
      expect(both!.text).toContain("finished:\n\n  Moved them to the root.");
    });
  });

  test("say delivers in full at once and takes held reports along", async () => {
    await withHome(async ({ context, transport }) => {
      const { session: main } = await context.home.agent();
      const stale = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "stale",
      });
      context.tracking.track(main.id, stale.id);
      const said = await context.tracking.say({
        tracker: main.id,
        session: stale.id,
        body: "Full cart.\nNot only the version.",
      });
      expect(said.delivery.delivered).toBe(true);
      expect(transport.to(stale).map((each) => each.text)).toEqual([
        "[from 'Main agent', which tracks you]:\n" +
          "  Full cart.\n  Not only the version.\n\n" +
          "When this turn ends, your last message goes back to the main agent, so end with a reply that says what you did.",
      ]);
      await expect(
        context.tracking.say({ tracker: main.id, session: main.id, body: "x" }),
      ).rejects.toThrow("does not track");
    });
  });

  test("a tracked team member reports to both its lead and its tracker", async () => {
    await withHome(async ({ context, transport }) => {
      const { session: main } = await context.home.agent();
      const lead = await context.agents.spawn({
        provider: "claude",
        workspace: "checkout",
        name: "Checkout lead",
      });
      const { session: member } = await context.teams.spawnMember({
        team: lead.id,
        addedBy: "lead",
        name: "rate",
        instructions: "Rate limit",
      });
      context.tracking.track(main.id, member.id);
      await turn(context, member, "Rate limit merged.");
      expect(transport.to(lead).at(-1)!.text).toContain(
        "@rate finished:\n\n  Rate limit merged.",
      );
      expect(transport.to(main).at(-1)!.text).toContain(
        "[tracked 'rate' in Checkout] finished:\n\n  Rate limit merged.",
      );
      // Still a member of its own lead's team.
      expect(context.teams.memberOf(member.id)?.team.lead.id).toBe(lead.id);
    });
  });

  test("a resolved or untracked session stops reporting", async () => {
    await withHome(async ({ context, transport }) => {
      const { session: main } = await context.home.agent();
      const one = await context.tracking.start({
        tracker: main.id,
        workspace: "docs",
        message: "One",
      });
      const two = await context.tracking.start({
        tracker: main.id,
        workspace: "docs",
        message: "Two",
      });
      context.threads.resolve(one.id, true);
      await turn(context, one, "After done.");
      context.tracking.untrack(main.id, two.id);
      await turn(context, two, "After untrack.");
      minuteLater(context, main.id);
      await context.tracking.flushDue();
      expect(transport.to(main)).toHaveLength(0);
    });
  });
});

describe("existing main-agent teams", () => {
  test("members of a team led from Home become tracked sessions, once", async () => {
    await withHome(async ({ context }) => {
      const { session: main } = await context.home.agent();
      // A team made before the main agent tracked instead of leading.
      const ability = context.abilities.grant(main.id, "orchestration", {
        live: false,
      });
      const changelog = await context.agents.spawn({
        provider: "claude",
        workspace: "docs",
        name: "changelog",
      });
      context.repositories.setAgentTeam(changelog.id, ability.id, "changelog");
      expect(context.teams.led(main.id)).toBeDefined();

      expect(context.home.adoptTeamMembers()).toEqual([changelog.id]);
      expect(context.repositories.findAgent(changelog.id)).toMatchObject({
        teamId: null,
        teamHandle: null,
      });
      expect(context.tracking.tracks(main.id, changelog.id)).toBe(true);
      expect(context.teams.led(main.id)).toBeUndefined();
      // Running it again changes nothing.
      expect(context.home.adoptTeamMembers()).toEqual([]);
      expect(context.tracking.sessions(main.id)).toHaveLength(1);
    });
  });
});

describe("threads", () => {
  test("a suggested thread waits for Start, then runs as a tracked session where it was suggested", async () => {
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
      expect(thread.teamId).toBeNull();
      expect(context.tracking.tracks(main.id, thread.id)).toBe(true);
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
        workspace: "checkout",
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
      // The main agent's thread needs a workspace to run in.
      await expect(
        context.threads.suggest({ lead: main.id, title: "Somewhere" }),
      ).rejects.toThrow("pass --workspace");
    });
  });

  test("a resolved thread does not count against its lead's five", async () => {
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
        "not a thread",
      );
    });
  });
});
