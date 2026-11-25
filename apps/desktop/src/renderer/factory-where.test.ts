import { describe, expect, test } from "bun:test";
import type {
  FactoryBlockDto,
  FactoryLevelDto,
  FactoryPageDto,
} from "@daedalus/protocol";
import { factoryWhere } from "./factory-where";

const owner = (sessionId: string) => ({
  handle: sessionId,
  sessionId,
  sessionName: sessionId,
  state: "idle" as const,
});

const block = (
  key: string,
  over: Partial<FactoryBlockDto> = {},
): FactoryBlockDto => ({
  key,
  kind: "task",
  title: key,
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
  ...over,
});

const level = (
  kind: FactoryLevelDto["kind"],
  title: string,
  blocks: FactoryBlockDto[],
): FactoryLevelDto => ({ kind, title, owner: null, ordered: true, blocks });

const steps = (prefix: string) => [
  block(`${prefix}/red`, { kind: "step", title: "red", state: "done" }),
  block(`${prefix}/green`, { kind: "step", title: "green", state: "doing" }),
];

const plan = level("plan", "Bill splitter", [
  block("money", { state: "done", owner: owner("s-money") }),
  block("tip", {
    title: "Tip calculation",
    state: "doing",
    owner: owner("s-tip"),
    inside: level("workflow", "change", steps("tip")),
  }),
  // Not started: it only inherits the plan's owner.
  block("cli", { owner: owner("s-lead") }),
]);

const page: FactoryPageDto = {
  agents: [
    {
      sessionId: "s-lead",
      title: "lead",
      state: "working",
      waiting: 0,
      level: level("workflow", "do", [
        block("agent:s-lead/find", {
          kind: "step",
          state: "done",
          // A member of its team, started in this step.
          inside: {
            ...level("workflow", "core-team", steps("agent:s-member")),
            owner: owner("s-member"),
          },
        }),
        block("agent:s-lead/build", {
          kind: "step",
          title: "build",
          state: "doing",
          inside: plan,
        }),
      ]),
    },
    {
      sessionId: "s-bare",
      title: "bare",
      state: "idle",
      waiting: 0,
      level: level("agent", "bare", []),
    },
  ],
  plans: [],
  working: 1,
  waiting: 0,
  finished: 0,
};

describe("factoryWhere", () => {
  test("an agent with a row is at the step of its workflow", () => {
    expect(factoryWhere(page, "s-lead")).toEqual({
      row: "agent:s-lead",
      path: [],
      leaf: "agent:s-lead/build",
      labels: ["do", "build"],
    });
  });

  test("a worker is at its task's step, under the row of the plan's owner", () => {
    expect(factoryWhere(page, "s-tip")).toEqual({
      row: "agent:s-lead",
      path: ["agent:s-lead/build", "tip"],
      leaf: "tip/green",
      labels: ["Bill splitter", "Tip calculation", "green"],
    });
  });

  test("a worker with no workflow is at its task", () => {
    expect(factoryWhere(page, "s-money")).toMatchObject({
      path: ["agent:s-lead/build"],
      leaf: "money",
      labels: ["Bill splitter", "money"],
    });
  });

  test("an agent started by another is under that agent's step", () => {
    expect(factoryWhere(page, "s-member")).toEqual({
      row: "agent:s-lead",
      path: ["agent:s-lead/find"],
      leaf: "agent:s-member/green",
      labels: ["core-team", "green"],
    });
  });

  test("an agent with no workflow has a row and no box", () => {
    expect(factoryWhere(page, "s-bare")).toEqual({
      row: "agent:s-bare",
      path: [],
      leaf: undefined,
      labels: [],
    });
  });

  test("a session that is nowhere on the page", () => {
    expect(factoryWhere(page, "s-none")).toBeUndefined();
    expect(factoryWhere(undefined, "s-lead")).toBeUndefined();
  });
});
