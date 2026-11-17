import { expect, test } from "vitest";
import {
  groupPlanTasks,
  isSnoozed,
  markPlanTasks,
  snoozeChoices,
} from "./ActivityPage";

const task = (
  id: string,
  depth: number,
  state: "todo" | "doing" | "done" | "blocked" | "dropped" = "todo",
) => ({ key: `^${id}`, id, title: id, state, owner: null, depth });

test("the pinned task waits on the user; later todo siblings are held, up to its parent's end", () => {
  const tasks = [
    task("batch1", 0, "done"),
    task("batch2", 0, "doing"),
    task("recon", 1),
    task("run", 1),
    task("prod", 1, "done"),
    task("prod-sub", 2),
    task("after", 1),
    task("cve", 0),
  ];
  const marks = markPlanTasks(tasks, [{ id: 14, taskKey: "recon" }]);
  expect(marks.map((mark) => mark.mark ?? "")).toEqual([
    "",
    "",
    "wait",
    "held",
    "",
    "",
    "held",
    "",
  ]);
  expect(marks[3]!.ask).toBe(14);
  expect(
    markPlanTasks(tasks, [{ id: 1, taskKey: null }]).every((m) => !m.mark),
  ).toBe(true);
});

test("the plan is grouped by what each task needs, leaves only, waits on you first", () => {
  const tasks = [
    task("batch1", 0, "done"),
    task("batch2", 0, "doing"),
    task("recon", 1, "blocked"),
    task("run", 1),
    task("stuck", 1, "blocked"),
    task("old", 1, "dropped"),
    task("cve", 0, "doing"),
  ];
  const groups = groupPlanTasks(tasks, [{ id: 7, taskKey: "recon" }]);
  const ids = (key: keyof typeof groups) =>
    groups[key].map(
      (item) => `${item.task.id}${item.ask ? `#${item.ask}` : ""}`,
    );
  // batch2 has subtasks, so only they are listed.
  expect(ids("wait")).toEqual(["recon#7"]);
  expect(ids("blocked")).toEqual(["stuck"]);
  expect(ids("doing")).toEqual(["cve"]);
  expect(ids("todo")).toEqual(["run#7"]);
  expect(ids("done")).toEqual(["batch1", "old"]);
});

test("every class the Activity page uses has a style rule", async () => {
  const dir = new URL(".", import.meta.url).pathname;
  const page = await Bun.file(`${dir}ActivityPage.tsx`).text();
  const css = await Bun.file(`${dir}styles.css`).text();
  // Literal class names, and the fixed part of templated ones.
  const used = new Set(
    [...page.matchAll(/needs-[a-z-]+[a-z]/g)].map((match) => match[0]),
  );
  // Parts of templated names, styled through their full forms.
  for (const prefix of ["needs-task", "needs-group", "needs-progress"])
    used.delete(prefix);
  const missing = [...used].filter(
    (name) => !new RegExp(`\\.${name}(?![a-z-])`).test(css),
  );
  expect(missing).toEqual([]);
});

test("snooze offers 5 minutes, an hour and tomorrow at 9:00", () => {
  const now = new Date(2026, 10, 17, 21, 30);
  const choices = snoozeChoices(now);
  expect(choices.map((choice) => choice.label)).toEqual([
    "5 min",
    "1 hour",
    "Tomorrow 9:00",
  ]);
  expect(choices[0]!.until.getTime() - now.getTime()).toBe(5 * 60_000);
  expect(choices[1]!.until.getTime() - now.getTime()).toBe(60 * 60_000);
  expect(choices[2]!.until).toEqual(new Date(2026, 10, 18, 9, 0));
  const ask = { snoozedUntil: choices[0]!.until.toISOString() };
  expect(isSnoozed(ask, now.getTime())).toBe(true);
  expect(isSnoozed(ask, choices[0]!.until.getTime() + 1)).toBe(false);
  expect(isSnoozed({ snoozedUntil: null }, now.getTime())).toBe(false);
});
