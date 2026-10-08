import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { runCommand } from "@daedalus/platform";
import { withTemporaryDaedalusHome } from "@daedalus/test-utils";
import packageJson from "../../../package.json";

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function cli(
  home: string,
  args: string[],
  env: Record<string, string> = {},
  stdin?: string,
  cwd = join(import.meta.dir, "../../.."),
): Promise<CliResult> {
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    {
      cwd,
      env: { ...process.env, DAEDALUS_HOME: home, ...env },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  expect(
    (await runCommand("git", ["init", "-q", "-b", "main", path])).exitCode,
  ).toBe(0);
  await Bun.write(join(path, "README.md"), "# Source\n");
  expect(
    (await runCommand("git", ["-C", path, "add", "README.md"])).exitCode,
  ).toBe(0);
  expect(
    (
      await runCommand("git", [
        "-C",
        path,
        "-c",
        "user.name=Daedalus Test",
        "-c",
        "user.email=test@daedalus.local",
        "commit",
        "-qm",
        "initial",
      ])
    ).exitCode,
  ).toBe(0);
}

/** The tmux server an application context keys to a home. */
const socketNameFor = (home: string) =>
  `daedalus-${createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12)}`;

describe("daedal CLI contract", () => {
  test("reports the package version in text and JSON formats", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      expect(await cli(home, ["--version"])).toMatchObject({
        exitCode: 0,
        stdout: `${packageJson.version}\n`,
        stderr: "",
      });
      expect(
        JSON.parse((await cli(home, ["--version", "--json"])).stdout),
      ).toEqual({ ok: true, data: { version: packageJson.version } });
    });
  });

  test("resolves tmux identically with and without Homebrew on PATH", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const tmuxCheck = async (env: Record<string, string> = {}) => {
        const { stdout } = await cli(home, ["doctor", "--json"], env);
        const envelope = JSON.parse(stdout) as {
          data: { checks: Array<{ name: string; version?: string }> };
        };
        return envelope.data.checks.find((check) => check.name === "tmux");
      };
      // The PATH a packaged app inherits from Launch Services: no Homebrew.
      const bundled = await tmuxCheck({
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      });
      expect(bundled).toEqual(await tmuxCheck());
    });
  });

  test("supports workspace and task lifecycle with JSON envelopes", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const created = await cli(home, [
        "workspace",
        "create",
        "CLI Demo",
        "--json",
      ]);
      expect(created).toMatchObject({ exitCode: 0, stderr: "" });
      const workspace = JSON.parse(created.stdout).data as {
        id: string;
        slug: string;
      };
      expect(workspace.slug).toBe("cli-demo");

      const taskCreated = await cli(home, [
        "task",
        "create",
        "--workspace",
        workspace.id,
        "--title",
        "Contract",
        "--json",
      ]);
      expect(taskCreated.exitCode).toBe(0);
      const task = JSON.parse(taskCreated.stdout).data as {
        id: string;
        number: number;
      };
      expect(task.number).toBe(1);
      const byNumber = await cli(home, [
        "task",
        "get",
        "1",
        "--workspace",
        workspace.id,
        "--json",
      ]);
      expect(JSON.parse(byNumber.stdout).data.id).toBe(task.id);
      const byScopedNumber = await cli(home, [
        "task",
        "get",
        `${workspace.slug}#1`,
        "--json",
      ]);
      expect(JSON.parse(byScopedNumber.stdout).data.id).toBe(task.id);
      const current = await cli(home, ["task", "current", "--json"], {
        DAEDALUS_TASK_ID: task.id,
      });
      expect(JSON.parse(current.stdout).data.number).toBe(1);
      const updated = await cli(home, [
        "task",
        "status",
        task.id,
        "done",
        "--json",
      ]);
      expect(JSON.parse(updated.stdout).data.status).toBe("done");
      const listed = await cli(home, [
        "task",
        "list",
        "--status",
        "done",
        "--json",
      ]);
      expect(JSON.parse(listed.stdout).data).toHaveLength(1);
      const archived = await cli(home, [
        "workspace",
        "archive",
        workspace.id,
        "--json",
      ]);
      expect(JSON.parse(archived.stdout).data.archivedAt).not.toBeNull();
      expect(
        JSON.parse((await cli(home, ["workspace", "list", "--json"])).stdout)
          .data,
      ).toEqual([]);
      expect(
        JSON.parse(
          (await cli(home, ["workspace", "list", "--archived", "--json"]))
            .stdout,
        ).data,
      ).toHaveLength(1);
      const restored = await cli(home, [
        "workspace",
        "restore",
        workspace.id,
        "--json",
      ]);
      expect(JSON.parse(restored.stdout).data.archivedAt).toBeNull();
    });
  });

  test("reads a long brief from a file or standard input, and lists a timeline", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const json = (result: CliResult) => {
        expect(result.stderr).toBe("");
        return JSON.parse(result.stdout).data;
      };
      json(await cli(home, ["workspace", "create", "Briefs", "--json"]));
      // Quotes, dollars and backticks: exactly what shell quoting mangles.
      const brief = "## Goal\n\nDon't `echo $HOME`; depends on #1.\n";
      const file = join(home, "brief.md");
      await Bun.write(file, brief);
      const created = json(
        await cli(home, [
          "task",
          "create",
          "--workspace",
          "briefs",
          "--title",
          "From a file",
          "--description-file",
          file,
          "--json",
        ]),
      );
      expect(created.description).toBe(brief);

      const replaced = 'Rewritten from stdin, with "quotes".';
      const updated = json(
        await cli(
          home,
          [
            "task",
            "update",
            String(created.number),
            "--workspace",
            "briefs",
            "--description-file",
            "-",
            "--json",
          ],
          {},
          replaced,
        ),
      );
      expect(updated.description).toBe(replaced);
      expect(updated.briefUpdatedAt).not.toBeNull();

      const both = await cli(home, [
        "task",
        "update",
        String(created.number),
        "--workspace",
        "briefs",
        "--description",
        "x",
        "--description-file",
        file,
      ]);
      expect(both.exitCode).toBe(2);
      const missing = await cli(home, [
        "task",
        "update",
        String(created.number),
        "--workspace",
        "briefs",
        "--description-file",
        join(home, "nope.md"),
      ]);
      expect(missing.exitCode).toBe(3);

      const timeline = json(
        await cli(home, [
          "task",
          "timeline",
          String(created.number),
          "--workspace",
          "briefs",
          "--json",
        ]),
      );
      expect(
        timeline.events.map((event: { kind: string }) => event.kind),
      ).toEqual(["created", "brief_edited"]);
      const human = await cli(home, [
        "task",
        "timeline",
        String(created.number),
        "--workspace",
        "briefs",
      ]);
      expect(human.stdout).toContain("From a file");
      expect(human.stdout).toContain("Brief edited");

      const settings = json(
        await cli(home, [
          "workspace",
          "update",
          "briefs",
          "--start-sets-in-progress",
          "off",
          "--default-provider",
          "codex",
          "--json",
        ]),
      );
      expect(settings).toMatchObject({
        startSetsInProgress: false,
        defaultProvider: "codex",
        defaultModel: null,
      });
      expect(
        json(
          await cli(home, [
            "workspace",
            "update",
            "briefs",
            "--default-model",
            "gpt-5-codex",
            "--json",
          ]),
        ),
      ).toMatchObject({
        defaultProvider: "codex",
        defaultModel: "gpt-5-codex",
      });
      // A model belongs to a provider; with none set it is refused rather
      // than left to apply to whichever provider is installed first.
      const orphan = await cli(home, [
        "workspace",
        "update",
        "briefs",
        "--default-provider",
        "none",
        "--default-model",
        "sonnet",
        "--json",
      ]);
      expect(orphan.exitCode).toBe(2);
      expect(JSON.parse(orphan.stderr).error.message).toContain(
        "belongs to a provider",
      );
      expect(
        (
          await cli(home, [
            "workspace",
            "update",
            "briefs",
            "--start-sets-in-progress",
            "maybe",
          ])
        ).exitCode,
      ).toBe(2);
    });
  });

  test("uses stable validation, not-found, and conflict exit codes", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const usage = await cli(home, ["task", "create", "--json"]);
      expect(usage.exitCode).toBe(2);
      expect(JSON.parse(usage.stderr).error.code).toBe("VALIDATION");
      const missing = await cli(home, [
        "workspace",
        "get",
        "missing",
        "--json",
      ]);
      expect(missing.exitCode).toBe(3);
      const first = await cli(home, ["workspace", "create", "Same", "--json"]);
      expect(first.exitCode).toBe(0);
      const collision = await cli(home, [
        "workspace",
        "create",
        "Same",
        "--json",
      ]);
      expect(collision.exitCode).toBe(4);
      expect(JSON.parse(collision.stderr).ok).toBe(false);
    });
  });

  test("sweeps for revivable sessions without the app, and finds none here", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // The point of the verb: the startup sweep has to be runnable and
      // testable without launching the desktop app.
      const swept = await cli(home, ["agent", "revive", "--all", "--json"]);
      expect(swept.exitCode).toBe(0);
      const envelope = JSON.parse(swept.stdout) as {
        ok: boolean;
        data: { revived: unknown[]; skipped: unknown[] };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data.revived).toEqual([]);
      expect(envelope.data.skipped).toEqual([]);

      // Naming a session and sweeping are different requests, and guessing
      // which one was meant is how a recovery command revives the wrong thing.
      const ambiguous = await cli(home, [
        "agent",
        "revive",
        "--all",
        "some-session-id",
        "--json",
      ]);
      expect(ambiguous.exitCode).toBe(2);
      expect(JSON.parse(ambiguous.stderr).ok).toBe(false);
    });
  });

  test("reports unavailable agent executables as dependency failures", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: {
            missing: {
              executable: "definitely-not-a-daedalus-executable",
              args: [],
            },
          },
        }),
      );
      const workspace = await cli(home, [
        "workspace",
        "create",
        "Agent Dependency",
        "--json",
      ]);
      expect(workspace.exitCode).toBe(0);
      const workspaceId = JSON.parse(workspace.stdout).data.id as string;
      const task = await cli(home, [
        "task",
        "create",
        "--workspace",
        workspaceId,
        "--title",
        "Dependency task",
        "--json",
      ]);
      expect(task.exitCode).toBe(0);
      const failed = await cli(home, [
        "agent",
        "spawn",
        "--workspace",
        workspaceId,
        "--command",
        "missing",
        "--task",
        "1",
        "--message",
        "Start with the highest-risk part.",
        "--json",
      ]);
      expect(failed.exitCode).toBe(5);
      expect(JSON.parse(failed.stderr).error.code).toBe("DEPENDENCY");
    });
  });

  test("session and routine commands check their input before starting anything", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const workspace = await cli(home, [
        "workspace",
        "create",
        "Ops",
        "--json",
      ]);
      expect(workspace.exitCode).toBe(0);
      const spawn = (...extra: string[]) =>
        cli(home, [
          "agent",
          "spawn",
          "--workspace",
          "ops",
          "--provider",
          "claude",
          ...extra,
          "--json",
        ]);
      const unknown = await spawn("--ability", "oracle");
      expect(JSON.parse(unknown.stderr).error.message).toContain(
        "Unknown ability 'oracle'",
      );
      const color = await spawn("--color", "mauve");
      expect(JSON.parse(color.stderr).error.message).toContain(
        "Color must be one of",
      );
      // Outside a session there is no session to default to.
      const none = await cli(home, ["routine", "list", "--json"], {
        DAEDALUS_SESSION_ID: "",
      });
      expect(JSON.parse(none.stderr).error.message).toContain("Pass --session");
      const missing = await cli(home, [
        "session",
        "grant",
        "Argus",
        "routines",
        "--json",
      ]);
      expect(JSON.parse(missing.stderr).error.message).toContain(
        "Session 'Argus' was not found",
      );
      const help = await cli(home, ["routine", "--help"]);
      expect(help.stdout).toContain("daedal routine report --run <run-id>");
      expect(help.stdout).not.toMatch(/finding|resident|routine agent/i);
      expect((await cli(home, ["session", "--help"])).stdout).toContain(
        "daedal session grant <session> <ability>",
      );
    });
  });

  test("shuts everything down, and refuses to race the app while it is open", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await Bun.write(
        join(home, "config.json"),
        // `cat` with no arguments sits on stdin, which is what a live agent
        // session looks like to tmux.
        JSON.stringify({
          agents: { hold: { executable: "/bin/cat", args: [] } },
        }),
      );
      const workspace = await cli(home, [
        "workspace",
        "create",
        "Shutdown",
        "--json",
      ]);
      expect(workspace.exitCode).toBe(0);
      const workspaceId = JSON.parse(workspace.stdout).data.id as string;
      for (const name of ["One", "Two"]) {
        const spawned = await cli(home, [
          "agent",
          "spawn",
          "--workspace",
          workspaceId,
          "--command",
          "hold",
          "--name",
          name,
          "--json",
        ]);
        expect(spawned.exitCode).toBe(0);
      }

      const dryRun = await cli(home, ["shutdown", "--dry-run", "--json"]);
      expect(dryRun.exitCode).toBe(0);
      const planned = JSON.parse(dryRun.stdout) as {
        data: {
          sessions: Array<{ name: string; disposition: string }>;
          stopsServer: boolean;
        };
      };
      // A configured command has no native conversation to preserve, so it is
      // reported as a stop rather than silently promised an archive.
      expect(
        planned.data.sessions.map((item) => [item.name, item.disposition]),
      ).toEqual([
        ["Two", "stop"],
        ["One", "stop"],
      ]);
      expect(planned.data.stopsServer).toBe(true);
      // A dry run changes nothing.
      expect(
        JSON.parse((await cli(home, ["agent", "list", "--json"])).stdout).data,
      ).toHaveLength(2);

      // The app polls tmux about once a second; a teardown underneath that
      // races it, so the command refuses rather than fighting for the rows.
      await Bun.write(
        join(home, "presence.json"),
        JSON.stringify({
          appForeground: true,
          workspaceId: null,
          sessionId: null,
          userIdleSeconds: 0,
          observedAt: new Date().toISOString(),
        }),
      );
      const refused = await cli(home, ["shutdown", "--json"]);
      expect(refused.exitCode).toBe(4);
      expect(JSON.parse(refused.stderr).error.message).toMatch(
        /desktop app is running/,
      );
      await rm(join(home, "presence.json"), { force: true });

      const done = await cli(home, ["shutdown", "--json"]);
      expect(done.exitCode).toBe(0);
      const result = JSON.parse(done.stdout) as {
        data: {
          sessions: Array<{ outcome: string }>;
          serverStopped: boolean;
        };
      };
      expect(result.data.sessions.map((item) => item.outcome)).toEqual([
        "stopped",
        "stopped",
      ]);
      expect(result.data.serverStopped).toBe(true);
      // The claim above is only worth as much as the socket agrees with: no
      // Daedalus tmux server is left behind.
      const server = await runCommand("tmux", [
        "-L",
        socketNameFor(home),
        "list-sessions",
      ]);
      expect(server.exitCode).not.toBe(0);
    });
  });

  test("an agent continues itself and is archived once the command exits", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // Stands in for Codex: shows its ready screen, then sits on stdin.
      const fakeCodex = join(home, "fake-codex");
      await Bun.write(
        fakeCodex,
        "#!/bin/sh\necho 'Ask Codex to do anything'\nexec cat\n",
      );
      await runCommand("chmod", ["+x", fakeCodex]);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: fakeCodex, args: [] } },
        }),
      );
      const env = { CODEX_HOME: join(home, "codex") };
      const workspace = await cli(
        home,
        ["workspace", "create", "Handoff", "--json"],
        env,
      );
      const workspaceId = JSON.parse(workspace.stdout).data.id as string;
      const task = await cli(
        home,
        ["task", "create", "--workspace", workspaceId, "--title", "Big job"],
        env,
      );
      expect(task.exitCode).toBe(0);
      const spawned = await cli(
        home,
        [
          "agent",
          "spawn",
          "--workspace",
          workspaceId,
          "--provider",
          "codex",
          "--task",
          "1",
          "--json",
        ],
        env,
      );
      expect(spawned.exitCode).toBe(0);
      const first = JSON.parse(spawned.stdout).data as {
        id: string;
        workingDirectory: string;
      };

      // As the handoff skill runs it: from the session's own directory, with
      // an environment that names some other session, the way a Claude
      // session moved into the background sees it.
      const continued = await cli(
        home,
        ["agent", "continue", "--handoff-file", "-", "--json"],
        { ...env, DAEDALUS_SESSION_ID: crypto.randomUUID() },
        "Next: finish step 2.",
        first.workingDirectory,
      );
      expect(continued.stderr).toBe("");
      expect(continued.exitCode).toBe(0);
      const result = JSON.parse(continued.stdout).data as {
        session: { id: string; workingDirectory: string };
        predecessor: { archivedAt: string | null };
      };
      expect(result.session.workingDirectory).toBe(first.workingDirectory);
      // Still live when the command answered: it cannot archive itself.
      expect(result.predecessor.archivedAt).toBeNull();
      expect(
        await Bun.file(join(first.workingDirectory, "HANDOFF.md")).text(),
      ).toBe("Next: finish step 2.\n");

      let archivedAt: string | null = null;
      for (let attempt = 0; attempt < 100 && !archivedAt; attempt += 1) {
        await Bun.sleep(100);
        const current = await cli(home, ["agent", "get", first.id, "--json"]);
        // This read races the archive running in its own tmux session, and it
        // has failed in CI with empty output; say why rather than fail to parse.
        expect(current.stderr).toBe("");
        expect(current.exitCode).toBe(0);
        archivedAt = JSON.parse(current.stdout).data.archivedAt;
      }
      expect(archivedAt).not.toBeNull();
      const successor = await cli(home, [
        "agent",
        "get",
        result.session.id,
        "--json",
      ]);
      expect(JSON.parse(successor.stdout).data.status).toBe("running");
      await cli(home, ["shutdown", "--json"]);
    });
  }, 30_000);

  test("continue refuses outside every session's directory", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const result = await cli(home, ["agent", "continue", "--self"], {
        DAEDALUS_SESSION_ID: crypto.randomUUID(),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Pass the session to continue");
    });
  });

  test("reports presence so an agent can pick its own channel", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const result = await cli(home, ["ui", "state", "--json"]);
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { appRunning: boolean; focusMode: boolean };
      };
      expect(state.ok).toBe(true);
      expect(state.data.appRunning).toBe(false);
      expect(state.data.focusMode).toBe(false);
    });
  });

  test("attention outside a session is a usage error, not a silent no-op", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // Explicitly outside a session: the test process is itself running
      // inside one, and its environment would otherwise leak in.
      const result = await cli(home, ["attention", "Need a decision"], {
        DAEDALUS_SESSION_ID: "",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("pass --session");
    });
  });

  test("a suppressed notification says so instead of looking like a failure", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // Focus mode also keeps this test away from the real Notification
      // Center: with it on, nothing is ever handed to a native notifier.
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({ focusMode: true }),
      );
      const result = await cli(
        home,
        ["notify", "Finished the migration", "--level", "success", "--json"],
        { DAEDALUS_SESSION_ID: "" },
      );
      expect(result.exitCode).toBe(0);
      const decision = JSON.parse(result.stdout) as {
        data: { delivered: string[]; suppressed: string; reason: string };
      };
      expect(decision.data.delivered).toEqual([]);
      expect(decision.data.suppressed).toBe("focus_mode");
      expect(decision.data.reason).toBe("focus mode is on");
    });
  });

  test("rejects an unknown notification level", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const result = await cli(home, ["notify", "hi", "--level", "shout"], {
        DAEDALUS_SESSION_ID: "",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("info, success, error");
    });
  });

  // Six CLI processes and the Git work behind them. About 0.7s alone, and past
  // bun's 5s default on a loaded runner, so it carries its own budget rather
  // than raising the default for every test.
  test("adds, attaches, syncs, and detaches repository library entries", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const source = join(home, "source");
      await createRepository(source);
      const workspace = JSON.parse(
        (await cli(home, ["workspace", "create", "Repo CLI", "--json"])).stdout,
      ).data as { id: string };
      const added = await cli(home, [
        "repo",
        "library",
        "add",
        source,
        "--json",
      ]);
      expect(added).toMatchObject({ exitCode: 0, stderr: "" });
      const libraryRepository = JSON.parse(added.stdout).data as {
        id: string;
        name: string;
      };
      expect(libraryRepository.name).toBe("source");

      const attached = await cli(home, [
        "repo",
        "attach",
        "--workspace",
        workspace.id,
        "--repository",
        libraryRepository.id,
        "--json",
      ]);
      expect(attached.exitCode).toBe(0);
      const attachment = JSON.parse(attached.stdout).data as { id: string };
      expect(
        JSON.parse(
          (
            await cli(home, [
              "repo",
              "list",
              "--workspace",
              workspace.id,
              "--json",
            ])
          ).stdout,
        ).data,
      ).toHaveLength(1);

      expect(
        (await cli(home, ["repo", "sync", attachment.id, "--json"])).exitCode,
      ).toBe(0);
      expect(
        (await cli(home, ["repo", "detach", attachment.id, "--json"])).exitCode,
      ).toBe(0);
    });
  }, 30_000);
  test("manages skills globally, and holds the documented exit codes", async () => {
    await withTemporaryDaedalusHome(async (root) => {
      const home = join(root, "daedalus");
      // The skill system writes into the provider homes, so the test gets its
      // own rather than the machine's.
      const providerHomes = {
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        DAEDALUS_AGENTS_HOME: join(root, "agents"),
        DAEDALUS_CURSOR_HOME: join(root, "cursor"),
      };
      const run = (args: string[]) => cli(home, args, providerHomes);

      const listed = await run(["skill", "list", "--json"]);
      expect(listed.exitCode).toBe(0);
      const listing = JSON.parse(listed.stdout) as {
        ok: boolean;
        data: {
          managed: Array<{ id: string; enabled: boolean; mode: string }>;
        };
      };
      expect(listing.ok).toBe(true);
      // Both ship on, and unslop ships in its `always` form.
      expect(
        listing.data.managed.find((one) => one.id === "unslop"),
      ).toMatchObject({ enabled: true, mode: "always" });
      expect(
        listing.data.managed.find((one) => one.id === "daedalus-control"),
      ).toMatchObject({ enabled: true });

      expect(
        (await run(["skill", "enable", "unslop", "--mode", "always"])).exitCode,
      ).toBe(0);
      expect(
        await Bun.file(
          join(providerHomes.CLAUDE_CONFIG_DIR, "output-styles", "Unslop.md"),
        ).exists(),
      ).toBe(true);
      expect(
        await Bun.file(join(providerHomes.CODEX_HOME, "AGENTS.md")).exists(),
      ).toBe(true);

      expect((await run(["skill", "disable", "unslop"])).exitCode).toBe(0);
      expect(
        await Bun.file(
          join(providerHomes.CLAUDE_CONFIG_DIR, "output-styles", "Unslop.md"),
        ).exists(),
      ).toBe(false);

      // 2 validation, 3 not found, 4 conflict, exactly as the contract says.
      expect(
        (await run(["skill", "enable", "unslop", "--mode", "loud"])).exitCode,
      ).toBe(2);
      expect(
        (await run(["skill", "enable", "daedalus-control", "--mode", "always"]))
          .exitCode,
      ).toBe(2);
      expect((await run(["skill", "get", "nothing-here"])).exitCode).toBe(3);
      expect(
        (await run(["skill", "remove", "unslop", "--force"])).exitCode,
      ).toBe(4);
      expect((await run(["skill", "remove", "unslop"])).exitCode).toBe(2);
      expect((await run(["skill", "wibble"])).exitCode).toBe(2);

      const doctored = await run(["skill", "doctor", "--json"]);
      expect(doctored.exitCode).toBe(0);
      expect(JSON.parse(doctored.stdout).ok).toBe(true);
    });
  });
});

describe("daedal team", () => {
  test("a lead adds a member, the user adds one, and they talk in the chat", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      // Stands in for Codex: shows its ready screen, then sits on stdin.
      const fakeCodex = join(home, "fake-codex");
      await Bun.write(
        fakeCodex,
        "#!/bin/sh\necho 'Ask Codex to do anything'\nexec cat\n",
      );
      await runCommand("chmod", ["+x", fakeCodex]);
      await Bun.write(
        join(home, "config.json"),
        JSON.stringify({
          agents: { codex: { executable: fakeCodex, args: [] } },
        }),
      );
      const env = {
        CODEX_HOME: join(home, "codex"),
        DAEDALUS_SESSION_ID: "",
      };
      const json = async (args: string[], cwd?: string) => {
        const result = await cli(
          home,
          [...args, "--json"],
          env,
          undefined,
          cwd,
        );
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout).data;
      };
      try {
        const workspace = await json(["workspace", "create", "Shop"]);
        const leader = await json([
          "agent",
          "spawn",
          "--workspace",
          workspace.id,
          "--provider",
          "codex",
          "--name",
          "Checkout API",
          "--ability",
          "orchestration",
        ]);

        // Inside the lead's folder, a bare --team is its own team.
        const server = await json(
          [
            "agent",
            "spawn",
            "--team",
            "--name",
            "Server",
            "--message",
            "Build the endpoints.",
          ],
          leader.workingDirectory,
        );
        expect(server).toMatchObject({ teamHandle: "server", note: null });

        // The user adds one from outside, naming the lead.
        const docs = await json([
          "agent",
          "spawn",
          "--team",
          "Checkout API",
          "--name",
          "Docs",
          "--message",
          "Write the guide.",
        ]);
        expect(docs.teamHandle).toBe("docs");
        expect(docs.note.message).toMatchObject({
          author: "daedalus",
          tags: ["lead"],
        });
        // The fake Codex has no thread, so the send fails and says why.
        expect(docs.note.deliveries[0]).toMatchObject({
          handle: "lead",
          delivered: false,
        });

        // A member posts as its handle.
        const said = await json(
          ["team", "say", "@docs", "the API is in TEAM.md"],
          server.workingDirectory,
        );
        expect(said.message).toMatchObject({
          author: "server",
          body: "@docs the API is in TEAM.md",
          tags: ["docs"],
        });

        const unknown = await cli(
          home,
          ["team", "say", "@nobody hi"],
          env,
          undefined,
          server.workingDirectory,
        );
        expect(unknown.exitCode).not.toBe(0);
        expect(unknown.stderr).toContain("is called @nobody");

        const untagged = await cli(home, ["team", "say", "status?"], env);
        expect(untagged.exitCode).toBe(0);
        expect(untagged.stdout).toContain(
          "Warning: The message tags no session",
        );

        const chat = await json(["team", "chat"], docs.workingDirectory);
        expect(chat.messages.map((m: { author: string }) => m.author)).toEqual([
          "daedalus",
          "server",
          "user",
        ]);
        expect(
          (await json(["team", "chat"], docs.workingDirectory)).messages,
        ).toEqual([]);

        const list = await json(["team", "list"]);
        expect(
          list.members.map((m: { handle: string; role: string }) => [
            m.handle,
            m.role,
          ]),
        ).toEqual([
          ["lead", "lead"],
          ["server", "member"],
          ["docs", "member"],
        ]);
        expect(
          list.members.find((m: { handle: string }) => m.handle === "lead"),
        ).toMatchObject({ undelivered: 1 });
        expect(
          list.members.find((m: { handle: string }) => m.handle === "lead")
            .lastError,
        ).toContain("thread id");

        expect(
          (await json(["team", "goal", "Ship v2 checkout"])).team.goal,
        ).toBe("Ship v2 checkout");

        // Only the lead or the user adds members.
        const byMember = await cli(
          home,
          ["agent", "spawn", "--team", "--message", "x"],
          env,
          undefined,
          server.workingDirectory,
        );
        expect(byMember.exitCode).not.toBe(0);
        expect(byMember.stderr).toContain("works only inside a lead's session");

        const help = await cli(home, ["team", "--help"], env);
        expect(help.stdout).toContain("daedal team say");
      } finally {
        await cli(home, ["shutdown", "--json"], env);
      }
    });
  }, 60_000);
});

describe("daedal secret and exec", () => {
  // These stop before the Keychain: a test must never write to the real one.
  test("exec runs the command with its own --json and --help and its exit code", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const printArgs = await cli(home, [
        "exec",
        "--",
        "/bin/echo",
        "--json",
        "--help",
      ]);
      expect(printArgs).toMatchObject({
        exitCode: 0,
        stdout: "--json --help\n",
      });

      const failing = await cli(home, [
        "exec",
        "--",
        process.execPath,
        "-e",
        "process.exit(7)",
      ]);
      expect(failing.exitCode).toBe(7);
    });
  }, 30_000);

  test("exec stops before the command when a secret is not set", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await cli(home, ["workspace", "create", "Keys", "--json"]);
      const result = await cli(home, [
        "exec",
        "--secret",
        "MISSING_TOKEN",
        "--workspace",
        "keys",
        "--json",
        "--",
        process.execPath,
        "-e",
        "console.log('ran')",
      ]);
      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      const error = JSON.parse(result.stderr) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(error.ok).toBe(false);
      expect(error.error.code).toBe("NOT_FOUND");
      expect(error.error.message).toContain("MISSING_TOKEN");
    });
  }, 30_000);

  test("exec needs -- before the command", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      const result = await cli(home, ["exec", "--secret", "A_TOKEN", "echo"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: daedal exec");
    });
  });

  test("secret list starts empty and set refuses bad input", async () => {
    await withTemporaryDaedalusHome(async (home) => {
      await cli(home, ["workspace", "create", "Keys", "--json"]);
      const listed = await cli(home, [
        "secret",
        "list",
        "--workspace",
        "keys",
        "--json",
      ]);
      expect(JSON.parse(listed.stdout)).toEqual({ ok: true, data: [] });
      const lowercase = await cli(
        home,
        ["secret", "set", "gh_token", "--workspace", "keys"],
        {},
        "value\n",
      );
      expect(lowercase.exitCode).toBe(2);
      const empty = await cli(
        home,
        ["secret", "set", "GH_TOKEN", "--workspace", "keys"],
        {},
        "\n",
      );
      expect(empty.exitCode).toBe(2);
      expect(empty.stderr).toContain("cannot be empty");
    });
  }, 30_000);
});
