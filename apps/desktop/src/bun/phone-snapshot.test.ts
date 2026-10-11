import { describe, expect, test } from "bun:test";
import type { DesktopSnapshotDto } from "@daedalus/protocol";
import { PHONE_BRIEF_CHARACTERS, phoneSnapshot } from "./remote";

const snapshot = (
  agents: Array<{ args: string[] }>,
  descriptions: string[],
): DesktopSnapshotDto =>
  ({
    agents: agents.map((agent, index) => ({ id: `a${index}`, ...agent })),
    tasks: descriptions.map((description, index) => ({
      id: `t${index}`,
      description,
    })),
    workspaces: [],
  }) as unknown as DesktopSnapshotDto;

describe("phoneSnapshot", () => {
  test("a session keeps only its --model from its launch arguments", () => {
    const trimmed = phoneSnapshot(
      snapshot(
        [
          {
            args: [
              "-c",
              `developer_instructions=${"x".repeat(5_000)}`,
              "--model",
              "opus",
            ],
          },
          { args: ["--model=gpt-5", "--yolo"] },
          { args: ["-i"] },
        ],
        [],
      ),
    );
    expect(trimmed.agents.map((agent) => agent.args)).toEqual([
      ["--model", "opus"],
      ["--model=gpt-5"],
      [],
    ]);
  });

  test("a long brief keeps its start and says so; a short one is untouched", () => {
    const long = "y".repeat(PHONE_BRIEF_CHARACTERS + 50);
    const [shortened, short] = phoneSnapshot(
      snapshot([], [long, "Fix it"]),
    ).tasks;
    expect(shortened?.description).toBe(long.slice(0, PHONE_BRIEF_CHARACTERS));
    expect(shortened?.descriptionShortened).toBe(true);
    expect(short?.description).toBe("Fix it");
    expect(short?.descriptionShortened).toBeUndefined();
  });

  test("the Mac's own snapshot is left as it was", () => {
    const original = snapshot(
      [{ args: ["--model", "opus", "-c", "z"] }],
      ["z".repeat(500)],
    );
    phoneSnapshot(original);
    expect(original.agents[0]?.args).toHaveLength(4);
    expect(original.tasks[0]?.description).toHaveLength(500);
  });
});
