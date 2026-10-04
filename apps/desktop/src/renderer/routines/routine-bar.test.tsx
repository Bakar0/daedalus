import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RoutinesDetailDto, RoutinesStatusDto } from "@daedalus/protocol";
import { clockLabel, RoutineBar, routineBarText } from "./RoutineBar";
import { RoutinesPanel } from "./RoutinesPanel";
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
    expect(held("handoff")).toBe("2 waiting · handoff pending");
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

describe("the Routines panel", () => {
  const detail: RoutinesDetailDto = {
    purpose: "Keep main green",
    routines: [
      {
        name: "ci-health",
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
    runs: [],
  };

  test("shows the purpose, schedules, last runs and failures", () => {
    const html = renderToStaticMarkup(
      <RoutinesPanel
        busy={false}
        detail={detail}
        error={undefined}
        now={now}
        onClose={() => {}}
        onRunNow={() => {}}
        onSavePurpose={() => {}}
        onSetEnabled={() => {}}
        sessionName="Argus"
      />,
    );
    expect(html).toContain("Keep main green");
    expect(html).toContain("2 routines");
    expect(html).toContain("next in 5m");
    expect(html).toContain("failed 10m ago");
    expect(html).toContain("3 failures in a row: timed out");
    expect(html).toContain('data-failing="true"');
    expect(html).toContain("never run");
    expect(html).toContain("Enable");
    expect(html).toContain("Disable");
  });
});

describe("the session card menu", () => {
  const render = (offerAbilities: boolean, routines: boolean) =>
    renderToStaticMarkup(
      <SessionMenu
        color="blue"
        name="Argus"
        offerAbilities={offerAbilities}
        onColor={() => {}}
        onPin={() => {}}
        onRename={() => {}}
        onRoutines={() => {}}
        pinned
        routines={routines}
      />,
    );

  test("offers rename, unpin, nine colors and the routines ability", () => {
    const html = render(true, true);
    expect(html).toContain("Rename…");
    expect(html).toContain("Unpin");
    expect(html.match(/class="color-swatch"/g)).toHaveLength(9);
    expect(html).toContain('aria-label="Blue" class="color-swatch"');
    expect(html).toMatch(/aria-checked="true"[^>]*role="menuitemcheckbox"/);
  });

  test("leaves abilities off a terminal", () => {
    expect(render(false, false)).not.toContain("Abilities");
  });
});
