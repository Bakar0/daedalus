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
): Promise<CliResult> {
  const child = Bun.spawn(
    [process.execPath, "run", join(import.meta.dir, "index.ts"), ...args],
    {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, DAEDALUS_HOME: home, ...env },
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
  });
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
