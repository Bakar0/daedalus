import { describe, expect, test } from "vitest";
import type { ShutdownOptions, ShutdownPlan } from "@daedalus/core";
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

function harness(options: { plan?: ShutdownPlan; planFails?: boolean } = {}) {
  const asked: ShutdownPlanDto[] = [];
  const swept: ShutdownOptions[] = [];
  const timers: Array<() => void> = [];
  let cleared = 0;
  let quits = 0;
  const controller = new QuitController({
    plan: async () => {
      if (options.planFails) throw new Error("tmux is unreachable");
      return options.plan ?? livePlan;
    },
    runShutdown: async (input) => {
      swept.push(input);
      return { sessions: [], terminals: [], serverStopped: true };
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
    get quits() {
      return quits;
    },
    get cleared() {
      return cleared;
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
    await it.controller.decide("keep");
    expect(it.swept).toEqual([]);
    expect(it.quits).toBe(1);
  });

  test("confirming quits and never ends a session", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("keep");
    // Quitting has no destructive branch at all: the dialog only confirms,
    // and reopening reconnects to what is still running.
    expect(it.swept).toEqual([]);
    expect(it.quits).toBe(1);
  });

  test("cancel leaves the app open and lets quit be asked again", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("cancel");
    expect(it.quits).toBe(0);
    expect(it.controller.state).toBe("idle");
    await it.controller.requestQuit();
    expect(it.asked).toHaveLength(2);
  });

  test("the real close ends the sessions and the tmux server with them", async () => {
    const it = harness();
    await it.controller.requestQuit();
    it.controller.dialogShown();
    await it.controller.decide("shutdown");
    expect(it.swept).toEqual([{ stopServer: true }]);
    expect(it.quits).toBe(1);
  });

  test("the dialog is always offered, so quitting is never a silent stop", async () => {
    const it = harness();
    await it.controller.requestQuit();
    expect(it.asked).toHaveLength(1);
    expect(it.swept).toEqual([]);
    expect(it.quits).toBe(0);
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
      askWindow: () => {},
      quit: () => {
        quits += 1;
      },
    });
    await controller.requestShutdownAndQuit();
    expect(quits).toBe(1);
  });
});
