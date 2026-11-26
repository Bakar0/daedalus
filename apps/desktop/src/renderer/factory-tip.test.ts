import { expect, test } from "vitest";
import type { FactoryBlockDto } from "@daedalus/protocol";
import { blockTip } from "./factory-tip";

const block = (more: Partial<FactoryBlockDto>): FactoryBlockDto =>
  ({
    key: "j1",
    kind: "task",
    title: "API server",
    state: "todo",
    owner: null,
    detail: null,
    description: null,
    result: null,
    threads: 0,
    questions: [],
    line: null,
    column: 0,
    needs: [],
    startedAt: null,
    inside: null,
    ...more,
  }) as FactoryBlockDto;

test("a box not started says what it waits for and what it was asked", () => {
  expect(
    blockTip(block({ description: "Build the routes." }), ["Contract"], null),
  ).toEqual({
    title: "API server",
    kind: "Task",
    state: "todo",
    stateText: "Not started",
    owner: null,
    started: null,
    needs: ["Contract"],
    parts: [{ label: "Asked to", text: "Build the routes." }],
    outputs: [],
  });
});

test("a finished box says who did it, what came out and its outputs", () => {
  const tip = blockTip(
    block({
      state: "done",
      owner: {
        handle: "api",
        sessionId: "s1",
        sessionName: "api",
        state: "stopped",
      },
      result: "29 tests pass\ncommit = 9439294",
      description: "Build the routes.",
    }),
    ["Contract"],
    "09:12",
  );
  expect(tip).toMatchObject({
    stateText: "Done",
    owner: "api",
    started: "09:12",
    needs: [],
    parts: [{ label: "Came out", text: "29 tests pass" }],
    outputs: [{ name: "commit", value: "9439294" }],
  });
});

test("a held or failed box says why", () => {
  expect(
    blockTip(
      block({ state: "waiting", detail: "Push to a new repo?" }),
      [],
      null,
    ).parts,
  ).toEqual([{ label: "Why", text: "Push to a new repo?" }]);
});

test("a step names its kind and a box at work keeps its note off the card", () => {
  const tip = blockTip(
    block({ kind: "step", state: "doing", detail: "Run the tests" }),
    [],
    null,
  );
  expect(tip.kind).toBe("Step");
  expect(tip.parts).toEqual([]);
});
