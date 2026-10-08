import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  claudeDaedalusSettingsArgs,
  ensureInbox,
  inboxHook,
  leaveInInbox,
  INBOX_HOOK_MARKER,
  INBOX_WAITER_SCRIPT,
  loadConfig,
  postToInbox,
  usesInbox,
  type AgentSession,
  type DaedalusConfig,
} from "../index";

async function withHome(run: (config: DaedalusConfig) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "daedalus-inbox-"));
  try {
    await run(
      await loadConfig({
        DAEDALUS_HOME: home,
        CODEX_HOME: join(home, "codex"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        DAEDALUS_AGENTS_HOME: join(home, "agents"),
        DAEDALUS_CURSOR_HOME: join(home, "cursor"),
      }),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

/** Runs the waiter the way Claude runs the hook, and reports how it ended. */
function startWaiter(path: string) {
  const child = Bun.spawn(
    ["/bin/sh", "-c", INBOX_WAITER_SCRIPT, INBOX_HOOK_MARKER, path],
    { stderr: "pipe", stdout: "pipe" },
  );
  return {
    child,
    ended: Promise.all([new Response(child.stderr).text(), child.exited]),
  };
}

const waitUntil = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return false;
};

describe("session inbox", () => {
  test("a line reaches a waiting session once, and none when nothing waits", async () => {
    await withHome(async (config) => {
      const path = await ensureInbox(config, "s1");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(config.home, "inbox"))).mode & 0o777).toBe(0o700);
      // Nobody reads: the session is in a turn. Nothing blocks.
      expect(await postToInbox(config, "s1", "run 1 is due")).toBe(false);
      expect(await postToInbox(config, "nobody", "x")).toBe(false);

      const waiter = startWaiter(path);
      expect(
        await waitUntil(() =>
          postToInbox(config, "s1", "run 2 is due\nsecond line"),
        ),
      ).toBe(true);
      // Claude reads stderr and wakes on exit code 2.
      expect(await waiter.ended).toEqual(["run 2 is due second line\n", 2]);
      expect(await postToInbox(config, "s1", "run 3 is due")).toBe(false);
    });
  });

  test("a new waiter ends the one before it", async () => {
    await withHome(async (config) => {
      const path = await ensureInbox(config, "s1");
      const first = startWaiter(path);
      await waitUntil(async () => Bun.file(`${path}.pid`).exists());
      const second = startWaiter(path);
      const [, firstCode] = await first.ended;
      expect(firstCode).not.toBe(2);
      expect(await waitUntil(() => postToInbox(config, "s1", "due"))).toBe(
        true,
      );
      expect(await second.ended).toEqual(["due\n", 2]);
    });
  });

  test("a note left during a turn arrives when the next waiter starts", async () => {
    await withHome(async (config) => {
      const path = await ensureInbox(config, "s1");
      // Mid-turn: no waiter. The note stays in the mailbox.
      expect(await leaveInInbox(config, "s1", "hand off now")).toBe(false);
      expect(await leaveInInbox(config, "s1", "second note")).toBe(false);
      expect((await stat(`${path}.mail`)).mode & 0o777).toBe(0o600);
      // The turn ends; Stop starts a waiter, which prints both at once.
      expect(await startWaiter(path).ended).toEqual([
        "hand off now\nsecond note\n",
        2,
      ]);
      expect(await Bun.file(`${path}.mail`).exists()).toBe(false);
    });
  });

  test("a note reaches a waiting session now, along with a routine line", async () => {
    await withHome(async (config) => {
      const path = await ensureInbox(config, "s1");
      const waiter = startWaiter(path);
      await waitUntil(async () => Bun.file(`${path}.pid`).exists());
      await Bun.sleep(50);
      expect(await leaveInInbox(config, "s1", "hand off now")).toBe(true);
      expect(await waiter.ended).toEqual(["hand off now\n", 2]);
      // A note waiting when a routine line arrives goes with it.
      const next = startWaiter(path);
      await waitUntil(async () => Bun.file(`${path}.pid`).exists());
      const mail = Bun.file(`${path}.mail`);
      await Bun.write(mail, "revoke note\n");
      expect(await waitUntil(() => postToInbox(config, "s1", "run 9"))).toBe(
        true,
      );
      expect(await next.ended).toEqual(["revoke note\nrun 9\n", 2]);
    });
  });

  test("every Claude launch carries the waiter on Stop and SessionStart", async () => {
    await withHome(async (config) => {
      const args = await claudeDaedalusSettingsArgs(config, [], "s1");
      const settings = JSON.parse(args.at(-1)!) as {
        hooks: Record<string, Array<{ hooks: unknown[] }>>;
      };
      const hook = inboxHook(config, "s1");
      expect(settings.hooks.Stop![0]!.hooks).toContainEqual(hook);
      expect(settings.hooks.SessionStart![0]!.hooks).toContainEqual(hook);
      expect(settings.hooks.PreToolUse![0]!.hooks).not.toContainEqual(hook);
      expect(hook).toMatchObject({ asyncRewake: true, command: "/bin/sh" });
      expect(
        usesInbox({ provider: "claude", args } as unknown as AgentSession),
      ).toBe(true);
      expect(
        usesInbox({ provider: "codex", args } as unknown as AgentSession),
      ).toBe(false);
    });
  });
});
