import { expect, test } from "vitest";
import { groupPlanTasks, markPlanTasks } from "./ActivityPage";

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
