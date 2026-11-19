import { expect, test } from "vitest";
import {
  isSnoozed,
  markPlanTasks,
  paneAskCount,
  snoozeChoices,
} from "./threads-shared";

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

test("every class the Threads pane uses has a style rule", async () => {
  const dir = new URL(".", import.meta.url).pathname;
  const page = await Bun.file(`${dir}ThreadsPane.tsx`).text();
  const css = await Bun.file(`${dir}styles.css`).text();
  const used = new Set(
    [...page.matchAll(/threads-[a-z-]+[a-z]/g)].map((match) => match[0]),
  );
  // Element ids, searches and a module name, not classes.
  for (const id of [
    "threads-draft",
    "threads-search-current",
    "threads-shared",
  ])
    used.delete(id);
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

test("the Threads tab counts only what its pane shows", () => {
  const counts = {
    bySession: new Map([
      ["lead", 1],
      ["member", 2],
      ["elsewhere", 4],
    ]),
  };
  // Another session's question in the workspace lights nothing here.
  expect(paneAskCount(counts, ["quiet"])).toBe(0);
  expect(paneAskCount(counts, ["lead"])).toBe(1);
  // A lead's pane shows its members' threads too.
  expect(paneAskCount(counts, ["lead", "member"])).toBe(3);
});
