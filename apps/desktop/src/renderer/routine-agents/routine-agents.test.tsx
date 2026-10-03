import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import type { RoutineReportDto } from "@daedalus/protocol";
import { ReportDetails } from "./ReportDetails";
import { relativeTime } from "./time";

const now = Date.parse("2026-10-01T10:00:00Z");

const report = (
  overrides: Partial<RoutineReportDto> = {},
): RoutineReportDto => ({
  id: "report-1",
  routineAgentId: "agent-argus",
  routine: "ci-health",
  key: "ci-health:org/repo:main:CI:test",
  sameAs: null,
  urgent: false,
  title: "main red",
  url: null,
  taskId: "task-1",
  state: "open",
  verdict: null,
  openedAt: "2026-10-01T09:00:00Z",
  lastSeenAt: "2026-10-01T09:30:00Z",
  resolvedAt: null,
  closedAt: null,
  reopenCount: 0,
  ...overrides,
});

describe("a routine report on its card", () => {
  test("shows the agent, where it came from, and offers the verdicts", () => {
    const html = renderToStaticMarkup(
      <ReportDetails
        agentName="Argus"
        busy={false}
        report={report({ urgent: true, state: "resolved", reopenCount: 2 })}
        onOpenLink={() => {}}
        onVerdict={() => {}}
      />,
    );
    expect(html).toContain('report-agent">Argus<');
    expect(html).toContain("report-urgent");
    expect(html).toContain("ci-health");
    expect(html).toContain("Resolved");
    expect(html).toContain("back 2×");
    expect(html).toContain(">Useful<");
    expect(html).toContain(">Noise<");
  });

  test("a judged report offers undo instead", () => {
    const html = renderToStaticMarkup(
      <ReportDetails
        agentName="Argus"
        busy={false}
        report={report({ verdict: "noise" })}
        onOpenLink={() => {}}
        onVerdict={() => {}}
      />,
    );
    expect(html).toContain("Marked noise");
    expect(html).toContain(">Undo<");
    expect(html).not.toContain(">Noise<");
  });
});

describe("relativeTime", () => {
  test("reads both ways", () => {
    expect(relativeTime("2026-10-01T10:07:00Z", now)).toBe("in 7m");
    expect(relativeTime("2026-10-01T08:30:00Z", now)).toBe("1h 30m ago");
    expect(relativeTime(null, now)).toBe("—");
  });
});
