/**
 * A plan's flow: which tasks need which, written as a Mermaid flowchart in
 * the plan's `## Flow` section and joined to the tasks by id.
 *
 *     ## Flow
 *
 *     ```mermaid
 *     flowchart LR
 *       design --> api & page & mig --> proof
 *     ```
 *
 * Only what orders work is read: node ids, links and `&`. Labels, shapes,
 * subgraphs and styling are allowed and mean nothing here. A task the flow
 * does not name needs nothing.
 */
import { planTasks, type PlanDocument, type PlanTask } from "./plans";

export interface PlanFlow {
  /** Whether the plan has a flow at all. */
  present: boolean;
  /** Node id to the ids it needs done first. */
  needs: Map<string, string[]>;
  /** Every id the flow names. */
  nodes: Set<string>;
  /** Lines that could not be read, and a cycle if there is one. */
  errors: string[];
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z]*)/;
const ID = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
/** Statements that draw and order nothing. */
const SKIPPED =
  /^(flowchart|graph|subgraph|end|direction|classDef|class|style|linkStyle|click|accTitle|accDescr)\b/;
/**
 * A link: `-->`, `---`, `-.->`, `==>`, `--o`, `--x`, with any length, and
 * the forms with text inside (`-- text -->`, `-. text .->`, `== text ==>`).
 */
const LINK =
  /\s*(?:--[^->|&]+-+[>ox]?|-\.[^.>|&]+\.-+[>ox]?|==[^=>|&]+=+[>ox]?|<?-{2,}[>ox]?|<?-\.+-[>ox]?|<?={2,}[>ox]?)\s*/;

/** The lines of the first mermaid fence under `## Flow`, or undefined. */
function flowLines(source: string): string[] | undefined {
  const lines = source.split(/\r?\n/);
  let inFlow = false;
  let fence: string | undefined;
  let collecting = false;
  const out: string[] = [];
  for (const text of lines) {
    if (fence) {
      if (text.trim().startsWith(fence)) {
        if (collecting) return out;
        fence = undefined;
      } else if (collecting) out.push(text);
      continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      inFlow =
        heading[1]!.length === 2 && heading[2]!.trim().toLowerCase() === "flow";
      continue;
    }
    const opened = FENCE.exec(text);
    if (opened) {
      fence = opened[1]!;
      collecting = inFlow && opened[2]!.toLowerCase() === "mermaid";
    }
  }
  return collecting ? out : undefined;
}

/** A node's id, without its shape and text: `api["Cart API"]` is `api`. */
function nodeId(text: string): string | undefined {
  const id = text
    .trim()
    .replace(/:::.*$/, "")
    .replace(/[[({>].*$/s, "")
    .trim();
  return ID.test(id) ? id : undefined;
}

/** Text in quotes and link labels can hold anything; neither orders work. */
const withoutText = (line: string) =>
  line
    .replace(/%%.*$/, "")
    .replace(/"[^"]*"/g, '""')
    .replace(/\|[^|]*\|/g, " ")
    .replace(/;\s*$/, "")
    .trim();

function cycleIn(needs: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    state.set(id, "open");
    path.push(id);
    for (const need of needs.get(id) ?? []) {
      const found = visit(need);
      if (found) return found;
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of needs.keys()) {
    const found = visit(id);
    if (found) return found;
  }
  return undefined;
}

export function parsePlanFlow(source: string): PlanFlow {
  const flow: PlanFlow = {
    present: false,
    needs: new Map(),
    nodes: new Set(),
    errors: [],
  };
  const lines = flowLines(source);
  if (!lines) return flow;
  flow.present = true;
  for (const raw of lines) {
    const line = withoutText(raw);
    if (!line || SKIPPED.test(line)) continue;
    const groups = line
      .split(LINK)
      .map((group) => group.split("&").map((node) => nodeId(node)));
    if (groups.some((group) => group.some((id) => id === undefined))) {
      flow.errors.push(`The flow line "${raw.trim()}" could not be read`);
      continue;
    }
    const ids = groups as string[][];
    for (const id of ids.flat()) flow.nodes.add(id);
    for (let index = 1; index < ids.length; index += 1)
      for (const to of ids[index]!) {
        const needs = flow.needs.get(to) ?? [];
        for (const from of ids[index - 1]!)
          if (from !== to && !needs.includes(from)) needs.push(from);
        flow.needs.set(to, needs);
      }
  }
  const cycle = cycleIn(flow.needs);
  if (cycle) {
    flow.errors.push(
      `The flow goes in a circle: ${[...cycle].reverse().join(" --> ")}`,
    );
    // A circle orders nothing; the tasks are drawn in the file's order.
    flow.needs = new Map();
  }
  return flow;
}

/**
 * The column each of a level's tasks is drawn in: one after the last of the
 * tasks it needs, counting only needs among these tasks. Tasks with the same
 * needs share a column, which is how parallel work reads.
 */
export function flowColumns(
  ids: readonly string[],
  flow: PlanFlow,
): Map<string, number> {
  const here = new Set(ids);
  const columns = new Map<string, number>();
  const column = (id: string): number => {
    const known = columns.get(id);
    if (known !== undefined) return known;
    columns.set(id, 0);
    const needs = (flow.needs.get(id) ?? []).filter((need) => here.has(need));
    const value = needs.length
      ? Math.max(...needs.map((need) => column(need))) + 1
      : 0;
    columns.set(id, value);
    return value;
  };
  for (const id of ids) column(id);
  return columns;
}
