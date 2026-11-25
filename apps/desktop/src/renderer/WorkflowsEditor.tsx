/**
 * The Workflows page: the user's workflows, steps, tools and choosing rules.
 * Every workflow is drawn as its steps in a row; Steps and Tools are cards.
 * What is picked opens on the right as a read view and is edited as the
 * markdown it is. Daedalus checks a
 * workflow or step the way a run reads it and refuses to save one a run could
 * not use, with the reason. Examples to copy are in the docs the header links
 * to.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  WorkflowFileDto,
  WorkflowFileKindDto,
  WorkflowFilesDto,
} from "@daedalus/protocol";
import { GATE_LABELS } from "./workflow-gates";
import {
  MarkdownView,
  type StepMemoryAction,
  StepView,
  ToolView,
  WorkflowView,
} from "./FileViews";
import { WorkflowIcon } from "./WorkflowPane";
import { addToSteps, addToTools } from "./workflow-steps-text";
import type { DesktopClient } from "./client-types";
import { askConfirm } from "./dialogs";
import { confirmDiscard, DOCS_URL, FileDetail } from "./FileEditorParts";
import "./workflows-page.css";

/**
 * The name of the one home of workflows, steps and tools, as the sidebar and
 * the tab show it.
 */
export const METHODS_TITLE = "Workflows";

/** What is open on the right. A null name is a new file not saved yet. */
type Selection =
  | { kind: NamedKind; name: string | null }
  | { kind: "choosing" }
  /** Nothing is open. */
  | { kind: "none" };

const NONE: Selection = { kind: "none" };

type NamedKind = "flow" | "step" | "tool";

const NOUN: Record<NamedKind, string> = {
  flow: "workflow",
  step: "step",
  tool: "tool",
};

const NEW_FLOW = `---
name: new-workflow
description: What this workflow is for
when: The work it fits, in a sentence
steps: [build, check]
---
`;

const NEW_STEP = `---
name: new-step
description: What this step is for
---

What to do in this step, or one line naming a command or skill.
`;

const NEW_TOOL = `---
name: new-tool
description: What an agent uses this for
---

How to use it: the command to run, the login it needs, what to avoid.
`;

const NEW_TEXT: Record<NamedKind, string> = {
  flow: NEW_FLOW,
  step: NEW_STEP,
  tool: NEW_TOOL,
};

const listOf = (files: WorkflowFilesDto, kind: NamedKind) =>
  kind === "flow" ? files.flows : kind === "step" ? files.steps : files.tools;

function textOf(files: WorkflowFilesDto, selection: Selection): string {
  switch (selection.kind) {
    case "none":
      return "";
    case "choosing":
      return files.choosing.text;
    default:
      if (selection.name === null) return NEW_TEXT[selection.kind];
      return (
        listOf(files, selection.kind).find(
          (item) => item.name === selection.name,
        )?.text ?? ""
      );
  }
}

function titleOf(selection: Selection): string {
  switch (selection.kind) {
    case "none":
      return "";
    case "choosing":
      return "Choosing rules";
    default:
      return selection.name ?? `New ${NOUN[selection.kind]}`;
  }
}

const HINTS: Record<Selection["kind"], string> = {
  flow: "Frontmatter: name, description, when, steps: [a, b] or steps: dynamic (the agent names its own), and optionally loop: <step> and until. @name in steps includes another workflow. Runs already started keep their copy; a change applies from the next run.",
  step: "Frontmatter: name, description, and optionally gate: start (you give the go-ahead before it starts) or gate: result (you approve what it produced), and tools: [a, b] (tools the step suggests; the agent may use others). The body is what the agent does in this step.",
  tool: "Frontmatter: name and description (what an agent uses it for). The body is how to use it. A step that lists it under tools shows the agent this description; daedal tool show <name> prints the body.",
  choosing:
    "The rules an agent reads, in order, to pick a workflow for the work.",
  none: "",
};

/** How many of a step's memories wait for the user to accept or forget. */
const toReview = (step: WorkflowFileDto) =>
  (step.memories ?? []).filter((memory) => memory.status === "proposed").length;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A workflow's steps with included workflows expanded, as a run lists them.
 * `seen` stops a loop of workflows including each other, which the file
 * list flags anyway.
 */
function expandedSteps(
  flow: WorkflowFileDto,
  flows: WorkflowFileDto[],
  seen: string[] = [flow.name],
): string[] {
  return (flow.steps ?? []).flatMap((entry) => {
    if (!entry.startsWith("@")) return [entry];
    const name = entry.slice(1);
    const included = flows.find((item) => item.name === name);
    if (!included || seen.includes(name)) return [];
    return expandedSteps(included, flows, [...seen, name]);
  });
}

/**
 * "6 steps · 1 gate", counting included workflows' steps, or "dynamic" for
 * a workflow whose agent names them.
 */
function flowMeta(
  flow: WorkflowFileDto,
  flows: WorkflowFileDto[],
  steps: WorkflowFileDto[],
): string {
  if (flow.dynamic) return "dynamic";
  const names = expandedSteps(flow, flows);
  const gates = names.filter(
    (name) => steps.find((step) => step.name === name)?.gate,
  ).length;
  return [plural(names.length, "step"), gates ? plural(gates, "gate") : ""]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Under a workflow's markdown while it is edited: every step and every
 * other workflow, marked with the workflow icon. Clicking one adds it to
 * the end of `steps`, a workflow as `@name`.
 */
export function StepPicker({
  files,
  onAdd,
  self,
}: {
  files: WorkflowFilesDto;
  onAdd: (entry: string) => void;
  /** The workflow being edited, which may not include itself. */
  self: string | null;
}) {
  const steps = files.steps.filter((step) => !step.problem);
  const flows = files.flows.filter(
    (flow) => !flow.problem && !flow.dynamic && flow.name !== self,
  );
  if (!steps.length && !flows.length) return null;
  return (
    <div aria-label="Add to steps" className="step-picker" role="group">
      <span className="step-picker-label">Add to steps</span>
      {steps.map((step) => (
        <button
          className="quiet step-picker-item"
          key={`step:${step.name}`}
          onClick={() => onAdd(step.name)}
          title={step.description || step.name}
          type="button"
        >
          {step.name}
        </button>
      ))}
      {flows.map((flow) => (
        <button
          className="quiet step-picker-item workflow"
          key={`flow:${flow.name}`}
          onClick={() => onAdd(`@${flow.name}`)}
          title={`Include workflow '${flow.name}' as @${flow.name}${flow.description ? `: ${flow.description}` : ""}`}
          type="button"
        >
          <WorkflowIcon />
          {flow.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Under a step's markdown while it is edited: every tool the step does not
 * suggest yet. Clicking one adds it to the end of `tools`.
 */
export function ToolPicker({
  draft,
  onAdd,
  tools,
}: {
  draft: string;
  onAdd: (name: string) => void;
  tools: WorkflowFileDto[];
}) {
  const listed = new Set(
    (/^tools:[ \t]*\[([^\]\n]*)\]/m.exec(draft)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim()),
  );
  const open = tools.filter((tool) => !tool.problem && !listed.has(tool.name));
  if (!open.length) return null;
  return (
    <div aria-label="Suggest a tool" className="step-picker" role="group">
      <span className="step-picker-label">Suggest a tool</span>
      {open.map((tool) => (
        <button
          className="quiet step-picker-item"
          key={tool.name}
          onClick={() => onAdd(tool.name)}
          title={tool.description || tool.name}
          type="button"
        >
          {tool.name}
        </button>
      ))}
    </div>
  );
}

const TABS: { kind: NamedKind; title: string }[] = [
  { kind: "flow", title: "Workflows" },
  { kind: "step", title: "Steps" },
  { kind: "tool", title: "Tools" },
];

/** What a gate says on a step's box: who acts, in two words. */
const GATE_CHIP = { start: "you start it", result: "you approve" } as const;

/** The same on a workflow's line, under the step's name. */
const GATE_CAPTION = {
  start: "You start it",
  result: "You approve it",
} as const;

function Problem({ text }: { text: string }) {
  return (
    <span className="workflows-problem-mark" title={text}>
      !
    </span>
  );
}

/** A step's gate and the tools it suggests, as chips on its card. */
function StepChips({ step }: { step: WorkflowFileDto }) {
  if (!step.gate && !step.tools?.length) return null;
  return (
    <span className="wf-chips">
      {step.gate && (
        <span className="wf-chip gate" title={GATE_LABELS[step.gate].title}>
          {GATE_CHIP[step.gate]}
        </span>
      )}
      {(step.tools ?? []).map((tool) => (
        <span className="wf-chip tool" key={tool}>
          {tool}
        </span>
      ))}
    </span>
  );
}

/** The wire from the last box of one line to the first box of the next. */
interface WrapWire {
  /** The step the wire runs into. */
  index: number;
  path: string;
}

/** How far down a box its wire meets it. */
const WIRE_Y = 32;

/** How far a box's port sticks out of its side. */
const PORT = 4;

/**
 * A wire for each step that starts a new line: out of the box before it,
 * down into the gap between the lines, back to the left edge, and into the
 * step. Positions are read from the laid-out list.
 */
function wrapWires(list: HTMLElement): WrapWire[] {
  const items = Array.from(list.children).filter(
    (child): child is HTMLElement => child.classList.contains("wf-step"),
  );
  const wires: WrapWire[] = [];
  let bottom = 0;
  items.forEach((item, index) => {
    const before = items[index - 1];
    const box = item.querySelector<HTMLElement>("button");
    const beforeBox = before?.querySelector<HTMLElement>("button");
    if (before && box && beforeBox && item.offsetTop > before.offsetTop) {
      const x1 = beforeBox.offsetLeft + beforeBox.offsetWidth + PORT;
      const y1 = before.offsetTop + WIRE_Y;
      const x2 = box.offsetLeft - PORT;
      const y2 = item.offsetTop + WIRE_Y;
      const right = x1 + 12;
      const left = Math.max(x2 - 12, 1);
      const middle = Math.round((bottom + item.offsetTop) / 2);
      const r = 6;
      wires.push({
        index,
        path: [
          `M${x1} ${y1}H${right - r}Q${right} ${y1} ${right} ${y1 + r}`,
          `V${middle - r}Q${right} ${middle} ${right - r} ${middle}`,
          `H${left + r}Q${left} ${middle} ${left} ${middle + r}`,
          `V${y2 - r}Q${left} ${y2} ${left + r} ${y2}H${x2}`,
        ].join(""),
      });
      bottom = 0;
    }
    bottom = Math.max(bottom, item.offsetTop + item.offsetHeight);
  });
  return wires;
}

/**
 * One workflow drawn as its steps in order, a wire between each two. A box
 * opens its step on the right, an included workflow opens that workflow,
 * and the heading opens the workflow itself.
 */
export function FlowLine({
  detail,
  files,
  flow,
  onFlow,
  onStep,
  selected,
  selectedStep,
}: {
  /** What is open from this workflow, shown under its line. */
  detail?: ReactNode;
  files: WorkflowFilesDto;
  flow: WorkflowFileDto;
  onFlow: (name: string) => void;
  onStep: (name: string) => void;
  selected: boolean;
  selectedStep: string | null;
}) {
  const row = useRef<HTMLElement>(null);
  const line = useRef<HTMLOListElement>(null);
  const [wraps, setWraps] = useState<WrapWire[]>([]);
  // Picked from somewhere else, such as a step's "Used by": bring it in view.
  useEffect(() => {
    if (selected)
      row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected]);
  // A line too long for the page breaks; a wire joins the two halves.
  useEffect(() => {
    const list = line.current;
    if (!list) return;
    const measure = () => {
      const next = wrapWires(list);
      setWraps((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [flow.steps]);
  const names = flow.steps ?? [];
  const gates = names.filter(
    (name) => files.steps.find((item) => item.name === name)?.gate,
  ).length;
  return (
    <section className={`wf-row${selected ? " selected" : ""}`} ref={row}>
      <header className="wf-row-head">
        <button
          aria-current={selected ? "true" : undefined}
          className="wf-row-title"
          onClick={() => onFlow(flow.name)}
          type="button"
        >
          <b>
            {flow.name}
            {flow.problem && <Problem text={flow.problem} />}
          </b>
          <span>{flow.when || flow.description}</span>
        </button>
        {!flow.dynamic && (
          <span className="wf-row-meta">
            <span>{plural(names.length, "step")}</span>
            {gates > 0 && (
              <span className="gate">
                {gates === 1 ? "1 waits for you" : `${gates} wait for you`}
              </span>
            )}
          </span>
        )}
      </header>
      {flow.dynamic ? (
        <p className="wf-dynamic">
          The agent names its steps each run, for the work in front of it.
        </p>
      ) : (
        <ol className="wf-line" ref={line}>
          {wraps.length > 0 && (
            <svg aria-hidden="true" className="wf-wraps">
              {wraps.map((wire) => (
                <path d={wire.path} key={wire.index} />
              ))}
            </svg>
          )}
          {names.map((entry, index) => {
            const wrapped = wraps.some((wire) => wire.index === index)
              ? " wraps"
              : "";
            if (entry.startsWith("@")) {
              const name = entry.slice(1);
              const included = files.flows.find((item) => item.name === name);
              return (
                <li className={`wf-step${wrapped}`} key={entry}>
                  <span aria-hidden="true" className="wf-wire" />
                  <button
                    className={`wf-box included${included ? "" : " missing"}`}
                    onClick={() => onFlow(name)}
                    title={included?.description || name}
                    type="button"
                  >
                    <span className="wf-node-text">
                      <b>
                        <WorkflowIcon />
                        {name}
                      </b>
                      <span className="wf-node-sub">
                        {included
                          ? included.dynamic
                            ? "A workflow with its own steps"
                            : `A workflow of ${plural(included.steps?.length ?? 0, "step")}`
                          : "No workflow file"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            }
            const step = files.steps.find((item) => item.name === entry);
            return (
              <li className={`wf-step${wrapped}`} key={entry}>
                <span aria-hidden="true" className="wf-wire" />
                <button
                  aria-current={selectedStep === entry ? "true" : undefined}
                  className={`wf-box${step?.gate ? " gated" : ""}${step ? "" : " missing"}`}
                  onClick={() => onStep(entry)}
                  title={step?.description || entry}
                  type="button"
                >
                  <span className="wf-node-text">
                    <b>
                      {entry}
                      {flow.loop === entry && (
                        <span
                          aria-label="loops back here"
                          title="The workflow goes back to this step after the last one"
                        >
                          ↻
                        </span>
                      )}
                    </b>
                    <span className="wf-node-sub">
                      {!step
                        ? "No step file"
                        : step.gate
                          ? GATE_CAPTION[step.gate]
                          : step.description}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {detail}
    </section>
  );
}

export function WorkflowsEditor({
  client,
  onError,
  open,
}: {
  client: DesktopClient;
  onError: (message: string) => void;
  /** A step to show opened, as the Factory page asks; `nonce` asks again. */
  open?: { step: string; nonce: number } | undefined;
}) {
  const [files, setFiles] = useState<WorkflowFilesDto>();
  const [selection, setSelection] = useState<Selection>(NONE);
  // The workflow a step was picked in: its details open under that line.
  const [anchor, setAnchor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // A file opens on its read view; Edit shows its markdown.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  // The text of the step memory a change is being saved for.
  const [memoryBusy, setMemoryBusy] = useState<string>();
  // Which of the three lists the page shows, and the words that narrow it.
  const [tab, setTab] = useState<NamedKind>("flow");
  const [query, setQuery] = useState("");
  const detailBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void client.request.workflowFiles({}).then((response) => {
      if (!response.ok) {
        onError(response.error.message);
        return;
      }
      setFiles(response.data);
    });
    // Read once when the tab opens; saves return the files again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // A step asked for from outside opens on the Steps tab once the files are
  // read. A name with no step file changes nothing.
  const loaded = files !== undefined;
  useEffect(() => {
    if (!open || !files) return;
    const next: Selection = { kind: "step", name: open.step };
    if (!files.steps.some((step) => step.name === open.step)) return;
    setTab("step");
    setQuery("");
    setSelection(next);
    setAnchor(null);
    setDraft(textOf(files, next));
    setRefusal(undefined);
    setEditing(false);
    // Only a new request or the first read opens it, not every later save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.nonce, loaded]);

  // What was just opened comes into view, wherever on the page it opened.
  useEffect(() => {
    detailBox.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selection, anchor]);

  if (!files) return <div className="empty">Loading workflows…</div>;

  const saved = textOf(files, selection);
  const isNew = "name" in selection && selection.name === null;
  const dirty = draft !== saved || isNew;
  const current =
    "name" in selection && selection.name !== null
      ? listOf(files, selection.kind).find(
          (item) => item.name === selection.name,
        )
      : undefined;
  const path =
    selection.kind === "choosing"
      ? files.choosing.path
      : (current?.path ?? "Saved under the name in its frontmatter");

  const is = (kind: Selection["kind"], name?: string) =>
    selection.kind === kind &&
    (name === undefined || ("name" in selection && selection.name === name));

  /**
   * Opens a file, or with {@link NONE} puts away what is open. `from` is the
   * workflow a step was picked in. Returns false when the user kept the
   * unsaved changes of the file that was open.
   */
  const select = async (next: Selection, from?: string): Promise<boolean> => {
    if (editing && draft !== saved && !(await confirmDiscard())) return false;
    setSelection(next);
    setAnchor(next.kind === "step" ? (from ?? null) : null);
    setDraft(textOf(files, next));
    setRefusal(undefined);
    setEditing("name" in next && next.name === null);
    if (!("name" in next)) return true;
    // It opens in its own list, a step in the workflow it was picked in.
    if (!(next.kind === "step" && from)) setTab(next.kind);
    const words = query.trim().toLowerCase();
    const shownAs = next.kind === "step" && from ? from : next.name;
    if (words && shownAs && !shownAs.toLowerCase().includes(words))
      setQuery("");
    return true;
  };

  /** A second click on what is open puts it away. */
  const toggle = (next: Selection & { name: string }, from?: string) =>
    void select(
      is(next.kind, next.name) && (anchor ?? undefined) === from ? NONE : next,
      from,
    );

  const changeTab = async (kind: NamedKind) => {
    if (kind === tab) return;
    if (selection.kind !== "none" && !(await select(NONE))) return;
    setTab(kind);
  };

  const cancel = () => {
    setDraft(saved);
    setRefusal(undefined);
    setEditing(false);
    // A new file that was never saved has nothing to show.
    if (isNew) setSelection(NONE);
  };

  const save = async () => {
    if (selection.kind === "none") return;
    setSaving(true);
    setRefusal(undefined);
    const kind: WorkflowFileKindDto = selection.kind;
    const previousName =
      "name" in selection && selection.name ? selection.name : undefined;
    const response = await client.request.workflowFileSave({
      kind,
      text: draft,
      ...(previousName ? { previousName } : {}),
    });
    setSaving(false);
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    setFiles(response.data);
    setEditing(false);
    // A file is named after its `name` or heading, which the save may have
    // changed, so find it again by what was written.
    if ("name" in selection) {
      const list = listOf(response.data, selection.kind);
      const match =
        list.find((item) => item.text === draft) ??
        list.find((item) => item.name === selection.name);
      if (match) setSelection({ kind: selection.kind, name: match.name });
    }
  };

  const remove = async () => {
    if (!("name" in selection) || !selection.name) return;
    const what = NOUN[selection.kind];
    if (
      !(await askConfirm({
        title: `Delete ${what} '${selection.name}'?`,
        message:
          selection.kind === "tool"
            ? "Its file is deleted."
            : "Its file is deleted. Runs already started keep their copy.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    const response = await client.request.workflowFileDelete({
      kind: selection.kind,
      name: selection.name,
    });
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    setFiles(response.data);
    setSelection(NONE);
    setDraft("");
    setRefusal(undefined);
    setEditing(false);
  };

  const changeMemory = async (
    step: string,
    text: string,
    action: StepMemoryAction,
  ) => {
    if (
      action === "forget" &&
      !(await askConfirm({
        title: "Forget this memory?",
        message: `"${text}" is removed from the ${step} step's memory.`,
        confirmLabel: "Forget",
        danger: true,
      }))
    )
      return;
    setMemoryBusy(text);
    setRefusal(undefined);
    const response = await client.request.stepMemoryChange({
      step,
      text,
      action,
    });
    setMemoryBusy(undefined);
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    setFiles(response.data);
    // Promoting rewrote the step's file, so the draft follows it.
    if (!editing) setDraft(textOf(response.data, selection));
  };

  const waiting = files.steps.filter((step) => toReview(step) > 0);
  const waitingCount = waiting.reduce((sum, step) => sum + toReview(step), 0);

  const matches = (file: WorkflowFileDto) => {
    const words = query.trim().toLowerCase();
    return (
      !words ||
      file.name.toLowerCase().includes(words) ||
      file.description.toLowerCase().includes(words)
    );
  };
  const shown = listOf(files, tab).filter(matches);
  const stepUsers = (name: string) =>
    files.flows.filter((flow) => flow.steps?.includes(name)).length;
  const toolUsers = (name: string) =>
    files.steps.filter((step) => step.tools?.includes(name)).length;

  /**
   * The name in the open list that the open file shows under: a workflow's
   * own card, the workflow a step was picked in, or a step's or tool's card.
   * Null when it has no place there, and it opens above the list.
   */
  const under =
    !("name" in selection) || selection.name === null
      ? null
      : tab === "flow" && selection.kind === "step"
        ? anchor
        : selection.kind === tab
          ? selection.name
          : null;
  const inPlace = under !== null && shown.some((item) => item.name === under);

  const detail =
    selection.kind === "none" ? null : (
      <div
        className={`wf-detail kind-${selection.kind}${editing ? " is-editing" : ""}`}
        ref={detailBox}
      >
        <FileDetail
          alert={refusal ?? current?.problem}
          dirty={dirty}
          draft={draft}
          editing={editing}
          eyebrow={
            selection.kind === "choosing" ? "Rules" : NOUN[selection.kind]
          }
          hint={HINTS[selection.kind]}
          label="Workflow file"
          onCancel={cancel}
          onClose={() => void select(NONE)}
          onDraft={setDraft}
          onEdit={() => setEditing(true)}
          onSave={() => void save()}
          path={path.replace(`${files.root}/`, "workflows/")}
          pathBelow
          saving={saving}
          title={titleOf(selection)}
          {...(selection.kind === "flow"
            ? {
                tools: (
                  <StepPicker
                    files={files}
                    onAdd={(entry) => setDraft(addToSteps(draft, entry))}
                    self={selection.name}
                  />
                ),
              }
            : selection.kind === "step"
              ? {
                  tools: (
                    <ToolPicker
                      draft={draft}
                      onAdd={(name) => setDraft(addToTools(draft, name))}
                      tools={files.tools}
                    />
                  ),
                }
              : {})}
          {...("name" in selection && selection.name
            ? { onDelete: () => void remove() }
            : {})}
          view={
            selection.kind === "choosing" ? (
              <MarkdownView
                empty="No rules yet. Agents build a workflow for each piece of work."
                text={files.choosing.text}
              />
            ) : !current ? undefined : selection.kind === "flow" ? (
              <WorkflowView
                // Its steps are the line above, drawn once.
                showSteps={false}
                flow={current}
                flows={files.flows}
                onFlow={(name) => void select({ kind: "flow", name })}
                onStep={(name) => void select({ kind: "step", name })}
                steps={files.steps}
              />
            ) : selection.kind === "tool" ? (
              <ToolView
                onStep={(name) => void select({ kind: "step", name })}
                steps={files.steps}
                tool={current}
              />
            ) : (
              <StepView
                flows={files.flows}
                memoryBusy={memoryBusy}
                onFlow={(name) => void select({ kind: "flow", name })}
                onMemory={(text, action) =>
                  void changeMemory(current.name, text, action)
                }
                onTool={(name) => void select({ kind: "tool", name })}
                step={current}
                tools={files.tools}
              />
            )
          }
        />
      </div>
    );

  const searchLabel = `Search ${TABS.find((item) => item.kind === tab)!.title.toLowerCase()}`;

  return (
    <div className="workflows-tab wf-page">
      <header className="wf-head">
        <h1>{METHODS_TITLE}</h1>
        <div aria-label="What to show" className="wf-seg" role="tablist">
          {TABS.map((item) => (
            <button
              aria-selected={tab === item.kind}
              className={tab === item.kind ? "on" : ""}
              key={item.kind}
              onClick={() => void changeTab(item.kind)}
              role="tab"
              type="button"
            >
              {item.title}
              <small>{listOf(files, item.kind).length}</small>
            </button>
          ))}
        </div>
        <span className="wf-grow" />
        <button
          aria-current={is("choosing") ? "true" : undefined}
          className="quiet wf-btn"
          onClick={() =>
            void select(is("choosing") ? NONE : { kind: "choosing" })
          }
          title="How an agent picks a workflow"
          type="button"
        >
          Choosing rules
        </button>
        <button
          className="quiet wf-btn"
          onClick={() => void select({ kind: tab, name: null })}
          type="button"
        >
          + New {NOUN[tab]}
        </button>
        <input
          aria-label={searchLabel}
          className="wf-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchLabel}
          type="search"
          value={query}
        />
      </header>
      {waitingCount > 0 && (
        <p className="step-memory-banner" role="status">
          <span>
            {waitingCount === 1
              ? "A step learned something from a run. It applies after you accept it."
              : `Steps learned ${waitingCount} things from runs. Each applies after you accept it.`}
          </span>
          <button
            className="quiet"
            onClick={() =>
              void select({ kind: "step", name: waiting[0]!.name })
            }
            type="button"
          >
            Review
          </button>
        </p>
      )}
      {/* A click on the page itself, not on anything in it, puts away what is open. */}
      <div
        className="wf-main"
        onClick={(event) => {
          if (selection.kind === "none") return;
          const target = event.target as HTMLElement;
          if (target.closest("button, a, input, textarea, .wf-detail")) return;
          void select(NONE);
        }}
        role="tabpanel"
      >
        {!inPlace && detail}
        {tab === "flow" && (
          <div className="wf-rows">
            {shown.map((flow) => (
              <FlowLine
                detail={inPlace && under === flow.name ? detail : undefined}
                files={files}
                flow={flow}
                key={flow.name}
                onFlow={(name) => toggle({ kind: "flow", name })}
                onStep={(name) => toggle({ kind: "step", name }, flow.name)}
                selected={is("flow", flow.name)}
                selectedStep={
                  selection.kind === "step" && anchor === flow.name
                    ? selection.name
                    : null
                }
              />
            ))}
            {files.flows.length === 0 && (
              <p className="wf-none">
                No workflows yet. Agents name their own steps until you add one.
              </p>
            )}
          </div>
        )}
        {tab === "step" && (
          <div className="wf-cards">
            {shown.flatMap((step) => {
              const users = stepUsers(step.name);
              return [
                <button
                  aria-current={is("step", step.name) ? "true" : undefined}
                  className="wf-card"
                  key={step.name}
                  onClick={() => toggle({ kind: "step", name: step.name })}
                  type="button"
                >
                  <b>
                    {step.name}
                    {step.problem && <Problem text={step.problem} />}
                  </b>
                  {step.description && <span>{step.description}</span>}
                  <StepChips step={step} />
                  <small>
                    {users ? `in ${plural(users, "workflow")}` : "unused"}
                    {toReview(step) ? ` · ${toReview(step)} to review` : ""}
                  </small>
                </button>,
                inPlace && under === step.name ? (
                  <div className="wf-cards-detail" key="detail">
                    {detail}
                  </div>
                ) : null,
              ];
            })}
          </div>
        )}
        {tab === "tool" && (
          <div className="wf-cards">
            {shown.flatMap((tool) => {
              const users = toolUsers(tool.name);
              return [
                <button
                  aria-current={is("tool", tool.name) ? "true" : undefined}
                  className="wf-card"
                  key={tool.name}
                  onClick={() => toggle({ kind: "tool", name: tool.name })}
                  type="button"
                >
                  <b>
                    <span className="wf-chip tool">{tool.name}</span>
                    {tool.problem && <Problem text={tool.problem} />}
                  </b>
                  {tool.description && <span>{tool.description}</span>}
                  <small>
                    {users
                      ? `suggested by ${plural(users, "step")}`
                      : "no step suggests it yet"}
                  </small>
                </button>,
                inPlace && under === tool.name ? (
                  <div className="wf-cards-detail" key="detail">
                    {detail}
                  </div>
                ) : null,
              ];
            })}
            {files.tools.length === 0 && (
              <p className="wf-none">
                No tools yet. A tool is how to use something, such as a CLI or a
                login, that a step can suggest.
              </p>
            )}
          </div>
        )}
        {query.trim() && shown.length === 0 && (
          <p className="wf-none">Nothing matches "{query.trim()}".</p>
        )}
        <p className="wf-foot">
          Amber marks a step that waits for you. Open a step to see the tools it
          suggests. The agent may use others.{" "}
          <button
            className="workflow-pane-link"
            onClick={() =>
              void client.request.openExternal({
                url: `${DOCS_URL}/workflows.md`,
              })
            }
            type="button"
          >
            Read more and examples <span aria-hidden="true">↗</span>
          </button>
        </p>
      </div>
    </div>
  );
}
