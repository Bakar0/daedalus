import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type {
  AutoRebirthDto,
  RoutinesDetailDto,
  RoutinesStatusDto,
} from "@daedalus/protocol";
import { clockLabel, RoutineBar, routineBarText } from "./RoutineBar";
import { RoutinesView, scheduleLabel } from "./RoutinesPanel";
import { SessionMenu } from "../SessionMenu";

const now = Date.parse("2026-10-04T10:00:00Z");
const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();

const status = (
  overrides: Partial<RoutinesStatusDto> = {},
): RoutinesStatusDto => ({
  abilityId: "ability-1",
  sessionId: "session-1",
  paused: false,
  waiting: [],
  running: 0,
  hold: null,
  nextRun: { routine: "ci-health", at: at(4 * 60) },
  lastKeystrokeAt: null,
  routines: 2,
  openReports: 0,
  openUrgentReports: 0,
  openReportTasks: 0,
  ...overrides,
});

const waiting = [
  { runId: 7, routine: "ci-health", queuedAt: at(-90) },
  { runId: 8, routine: "alerts", queuedAt: at(-30) },
];

describe("the routine bar's text", () => {
  test("names the next run when nothing waits", () => {
    expect(routineBarText(status(), now)).toBe(
      "Routines · next: ci-health in 4m",
    );
    expect(routineBarText(status({ running: 1 }), now)).toBe(
      "Routines · next: ci-health in 4m · 1 running",
    );
    expect(routineBarText(status({ nextRun: null }), now)).toBe(
      "Routines · nothing scheduled",
    );
    expect(routineBarText(status({ paused: true, nextRun: null }), now)).toBe(
      "Routines · paused",
    );
  });

  test("counts down the quiet time after typing", () => {
    const typing = status({
      waiting,
      lastKeystrokeAt: at(-40),
      hold: { reason: "typing", text: "you typed", until: at(80) },
    });
    expect(routineBarText(typing, now)).toBe(
      "2 waiting · you typed 0:40 ago · resumes in 1:20",
    );
    expect(routineBarText(typing, now + 81_000)).toBe("2 waiting · resuming");
  });

  test("says why runs are held", () => {
    const held = (reason: NonNullable<RoutinesStatusDto["hold"]>["reason"]) =>
      routineBarText(
        status({ waiting, running: 3, hold: { reason, text: "host text" } }),
        now,
      );
    expect(held("busy")).toBe("2 waiting · session busy");
    expect(held("input-text")).toBe("2 waiting · input box has text");
    expect(held("in-flight-limit")).toBe("2 waiting · 3 runs in flight");
    expect(held("rebirth")).toBe("2 waiting · rebirth pending");
    expect(held("paused")).toBe("2 waiting · paused");
    expect(held("skill-missing")).toBe("2 waiting · host text");
    expect(routineBarText(status({ waiting }), now)).toBe(
      "2 waiting · going in",
    );
  });

  test("formats the clock", () => {
    expect(clockLabel(40_000)).toBe("0:40");
    expect(clockLabel(80_000)).toBe("1:20");
    expect(clockLabel(-5)).toBe("0:00");
  });
});

describe("the routine bar", () => {
  test("offers Run now only while runs wait, and lists them", () => {
    const idle = renderToStaticMarkup(
      <RoutineBar
        busy={false}
        color="teal"
        onOpenPanel={() => {}}
        onRunNow={() => {}}
        onTogglePause={() => {}}
        status={status()}
      />,
    );
    expect(idle).not.toContain("Run now");
    expect(idle).toContain("Pause");
    expect(idle).toContain('data-color="teal"');

    const held = renderToStaticMarkup(
      <RoutineBar
        busy={false}
        color={null}
        onOpenPanel={() => {}}
        onRunNow={() => {}}
        onTogglePause={() => {}}
        status={status({
          waiting,
          paused: false,
          hold: { reason: "busy", text: "busy" },
        })}
      />,
    );
    expect(held).toContain("Run now");
    expect(held).toContain("2 runs waiting");
    expect(held).toContain("alerts");
    expect(held).toContain('data-held="true"');
  });

  test("offers Resume when paused", () => {
    const html = renderToStaticMarkup(
      <RoutineBar
        busy={false}
        color={null}
        onOpenPanel={() => {}}
        onRunNow={() => {}}
        onTogglePause={() => {}}
        status={status({ paused: true, nextRun: null })}
      />,
    );
    expect(html).toContain("Resume");
  });
});

describe("the Routines tab", () => {
  const detail: RoutinesDetailDto = {
    purpose: "Keep main green",
    routines: [
      {
        name: "ci-health",
        prompt: "Check CI on main.",
        schedule: "every 15m",
        until: null,
        model: "haiku",
        timeoutMs: 600_000,
        output: "task",
        enabled: true,
        nextRunAt: at(300),
        lastRunAt: at(-600),
        consecutiveFailures: 3,
        lastRun: {
          id: 4,
          routine: "ci-health",
          status: "failed",
          queuedAt: at(-700),
          deliveredAt: at(-650),
          startedAt: at(-640),
          finishedAt: at(-600),
          outcome: null,
          summary: "timed out",
          missedMs: 0,
        },
      },
      {
        name: "alerts",
        prompt: "Triage new alerts.",
        schedule: "0 9 * * 1-5",
        until: null,
        model: null,
        timeoutMs: 300_000,
        output: "notify",
        enabled: false,
        nextRunAt: null,
        lastRunAt: null,
        consecutiveFailures: 0,
        lastRun: null,
      },
    ],
    templates: [],
    runs: [
      {
        id: 5,
        routine: "ci-health",
        status: "done",
        queuedAt: at(-1300),
        deliveredAt: at(-1290),
        startedAt: at(-1280),
        finishedAt: at(-1200),
        outcome: "task",
        summary: "main is red on lint",
        missedMs: 0,
      },
    ],
  };

  test("shows the purpose, schedules, last runs and failures", () => {
    const html = renderToStaticMarkup(
      <RoutinesView
        actions={{
          runNow: () => {},
          setEnabled: () => {},
          savePurpose: () => {},
          togglePause: () => {},
          readMore: () => {},
        }}
        busy={false}
        detail={detail}
        error={undefined}
        now={now}
        sessionId="session-1"
        sessionName="Argus"
        status={status({ paused: true })}
      />,
    );
    expect(html).toContain("Keep main green");
    expect(html).toContain("Routines are checks this session runs");
    expect(html).toContain("1 of 2 on · paused");
    expect(html).toContain("Every 15 min");
    expect(html).toContain("in 5m");
    expect(html).toContain('data-tone="bad">failed</span>10m ago');
    expect(html).toContain("3 failures in a row: timed out");
    expect(html).toContain('data-failing="true"');
    expect(html).toContain("Never run");
    expect(html).toContain("Resume");
    expect(html).toContain("Enable");
    expect(html).toContain("Disable");
    expect(html).toContain("Recent runs");
    expect(html).toContain("main is red on lint");
  });

  test("says a schedule in words when it can", () => {
    expect(scheduleLabel("every 15m")).toBe("Every 15 min");
    expect(scheduleLabel("every 1h")).toBe("Every hour");
    expect(scheduleLabel("every 2d")).toBe("Every 2 days");
    expect(scheduleLabel('cron "0 9 * * 1-5"')).toBe('cron "0 9 * * 1-5"');
  });
});

describe("the session card menu", () => {
  const render = (
    offerAbilities: boolean,
    routines: boolean,
    autoRebirth: AutoRebirthDto = null,
  ) =>
    renderToStaticMarkup(
      <SessionMenu
        autoRebirth={autoRebirth}
        color="blue"
        inheritedRebirth={85}
        name="Argus"
        offerAbilities={offerAbilities}
        offerOrchestration={offerAbilities}
        onAutoRebirth={() => {}}
        onColor={() => {}}
        onOrchestration={() => {}}
        onPin={() => {}}
        onRename={() => {}}
        onRoutines={() => {}}
        orchestration={false}
        pinned
        routines={routines}
      />,
    );
  const rebirthChoices = (html: string) =>
    [...html.matchAll(/class="rebirth-choice"[^>]*>([^<]+)</g)].map(
      (match) => match[1],
    );

  test("offers rename, unpin, nine colors and the routines ability", () => {
    const html = render(true, true);
    expect(html).toContain("Rename…");
    expect(html).toContain("Unpin");
    expect(html.match(/class="color-swatch"/g)).toHaveLength(9);
    expect(html).toContain('aria-label="Blue" class="color-swatch"');
    expect(html).toMatch(/aria-checked="true"[^>]*role="menuitemcheckbox"/);
  });

  test("leaves abilities and rebirth off a terminal", () => {
    const html = render(false, false);
    expect(html).not.toContain("Abilities");
    expect(html).not.toContain("rebirth-choice");
  });

  test("offers the workspace's rebirth threshold as Default", () => {
    const html = render(true, false);
    expect(html).toContain("workspace: 85%");
    expect(rebirthChoices(html)).toEqual(["Default", "Off", "On"]);
    expect(html).toMatch(
      /aria-checked="true" class="rebirth-choice"[^>]*>Default</,
    );
    expect(html).not.toContain("percent-input");
  });

  test("a threshold of its own is On, with any percent in its field", () => {
    const html = render(true, false, 73);
    expect(html).toContain("own setting");
    expect(html).toMatch(/aria-checked="true" class="rebirth-choice"[^>]*>On</);
    expect(html).toMatch(/class="percent-input"><input[^>]*value="73"/);
  });
});
