import { describe, expect, test } from "vitest";
import { addToSteps } from "./workflow-steps-text";

describe("adding to a workflow's steps", () => {
  test("a [a, b] list gains the entry at its end", () => {
    expect(
      addToSteps("---\nname: f\nsteps: [plan, build]\n---\n", "@release"),
    ).toBe("---\nname: f\nsteps: [plan, build, @release]\n---\n");
    expect(addToSteps("---\nsteps: []\n---\n", "plan")).toBe(
      "---\nsteps: [plan]\n---\n",
    );
  });

  test("a block list gains a line with the same indent", () => {
    expect(
      addToSteps("---\nsteps:\n    - plan\nwhen: x\n---\n", "@release"),
    ).toBe("---\nsteps:\n    - plan\n    - @release\nwhen: x\n---\n");
  });

  test("steps: dynamic, or no steps field, becomes a list of the entry", () => {
    expect(addToSteps("---\nname: f\nsteps: dynamic\n---\n", "plan")).toBe(
      "---\nname: f\nsteps: [plan]\n---\n",
    );
    expect(addToSteps("---\nname: f\n---\nBody\n", "@release")).toBe(
      "---\nname: f\nsteps: [@release]\n---\nBody\n",
    );
  });
});
