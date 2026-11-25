import { describe, expect, test } from "bun:test";
import {
  acceptStepMemory,
  forgetStepMemory,
  parseStepMemory,
  rememberStepMemory,
  renderStepMemory,
  shownStepMemories,
  STEP_MEMORY_LIMIT,
  stepMemoryText,
  type StepMemoryFile,
} from "./step-memory";

const FILE = `---
step: review
---

## Check every delete path for an ownership test
- why: The delete call skipped the owner check and review missed it.
- seen: 2 runs, last 2026-11-20 (feature)
- status: accepted 2026-11-21

## Run the failing case before reading the fix
- why: Two fixes passed review and did not fix the reported case.
- seen: 1 run, 2026-11-18 (fix)
- status: proposed
- only: fix
`;

const empty: StepMemoryFile = { step: "review", memories: [] };

describe("step memory", () => {
  test("reads a file and writes it back unchanged", () => {
    const file = parseStepMemory(FILE, "other");
    expect(file.step).toBe("review");
    expect(file.memories).toHaveLength(2);
    expect(file.memories[0]).toMatchObject({
      runs: 2,
      lastSeen: "2026-11-20",
      workflow: "feature",
      status: "accepted",
      acceptedOn: "2026-11-21",
      only: null,
    });
    expect(file.memories[1]).toMatchObject({ status: "proposed", only: "fix" });
    expect(renderStepMemory(file)).toBe(FILE);
  });

  test("a memory without a why, a seen or a status does not read", () => {
    const without = (line: string) =>
      FILE.split("\n")
        .filter((text) => !text.startsWith(line))
        .join("\n");
    expect(() => parseStepMemory(without("- why: The delete"), "x")).toThrow(
      "why",
    );
    expect(() => parseStepMemory(without("- seen: 2"), "x")).toThrow("seen");
    expect(() => parseStepMemory(without("- status: accepted"), "x")).toThrow(
      "status",
    );
    expect(() =>
      parseStepMemory(FILE.replace("- only: fix", "some prose"), "x"),
    ).toThrow("some prose");
  });

  test("remembering proposes; the same instruction again raises its count", () => {
    const input = {
      text: "Check  the delete path",
      why: "It was missed.",
      day: "2026-11-23",
      workflow: "feature",
    };
    const once = rememberStepMemory(empty, input);
    expect(once.memories[0]).toMatchObject({ status: "proposed", runs: 1 });
    const twice = rememberStepMemory(once, {
      ...input,
      text: "check the DELETE path",
      day: "2026-11-24",
    });
    expect(twice.memories).toHaveLength(1);
    expect(twice.memories[0]).toMatchObject({
      runs: 2,
      lastSeen: "2026-11-24",
      status: "proposed",
    });
  });

  test("a memory needs an instruction and a why", () => {
    const input = { day: "2026-11-23", workflow: null };
    expect(() =>
      rememberStepMemory(empty, { ...input, text: " ", why: "x" }),
    ).toThrow("instruction");
    expect(() =>
      rememberStepMemory(empty, { ...input, text: "x", why: "" }),
    ).toThrow("why");
  });

  test("a full step refuses another memory", () => {
    let file = empty;
    for (let index = 0; index < STEP_MEMORY_LIMIT; index += 1)
      file = rememberStepMemory(file, {
        text: `Memory ${index}`,
        why: "Seen.",
        day: "2026-11-23",
        workflow: null,
      });
    expect(() =>
      rememberStepMemory(file, {
        text: "One more",
        why: "Seen.",
        day: "2026-11-23",
        workflow: null,
      }),
    ).toThrow("forget one or promote one");
  });

  test("an agent is shown only accepted memories that apply to its workflow", () => {
    const file = parseStepMemory(FILE, "review");
    expect(shownStepMemories(file, "feature").map((item) => item.text)).toEqual(
      ["Check every delete path for an ownership test"],
    );
    const accepted = acceptStepMemory(file, "2", "2026-11-23");
    expect(accepted.memories[1]).toMatchObject({
      status: "accepted",
      acceptedOn: "2026-11-23",
    });
    expect(shownStepMemories(accepted, "feature")).toHaveLength(1);
    expect(shownStepMemories(accepted, "fix")).toHaveLength(2);
    expect(stepMemoryText(shownStepMemories(accepted, "feature"))).toBe(
      "What earlier runs of this step learned:\n- Check every delete path for an ownership test (The delete call skipped the owner check and review missed it.)",
    );
    expect(stepMemoryText([])).toBe("");
  });

  test("forgetting takes a memory out by number or by its text", () => {
    const file = parseStepMemory(FILE, "review");
    expect(forgetStepMemory(file, "1").memories).toHaveLength(1);
    expect(
      forgetStepMemory(file, "run the failing case before reading the fix")
        .memories,
    ).toHaveLength(1);
    expect(() => forgetStepMemory(file, "9")).toThrow("no memory");
  });
});
