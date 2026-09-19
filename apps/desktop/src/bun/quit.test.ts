import { describe, expect, test } from "vitest";
import type {
  QuitBehavior,
  ShutdownOptions,
  ShutdownPlan,
} from "@daedalus/core";
import type { ShutdownPlanDto } from "@daedalus/protocol";
import { QuitController } from "./quit";

const livePlan: ShutdownPlan = {
  sessions: [
    {
      id: "session-1",
      name: "Claude",
      workspaceId: "workspace-1",
      provider: "claude",
      kind: "agent",
      status: "running",
      disposition: "archive",
    },
    {
      id: "session-2",
      name: "Script",
      workspaceId: "workspace-1",
      provider: "custom",
      kind: "agent",
      status: "running",
      disposition: "stop",
    },
  ],
  terminals: [{ id: "terminal-1", name: "Terminal" }],
};

const emptyPlan: ShutdownPlan = { sessions: [], terminals: [] };

function harness(
  options: {
    plan?: ShutdownPlan;
    behavior?: QuitBehavior;
    planFails?: boolean;
  } = {},
) {
  const asked: ShutdownPlanDto[] = [];
  const swept: ShutdownOptions[] = [];
  const remembered: QuitBehavior[] = [];
  const timers: Array<() => void> = [];
  let cleared = 0;
  let quits = 0;
  let behavior: QuitBehavior = options.behavior ?? "ask";
  const controller = new QuitController({
    plan: async () => {
      if (options.planFails) throw new Error("tmux is unreachable");
      return options.plan ?? livePlan;
    },
    runShutdown: async (input) => {
      swept.push(input);
      return { sessions: [], terminals: [], serverStopped: true };
    },
    quitBehavior: () => behavior,
    rememberQuitBehavior: async (value) => {
      remembered.push(value);
      behavior = value;
    },
    askWindow: (plan) => asked.push(plan),
    quit: () => {
      quits += 1;
    },
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer: () => {
      cleared += 1;
    },
  });
  return {
    controller,
    asked,
    swept,
    remembered,
    get quits() {
      return quits;
    },
    get cleared() {
      return cleared;
    },
    get behavior() {
      return behavior;
    },
    fireWatchdog: () => timers.forEach((callback) => callback()),
  };
}

describe("QuitController", () => {
  test("quits without a word when nothing is live", async () => {
    const it = harness({ plan: emptyPlan });
    await it.controller.requestQuit();
    expect(it.asked).toEqual([]);
    expect(it.swept).toEqual([]);
    expect(it.quits).toBe(1);
  });

  test("asks when sessions are live, and sends what is live to the window", async () => {
    const it = harness();
    await it.controller.requestQuit();
    expect(it.quits).toBe(0);
    expect(it.asked).toEqual([
      {
        sessions: [
          {
            id: "session-1",
            name: "Claude",
            workspaceId: "workspace-1",
            provider: "claude",
            disposition: "archive",
          },
          {
            id: "session-2",
            name: "Script",
            workspaceId: "workspace-1",
            provider: "custom",
            disposition: "stop",
          },
        ],
        terminals: [{ id: "terminal-1", name: "Terminal" }],
      },
    ]);
  });

  test("keeping everything running stops nothing", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("keep", false);
    expect(it.swept).toEqual([]);
    expect(it.quits).toBe(1);
    expect(it.remembered).toEqual([]);
  });

  test("archiving on quit leaves the tmux server alone", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("archive", false);
    // Quitting is not a decision about sessions the CLI started, and the
    // server is shared with them.
    expect(it.swept).toEqual([{ stopServer: false }]);
    expect(it.quits).toBe(1);
  });

  test("cancel leaves the app open and lets quit be asked again", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("cancel", false);
    expect(it.quits).toBe(0);
    expect(it.controller.state).toBe("idle");
    await it.controller.requestQuit();
    expect(it.asked).toHaveLength(2);
  });

  test("don't ask again remembers the button that was pressed", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("keep", true);
    expect(it.remembered).toEqual(["keep"]);
    expect(it.behavior).toBe("keep");
  });

  test("a remembered choice replaces the dialog rather than adding to it", async () => {
    const keep = harness({ behavior: "keep" });
    await keep.controller.requestQuit();
    expect(keep.asked).toEqual([]);
    expect(keep.swept).toEqual([]);
    expect(keep.quits).toBe(1);

    const archive = harness({ behavior: "archive" });
    await archive.controller.requestQuit();
    expect(archive.asked).toEqual([]);
    expect(archive.swept).toEqual([{ stopServer: false }]);
    expect(archive.quits).toBe(1);
  });

  test("a window that never draws the dialog falls through to keeping everything", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.fireWatchdog();
    expect(it.quits).toBe(1);
    // The one thing a silent fallback must never do is end someone's work.
    expect(it.swept).toEqual([]);
  });

  test("an acknowledged dialog is waited on for as long as it takes", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    expect(it.cleared).toBe(1);
    it.fireWatchdog();
    expect(it.quits).toBe(0);
  });

  test("a plan that cannot be computed quits rather than blocking Cmd+Q", async () => {
    const it = harness({ planFails: true });
    await it.controller.requestQuit();
    expect(it.quits).toBe(1);
    expect(it.swept).toEqual([]);
  });

  test("Quit and Shut Down Sessions ends the tmux server and asks nothing", async () => {
    const it = harness();
    await it.controller.requestShutdownAndQuit();
    expect(it.asked).toEqual([]);
    expect(it.swept).toEqual([{ stopServer: true }]);
    expect(it.quits).toBe(1);
  });

  test("a failed sweep still quits rather than trapping the user in the app", async () => {
    let quits = 0;
    const controller = new QuitController({
      plan: async () => livePlan,
      runShutdown: async () => {
        throw new Error("tmux is unreachable");
      },
      quitBehavior: () => "ask",
      rememberQuitBehavior: async () => {},
      askWindow: () => {},
      quit: () => {
        quits += 1;
      },
    });
    await controller.requestShutdownAndQuit();
    expect(quits).toBe(1);
  });
});
