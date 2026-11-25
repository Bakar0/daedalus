/**
 * Step memory: what a saved workflow's step learned from earlier runs, kept
 * in `steps/<step>.memory.md` beside the step's own file.
 *
 *     ---
 *     step: review
 *     ---
 *
 *     ## Check every delete path for an ownership test
 *     - why: The delete call skipped the owner check and review missed it.
 *     - seen: 2 runs, last 2026-11-20 (feature)
 *     - status: accepted 2026-11-21
 *     - only: release
 *
 * A memory is one instruction with the reason it exists. It is `proposed`
 * until the user accepts it, and an agent starting the step is shown only
 * the accepted ones. There is no memory that belongs to no step.
 */
import { DaedalusError } from "../errors";

export type StepMemoryStatus = "proposed" | "accepted";

export interface StepMemory {
  /** The instruction: the entry's heading. */
  text: string;
  /** One sentence of what happened. */
  why: string;
  /** How many runs showed it. */
  runs: number;
  /** The last day a run showed it, `YYYY-MM-DD`. */
  lastSeen: string;
  /** The workflow of the run that last showed it; null when not recorded. */
  workflow: string | null;
  status: StepMemoryStatus;
  /** The day it was accepted; null while proposed. */
  acceptedOn: string | null;
  /** The one workflow it applies in; null for wherever the step runs. */
  only: string | null;
}

export interface StepMemoryFile {
  step: string;
  /** Most seen first, as the file keeps them. */
  memories: StepMemory[];
}

/** How many memories a step keeps. A full step forgets or promotes one. */
export const STEP_MEMORY_LIMIT = 12;
export const STEP_MEMORY_SUFFIX = ".memory.md";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SEEN = /^(\d+) runs?,(?: last)? (\d{4}-\d{2}-\d{2})(?: \(([^)]+)\))?$/;
const STATUS = /^(proposed|accepted)(?: (\d{4}-\d{2}-\d{2}))?$/;
const FIELD = /^[-*] (why|seen|status|only):[ \t]*(.*)$/;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const sameText = (a: string, b: string) =>
  oneLine(a).toLowerCase() === oneLine(b).toLowerCase();

/** Reads a memory file. Throws with the entry and what is wrong with it. */
export function parseStepMemory(
  source: string,
  fallbackStep: string,
): StepMemoryFile {
  const lines = source.split(/\r?\n/);
  let index = 0;
  let step = fallbackStep;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end === -1)
      throw new DaedalusError("VALIDATION", "The frontmatter is not closed");
    for (const line of lines.slice(1, end)) {
      const match = /^step:\s*(.+)$/.exec(line.trim());
      if (match) step = match[1]!.replace(/^["']|["']$/g, "").trim();
    }
    index = end + 1;
  }
  const memories: StepMemory[] = [];
  let entry: { text: string; fields: Map<string, string> } | undefined;
  const close = () => {
    if (!entry) return;
    const { text, fields } = entry;
    const bad = (problem: string) =>
      new DaedalusError("VALIDATION", `Memory "${text}": ${problem}`);
    const why = fields.get("why");
    if (!why) throw bad("has no 'why:' line saying what happened");
    const seen = SEEN.exec(fields.get("seen") ?? "");
    if (!seen)
      throw bad("needs 'seen: <n> runs, last <YYYY-MM-DD> (<workflow>)'");
    const status = STATUS.exec(fields.get("status") ?? "");
    if (!status)
      throw bad("needs 'status: proposed' or 'status: accepted <YYYY-MM-DD>'");
    memories.push({
      text,
      why,
      runs: Math.max(1, Number(seen[1])),
      lastSeen: seen[2]!,
      workflow: seen[3] ?? null,
      status: status[1] as StepMemoryStatus,
      acceptedOn: status[1] === "accepted" ? (status[2] ?? null) : null,
      only: fields.get("only") || null,
    });
    entry = undefined;
  };
  for (const raw of lines.slice(index)) {
    const heading = /^##\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      close();
      entry = { text: oneLine(heading[1]!), fields: new Map() };
      continue;
    }
    const field = FIELD.exec(raw.trim());
    if (field && entry) entry.fields.set(field[1]!, oneLine(field[2]!));
    else if (raw.trim() && entry)
      throw new DaedalusError(
        "VALIDATION",
        `Memory "${entry.text}": the line "${raw.trim()}" is not a why, seen, status or only line`,
      );
  }
  close();
  if (memories.length > STEP_MEMORY_LIMIT)
    throw new DaedalusError(
      "VALIDATION",
      `${memories.length} memories; a step keeps ${STEP_MEMORY_LIMIT} at most`,
    );
  return { step, memories };
}

/** Most seen first; among equals the most recently seen. */
const ordered = (memories: readonly StepMemory[]): StepMemory[] =>
  [...memories].sort(
    (a, b) => b.runs - a.runs || b.lastSeen.localeCompare(a.lastSeen),
  );

export function renderStepMemory(file: StepMemoryFile): string {
  const entries = ordered(file.memories).map((memory) =>
    [
      `## ${memory.text}`,
      `- why: ${memory.why}`,
      `- seen: ${memory.runs} ${memory.runs === 1 ? "run," : "runs, last"} ${memory.lastSeen}${memory.workflow ? ` (${memory.workflow})` : ""}`,
      `- status: ${memory.status}${memory.status === "accepted" && memory.acceptedOn ? ` ${memory.acceptedOn}` : ""}`,
      ...(memory.only ? [`- only: ${memory.only}`] : []),
    ].join("\n"),
  );
  return `---\nstep: ${file.step}\n---\n\n${entries.join("\n\n")}${entries.length ? "\n" : ""}`;
}

/**
 * The memory a reference names: its number in the file from 1, or its text.
 */
export function findStepMemory(
  file: StepMemoryFile,
  reference: string,
): StepMemory {
  const wanted = reference.trim();
  const found = /^\d+$/.test(wanted)
    ? file.memories[Number(wanted) - 1]
    : file.memories.find((memory) => sameText(memory.text, wanted));
  if (!found)
    throw new DaedalusError(
      "NOT_FOUND",
      `The ${file.step} step has no memory '${wanted}'; 'daedal workflow memory ${file.step}' lists them by number`,
    );
  return found;
}

/**
 * Adds what a run learned, as a proposal. The same instruction seen again
 * raises its count and keeps its status; nothing is added twice.
 */
export function rememberStepMemory(
  file: StepMemoryFile,
  input: {
    text: string;
    why: string;
    day: string;
    workflow: string | null;
    only?: string | null;
  },
): StepMemoryFile {
  const text = oneLine(input.text);
  const why = oneLine(input.why);
  if (!text)
    throw new DaedalusError(
      "VALIDATION",
      "Write the memory as one instruction the next agent can act on",
    );
  if (!why)
    throw new DaedalusError(
      "VALIDATION",
      "Say why in one sentence: what happened in the run that taught this",
    );
  if (!DAY.test(input.day))
    throw new DaedalusError("VALIDATION", `'${input.day}' is not a day`);
  const known = file.memories.find((memory) => sameText(memory.text, text));
  if (known)
    return {
      ...file,
      memories: ordered(
        file.memories.map((memory) =>
          memory === known
            ? {
                ...memory,
                why,
                runs: memory.runs + 1,
                lastSeen: input.day,
                workflow: input.workflow,
              }
            : memory,
        ),
      ),
    };
  if (file.memories.length >= STEP_MEMORY_LIMIT)
    throw new DaedalusError(
      "CONFLICT",
      `The ${file.step} step already keeps ${STEP_MEMORY_LIMIT} memories; forget one or promote one into the step's instructions first`,
    );
  return {
    ...file,
    memories: ordered([
      ...file.memories,
      {
        text,
        why,
        runs: 1,
        lastSeen: input.day,
        workflow: input.workflow,
        status: "proposed",
        acceptedOn: null,
        only: input.only ?? null,
      },
    ]),
  };
}

export function acceptStepMemory(
  file: StepMemoryFile,
  reference: string,
  day: string,
): StepMemoryFile {
  const target = findStepMemory(file, reference);
  return {
    ...file,
    memories: file.memories.map((memory) =>
      memory === target && memory.status !== "accepted"
        ? { ...memory, status: "accepted", acceptedOn: day }
        : memory,
    ),
  };
}

export function forgetStepMemory(
  file: StepMemoryFile,
  reference: string,
): StepMemoryFile {
  const target = findStepMemory(file, reference);
  return {
    ...file,
    memories: file.memories.filter((memory) => memory !== target),
  };
}

/**
 * What an agent starting the step in a workflow is shown: the accepted
 * memories that apply there, most seen first.
 */
export function shownStepMemories(
  file: StepMemoryFile,
  workflow: string,
): StepMemory[] {
  return ordered(
    file.memories.filter(
      (memory) =>
        memory.status === "accepted" &&
        (!memory.only || memory.only === workflow),
    ),
  );
}

/** The accepted memories as the text added under a step's instructions. */
export function stepMemoryText(memories: readonly StepMemory[]): string {
  if (!memories.length) return "";
  return [
    "What earlier runs of this step learned:",
    ...memories.map((memory) => `- ${memory.text} (${memory.why})`),
  ].join("\n");
}
