import { expect, test } from "vitest";
import { markPlanTasks } from "./NeedsYouPage";

const task = (
  id: string,
  depth: number,
  state: "todo" | "doing" | "done" = "todo",
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
