import type { FactoryBlockDto } from "@daedalus/protocol";

const STATE: Record<FactoryBlockDto["state"], string> = {
  draft: "Draft, not ready",
  todo: "Not started",
  doing: "In progress",
  waiting: "Waits for you",
  done: "Done",
  blocked: "Failed",
  dropped: "Skipped",
};

const KIND: Record<FactoryBlockDto["kind"], string> = {
  step: "Step",
  task: "Task",
  plan: "Plan",
  agent: "Agent",
};

const clip = (text: string, most: number): string => {
  const flat = text.trim().replace(/\n{3,}/g, "\n\n");
  return flat.length > most ? `${flat.slice(0, most).trimEnd()}…` : flat;
};

/** A line of a result that names an output: `commit = 9439294`. */
const OUTPUT = /^([A-Za-z][\w-]*) = (.+)$/;

export interface BlockTip {
  title: string;
  kind: string;
  state: FactoryBlockDto["state"];
  stateText: string;
  /** The handle of who does it, without the `@`. */
  owner: string | null;
  started: string | null;
  /** The titles of the boxes it still waits for. */
  needs: readonly string[];
  /** What it says, in reading order: what came out, why, what was asked. */
  parts: readonly { label: string; text: string }[];
  /** The outputs it gave, taken out of its result. */
  outputs: readonly { name: string; value: string }[];
}

/**
 * What a box's card says when the pointer rests on it: its whole title,
 * its state, who does it and since when, what it waits for, and what came
 * out or what it was asked to do. `needs` are the titles of the boxes it
 * waits for, and `started` is the start time as the reader's clock shows
 * it.
 */
export function blockTip(
  block: FactoryBlockDto,
  needs: readonly string[],
  started: string | null,
): BlockTip {
  const open = block.state !== "done" && block.state !== "dropped";
  const parts: { label: string; text: string }[] = [];
  const outputs: { name: string; value: string }[] = [];
  if (block.state === "done") {
    const said: string[] = [];
    for (const line of (block.result ?? "").split("\n")) {
      const output = OUTPUT.exec(line.trim());
      if (output) outputs.push({ name: output[1]!, value: output[2]! });
      else said.push(line);
    }
    const text = clip(said.join("\n"), 600);
    if (text) parts.push({ label: "Came out", text });
  } else if (block.detail && block.state !== "doing") {
    parts.push({ label: "Why", text: clip(block.detail, 300) });
  }
  if (open && block.description)
    parts.push({ label: "Asked to", text: clip(block.description, 400) });
  return {
    title: block.title,
    kind: KIND[block.kind],
    state: block.state,
    stateText: STATE[block.state],
    owner: block.owner?.handle ?? null,
    started,
    needs: block.state === "todo" || block.state === "draft" ? needs : [],
    parts,
    outputs,
  };
}
