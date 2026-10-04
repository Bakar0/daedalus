import { describe, expect, test } from "vitest";
import {
  fillPlaceholders,
  nextCronTime,
  nextRunTime,
  parseDuration,
  parseRoutineFile,
  parseSchedule,
  renderRoutineFile,
} from "./routine-files";

const local = (text: string) => new Date(text);

describe("routine schedules", () => {
  test("parses every, cron and at", () => {
    expect(parseSchedule("every 30m")).toMatchObject({
      kind: "every",
      everyMs: 30 * 60_000,
    });
    expect(parseSchedule('cron "50 8 * * 1-5"')).toMatchObject({
      kind: "cron",
      expression: "50 8 * * 1-5",
    });
    expect(parseSchedule("at 2026-09-30T15:40")).toMatchObject({
      kind: "at",
      at: local("2026-09-30T15:40").toISOString(),
    });
    expect(() => parseSchedule("every 10s")).toThrow("at most once a minute");
    expect(() => parseSchedule("hourly")).toThrow("is not one of");
    expect(() => parseSchedule('cron "61 * * * *"')).toThrow("out of range");
  });

  test("finds the next cron minute in local time", () => {
    // 2026-09-30 is a Wednesday.
    expect(nextCronTime("50 8 * * 1-5", local("2026-09-30T08:49"))).toEqual(
      local("2026-09-30T08:50"),
    );
    expect(nextCronTime("50 8 * * 1-5", local("2026-09-30T08:50"))).toEqual(
      local("2026-10-01T08:50"),
    );
    // Friday evening skips the weekend.
    expect(nextCronTime("50 8 * * 1-5", local("2026-10-02T09:00"))).toEqual(
      local("2026-10-05T08:50"),
    );
    expect(nextCronTime("*/15 * * * *", local("2026-09-30T10:07"))).toEqual(
      local("2026-09-30T10:15"),
    );
    expect(nextCronTime("7 10 * * 1", local("2026-09-30T00:00"))).toEqual(
      local("2026-10-05T10:07"),
    );
    expect(() => nextCronTime("0 0 31 2 *", local("2026-01-01T00:00"))).toThrow(
      "never matches",
    );
  });

  test("a missed slot fires once, and a new routine waits for its first", () => {
    const now = local("2026-09-30T12:00");
    const every = parseSchedule("every 10m");
    expect(nextRunTime(every, { now, lastRunAt: null })).toEqual(now);
    expect(
      nextRunTime(every, {
        now,
        lastRunAt: local("2026-09-29T12:00").toISOString(),
      }),
    ).toEqual(local("2026-09-29T12:10"));
    const cron = parseSchedule('cron "0 9 * * *"');
    expect(nextRunTime(cron, { now, lastRunAt: null })).toEqual(
      local("2026-10-01T09:00"),
    );
    expect(
      nextRunTime(cron, {
        now,
        lastRunAt: local("2026-09-28T09:00").toISOString(),
      }),
    ).toEqual(local("2026-09-29T09:00"));
    const at = parseSchedule("at 2026-09-30T15:40");
    expect(nextRunTime(at, { now, lastRunAt: null })).toEqual(
      local("2026-09-30T15:40"),
    );
    expect(nextRunTime(at, { now, lastRunAt: now.toISOString() })).toBeNull();
  });

  test("parses durations", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseDuration("soon")).toThrow("is not a duration");
  });
});

describe("routine text", () => {
  const file = `---
name: ci-health
schedule: every 30m
model: sonnet
timeout: 10m
output: task
vars:
  pr: Bakar0/daedalus#57
---
Check CI for {{pr}} since {{last_run}}. Keep {{unknown}}.
`;

  test("parses frontmatter and body", () => {
    const routine = parseRoutineFile(file);
    expect(routine).toMatchObject({
      name: "ci-health",
      model: "sonnet",
      timeoutMs: 600_000,
      output: "task",
      enabled: true,
      vars: { pr: "Bakar0/daedalus#57" },
    });
    expect(
      fillPlaceholders(routine.body, { ...routine.vars, last_run: "09:00" }),
    ).toBe("Check CI for Bakar0/daedalus#57 since 09:00. Keep {{unknown}}.");
  });

  test("names the field that is wrong", () => {
    expect(() => parseRoutineFile("no frontmatter")).toThrow(
      "starts with frontmatter",
    );
    expect(() => parseRoutineFile("---\nname: x\n---\nbody")).toThrow(
      "'schedule' field is required",
    );
    expect(() =>
      parseRoutineFile("---\nschedule: every 5m\n---\nbody"),
    ).toThrow("'name' field is required");
    expect(
      parseRoutineFile("---\nschedule: every 5m\n---\nbody", "from-file").name,
    ).toBe("from-file");
    expect(() =>
      parseRoutineFile(
        "---\nname: x\nschedule: every 5m\noutput: maybe\n---\nbody",
      ),
    ).toThrow("'output' must be one of");
    expect(() =>
      parseRoutineFile("---\nname: x\nschedule: every 5m\n---\n"),
    ).toThrow("no prompt");
  });

  test("renders a file that parses back to the same routine", () => {
    const routine = parseRoutineFile(file);
    const again = parseRoutineFile(renderRoutineFile(routine));
    expect(again).toEqual(routine);
    const disabled = parseRoutineFile(
      renderRoutineFile({ ...routine, enabled: false }),
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.body).toBe(routine.body);
    for (const timeoutMs of [90 * 60_000, 3 * 86_400_000, 45_000]) {
      const timed = parseRoutineFile(
        renderRoutineFile({ ...routine, timeoutMs }),
      );
      expect(timed.timeoutMs).toBe(timeoutMs);
    }
  });
});
