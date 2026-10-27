/**
 * The Workflows tab: the user's workflows, steps and choosing rules. Each
 * opens as a read view and is edited as the markdown it is. Daedalus checks a
 * workflow or step the way a run reads it and refuses to save one a run could
 * not use, with the reason. Examples to copy are in the docs the header links
 * to.
 */
import { useEffect, useState } from "react";
import type {
  WorkflowFileDto,
  WorkflowFileKindDto,
  WorkflowFilesDto,
} from "@daedalus/protocol";
import { SplitList } from "./SplitList";
import { MarkdownView, StepView, WorkflowView } from "./FileViews";
import type { DesktopClient } from "./client-types";
import { askConfirm } from "./dialogs";
import {
  confirmDiscard,
  DOCS_URL,
  FileDetail,
  FileRow,
  Group,
  TabIntro,
} from "./FileEditorParts";

/** What is open on the right. A null name is a new file not saved yet. */
type Selection =
  { kind: "flow" | "step"; name: string | null } | { kind: "choosing" };

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

const listOf = (files: WorkflowFilesDto, kind: "flow" | "step") =>
  kind === "flow" ? files.flows : files.steps;

function textOf(files: WorkflowFilesDto, selection: Selection): string {
  switch (selection.kind) {
    case "choosing":
      return files.choosing.text;
    default:
      if (selection.name === null)
        return selection.kind === "flow" ? NEW_FLOW : NEW_STEP;
      return (
        listOf(files, selection.kind).find(
          (item) => item.name === selection.name,
        )?.text ?? ""
      );
  }
}

function titleOf(selection: Selection): string {
  switch (selection.kind) {
    case "choosing":
      return "Choosing rules";
    default:
      return (
        selection.name ??
        `New ${selection.kind === "flow" ? "workflow" : "step"}`
      );
  }
}

const HINTS: Record<Selection["kind"], string> = {
  flow: "Frontmatter: name, description, when, steps: [a, b] or steps: dynamic (the agent names its own), and optionally loop: <step> and until. Runs already started keep their copy; a change applies from the next run.",
  step: "Frontmatter: name, description, and optionally gate: user (you approve its result) or gate: before (you agree before it starts). The body is what the agent does in this step.",
  choosing:
    "The rules an agent reads, in order, to pick a workflow for the work.",
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** "6 steps · 1 gate", or "dynamic" for a workflow whose agent names them. */
function flowMeta(flow: WorkflowFileDto, steps: WorkflowFileDto[]): string {
  if (flow.dynamic) return "dynamic";
  const names = flow.steps ?? [];
  const gates = names.filter(
    (name) => steps.find((step) => step.name === name)?.gate,
  ).length;
  return [plural(names.length, "step"), gates ? plural(gates, "gate") : ""]
    .filter(Boolean)
    .join(" · ");
}

export function WorkflowsEditor({
  client,
  onError,
}: {
  client: DesktopClient;
  onError: (message: string) => void;
}) {
  const [files, setFiles] = useState<WorkflowFilesDto>();
  const [selection, setSelection] = useState<Selection>({ kind: "choosing" });
  const [draft, setDraft] = useState("");
  // A file opens on its read view; Edit shows its markdown.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  useEffect(() => {
    void client.request.workflowFiles({}).then((response) => {
      if (!response.ok) {
        onError(response.error.message);
        return;
      }
      setFiles(response.data);
      const own = response.data.flows[0];
      const start: Selection = own
        ? { kind: "flow", name: own.name }
        : { kind: "choosing" };
      setSelection(start);
      setDraft(textOf(response.data, start));
    });
    // Read once when the tab opens; saves return the files again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (!files) return <div className="empty">Loading workflows…</div>;

  const saved = textOf(files, selection);
  const isNew = "name" in selection && selection.name === null;
  const dirty = draft !== saved || isNew;
  const current =
    (selection.kind === "flow" || selection.kind === "step") &&
    selection.name !== null
      ? listOf(files, selection.kind).find(
          (item) => item.name === selection.name,
        )
      : undefined;
  const path =
    selection.kind === "choosing"
      ? files.choosing.path
      : (current?.path ?? "Saved under the name in its frontmatter");

  const select = async (next: Selection) => {
    if (editing && draft !== saved && !(await confirmDiscard())) return;
    setSelection(next);
    setDraft(textOf(files, next));
    setRefusal(undefined);
    setEditing("name" in next && next.name === null);
  };

  const cancel = () => {
    setDraft(saved);
    setRefusal(undefined);
    setEditing(false);
    // A new file that was never saved has nothing to show.
    if (isNew) {
      const own = files.flows[0];
      const next: Selection = own
        ? { kind: "flow", name: own.name }
        : { kind: "choosing" };
      setSelection(next);
      setDraft(textOf(files, next));
    }
  };

  const save = async () => {
    setSaving(true);
    setRefusal(undefined);
    const kind = selection.kind as WorkflowFileKindDto;
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
    if (selection.kind === "flow" || selection.kind === "step") {
      const list = listOf(response.data, selection.kind);
      const match =
        list.find((item) => item.text === draft) ??
        list.find((item) => item.name === selection.name);
      if (match) setSelection({ kind: selection.kind, name: match.name });
    }
  };

  const remove = async () => {
    if (
      (selection.kind !== "flow" && selection.kind !== "step") ||
      !selection.name
    )
      return;
    const what = selection.kind === "flow" ? "workflow" : "step";
    if (
      !(await askConfirm({
        title: `Delete ${what} '${selection.name}'?`,
        message: "Its file is deleted. Runs already started keep their copy.",
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
    const next: Selection = { kind: "choosing" };
    setSelection(next);
    setDraft(textOf(response.data, next));
    setRefusal(undefined);
    setEditing(false);
  };

  const is = (kind: Selection["kind"], name?: string) =>
    selection.kind === kind &&
    (name === undefined || ("name" in selection && selection.name === name));

  return (
    <div className="workflows-tab">
      <TabIntro
        onReadMore={() =>
          void client.request.openExternal({ url: `${DOCS_URL}/workflows.md` })
        }
      >
        A workflow is the order an agent works in, such as plan, build, prove,
        ship. With workflows on, agents pick one of yours for each request and
        report its steps in the side panel.
      </TabIntro>
      <SplitList
        id="workflows"
        label="Workflow files"
        list={
          <>
            <Group
              onNew={() => void select({ kind: "flow", name: null })}
              title="Workflows"
            >
              {files.flows.map((file) => (
                <FileRow
                  key={file.name}
                  meta={flowMeta(file, files.steps)}
                  name={file.name}
                  onSelect={() =>
                    void select({ kind: "flow", name: file.name })
                  }
                  problem={file.problem}
                  selected={is("flow", file.name)}
                  summary={file.description}
                />
              ))}
              {files.flows.length === 0 && (
                <li className="workflows-none">
                  None yet. Agents name their own steps until you add one.
                </li>
              )}
              <FileRow
                name="Choosing rules"
                onSelect={() => void select({ kind: "choosing" })}
                selected={is("choosing")}
                summary="How an agent picks a workflow"
              />
            </Group>
            <Group
              onNew={() => void select({ kind: "step", name: null })}
              title="Steps"
            >
              {files.steps.map((file) => {
                const users = files.flows.filter((flow) =>
                  flow.steps?.includes(file.name),
                ).length;
                return (
                  <FileRow
                    key={file.name}
                    {...(file.gate ? { badge: "gate" } : {})}
                    meta={users ? `used by ${users}` : "unused"}
                    name={file.name}
                    onSelect={() =>
                      void select({ kind: "step", name: file.name })
                    }
                    problem={file.problem}
                    selected={is("step", file.name)}
                    summary={file.description}
                  />
                );
              })}
            </Group>
          </>
        }
      >
        <FileDetail
          alert={refusal ?? current?.problem}
          dirty={dirty}
          draft={draft}
          editing={editing}
          hint={HINTS[selection.kind]}
          label="Workflow file"
          onCancel={cancel}
          onDraft={setDraft}
          onEdit={() => setEditing(true)}
          onSave={() => void save()}
          path={path}
          saving={saving}
          title={titleOf(selection)}
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
                flow={current}
                onStep={(name) => void select({ kind: "step", name })}
                steps={files.steps}
              />
            ) : (
              <StepView
                flows={files.flows}
                onFlow={(name) => void select({ kind: "flow", name })}
                step={current}
              />
            )
          }
        />
      </SplitList>
    </div>
  );
}
