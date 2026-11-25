import { expect, test } from "bun:test";
import {
  stepFromHook,
  turnsFromSteps,
  type SessionStep,
} from "./session-steps";

const step = (
  kind: SessionStep["kind"],
  at: string,
  more: Partial<SessionStep> = {},
): SessionStep => ({
  kind,
  tool: null,
  detail: null,
  file: null,
  failed: false,
  durationMs: null,
  at,
  ...more,
});

test("a finished tool call is a step, with the file an edit wrote", () => {
  expect(
    stepFromHook("PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: "/repo/carts/service.ts" },
    }),
  ).toEqual({
    kind: "tool",
    tool: "Edit",
    detail: "service.ts",
    file: "/repo/carts/service.ts",
    failed: false,
    durationMs: null,
  });
  expect(
    stepFromHook("PostToolUseFailure", {
      tool_name: "Bash",
      tool_input: { command: "bun test\npackages/core" },
      duration_ms: 41_200.4,
    }),
  ).toMatchObject({
    tool: "Bash",
    detail: "bun test",
    file: null,
    failed: true,
    durationMs: 41_200,
  });
});

test("a read is not an edited file, and a failed edit wrote nothing", () => {
  expect(
    stepFromHook("PostToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/repo/a.ts" },
    })?.file,
  ).toBeNull();
  expect(
    stepFromHook("PostToolUseFailure", {
      tool_name: "Write",
      tool_input: { file_path: "/repo/a.ts" },
    })?.file,
  ).toBeNull();
});

test("only the hooks that mark progress are steps", () => {
  expect(stepFromHook("PreToolUse", { tool_name: "Bash" })).toBeUndefined();
  expect(stepFromHook("PostToolUse", {})).toBeUndefined();
  expect(stepFromHook("UserPromptSubmit", { prompt: "Cap it" })).toMatchObject({
    kind: "prompt",
    detail: "Cap it",
  });
  expect(stepFromHook("Stop", {})).toMatchObject({ kind: "stop" });
});

test("a prompt starts a turn and a stop ends it", () => {
  const turns = turnsFromSteps([
    step("prompt", "10:00"),
    step("tool", "10:01", { tool: "Read", detail: "a.ts" }),
    step("tool", "10:02", { tool: "Edit", detail: "a.ts", file: "/r/a.ts" }),
    step("tool", "10:03", { tool: "Edit", detail: "a.ts", file: "/r/a.ts" }),
    step("stop", "10:04"),
    step("prompt", "10:10"),
    step("tool", "10:11", { tool: "Bash", detail: "bun test" }),
  ]);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({
    startedAt: "10:00",
    endedAt: "10:04",
    toolCalls: 3,
    files: ["/r/a.ts"],
  });
  expect(turns[0]!.steps.map((one) => one.tool)).toEqual([
    "Read",
    "Edit",
    "Edit",
  ]);
  expect(turns[1]).toMatchObject({ endedAt: null, toolCalls: 1 });
});

test("work after a stop, and a prompt typed mid-turn, stay in the turn", () => {
  const turns = turnsFromSteps([
    step("prompt", "10:00"),
    step("tool", "10:01", { tool: "Agent" }),
    step("prompt", "10:02"),
    step("stop", "10:03"),
    step("tool", "10:05", { tool: "Read" }),
  ]);
  expect(turns).toHaveLength(1);
  expect(turns[0]).toMatchObject({ endedAt: null, toolCalls: 2 });
});

test("tool calls before any prompt make a turn of their own", () => {
  const turns = turnsFromSteps([
    step("stop", "09:59"),
    step("tool", "10:00", { tool: "Bash" }),
    step("stop", "10:01"),
  ]);
  expect(turns).toEqual([
    {
      startedAt: "10:00",
      endedAt: "10:01",
      toolCalls: 1,
      steps: [
        {
          tool: "Bash",
          detail: null,
          failed: false,
          durationMs: null,
          at: "10:00",
        },
      ],
      files: [],
    },
  ]);
});
