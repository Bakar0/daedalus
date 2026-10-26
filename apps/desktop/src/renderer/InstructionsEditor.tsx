/**
 * The Custom instructions tab: the index every session reads and one file per
 * topic, each edited as the markdown it is. Saving, renaming or deleting a
 * topic keeps its line in the index in step.
 */
import { useEffect, useRef, useState } from "react";
import type { WorkflowFilesDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { askConfirm } from "./dialogs";
import { INSTRUCTIONS_CHANGED } from "./InstructionsPane";
import { DOCS_URL, Group, PlainRow, TabIntro } from "./WorkflowsEditor";

type Instructions = WorkflowFilesDto["instructions"];

/** What is open on the right. A null name is a new topic not saved yet. */
type Selection = { kind: "index" } | { kind: "topic"; name: string | null };

const NEW_TOPIC = `# New topic

- One rule per line, in your words.
`;

const HINTS: Record<Selection["kind"], string> = {
  index:
    "Every session reads this. Rules under '## Always' hold for every request; each line under '## Topics' names a topic file the agent opens when it applies. Agents add to it when you tell them how you like things done.",
  topic:
    "Starts with a '# Heading', which names the file. One rule per bullet. Saving a new topic adds its line to the index.",
};

function textOf(instructions: Instructions, selection: Selection): string {
  if (selection.kind === "index") return instructions.index.text;
  if (selection.name === null) return NEW_TOPIC;
  return (
    instructions.topics.find((topic) => topic.name === selection.name)?.text ??
    ""
  );
}

export function InstructionsEditor({
  client,
  onError,
}: {
  client: DesktopClient;
  onError: (message: string) => void;
}) {
  const [instructions, setInstructions] = useState<Instructions>();
  const [selection, setSelection] = useState<Selection>({ kind: "index" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  // What the focus handler compares against, current at the moment it runs.
  const latest = useRef({ instructions, selection, draft });
  latest.current = { instructions, selection, draft };

  useEffect(() => {
    void client.request.workflowFiles({}).then((response) => {
      if (!response.ok) {
        onError(response.error.message);
        return;
      }
      setInstructions(response.data.instructions);
      setDraft(response.data.instructions.index.text);
    });
    // Agents change these files too. Coming back to the window reads them
    // again, and shows the new text unless this file has unsaved changes.
    const reread = () =>
      void client.request.workflowFiles({}).then((response) => {
        const before = latest.current;
        if (!response.ok || !before.instructions) return;
        if (before.draft !== textOf(before.instructions, before.selection))
          return;
        setInstructions(response.data.instructions);
        setDraft(textOf(response.data.instructions, before.selection));
      });
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
    // Saves return the files again, so only the focus reads them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (!instructions)
    return <div className="empty">Loading custom instructions…</div>;

  const saved = textOf(instructions, selection);
  const isNew = selection.kind === "topic" && selection.name === null;
  const dirty = draft !== saved || isNew;
  const path =
    selection.kind === "index"
      ? instructions.index.path
      : (instructions.topics.find((topic) => topic.name === selection.name)
          ?.path ?? "Saved under the name its heading gives");

  const select = async (next: Selection) => {
    if (
      draft !== saved &&
      !(await askConfirm({
        title: "Discard changes?",
        message: "This file has changes that are not saved.",
        confirmLabel: "Discard",
        danger: true,
      }))
    )
      return;
    setSelection(next);
    setDraft(textOf(instructions, next));
    setRefusal(undefined);
  };

  const save = async () => {
    setSaving(true);
    setRefusal(undefined);
    const previousName =
      selection.kind === "topic" && selection.name ? selection.name : undefined;
    const response = await client.request.workflowFileSave({
      kind: selection.kind,
      text: draft,
      ...(previousName ? { previousName } : {}),
    });
    setSaving(false);
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    const next = response.data.instructions;
    setInstructions(next);
    window.dispatchEvent(new Event(INSTRUCTIONS_CHANGED));
    // A topic is named after its heading, which the save may have changed,
    // so find it again by what was written.
    if (selection.kind === "topic") {
      const match =
        next.topics.find((topic) => topic.text === draft) ??
        next.topics.find((topic) => topic.name === selection.name);
      if (match) setSelection({ kind: "topic", name: match.name });
    }
  };

  const remove = async () => {
    if (selection.kind !== "topic" || !selection.name) return;
    if (
      !(await askConfirm({
        title: `Delete topic '${selection.name}'?`,
        message: "Its file and its line in the index are deleted.",
        confirmLabel: "Delete",
        danger: true,
      }))
    )
      return;
    const response = await client.request.workflowFileDelete({
      kind: "topic",
      name: selection.name,
    });
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    setInstructions(response.data.instructions);
    window.dispatchEvent(new Event(INSTRUCTIONS_CHANGED));
    setSelection({ kind: "index" });
    setDraft(response.data.instructions.index.text);
    setRefusal(undefined);
  };

  const isTopic = (name: string) =>
    selection.kind === "topic" && selection.name === name;

  return (
    <div className="workflows-tab">
      <TabIntro
        onReadMore={() =>
          void client.request.openExternal({
            url: `${DOCS_URL}/custom-instructions.md`,
          })
        }
      >
        How you like things done, followed by every session in every workspace.
        Tell an agent "from now on…" and it adds the rule here.
      </TabIntro>
      <div className="workflows-editor">
        <nav aria-label="Instruction files" className="workflows-list">
          <Group
            onNew={() => void select({ kind: "topic", name: null })}
            title="Custom instructions"
          >
            <PlainRow
              label="Index"
              note="Always rules and the topic list"
              onSelect={() => void select({ kind: "index" })}
              selected={selection.kind === "index"}
            />
            {instructions.topics.map((topic) => (
              <PlainRow
                key={topic.name}
                label={topic.name}
                onSelect={() =>
                  void select({ kind: "topic", name: topic.name })
                }
                selected={isTopic(topic.name)}
              />
            ))}
          </Group>
        </nav>
        <section aria-label="Instruction file" className="workflows-detail">
          <header className="workflows-detail-heading">
            <div>
              <h2>
                {selection.kind === "index"
                  ? "Custom instructions"
                  : (selection.name ?? "New topic")}
              </h2>
              <small>{path}</small>
            </div>
            <div className="workflows-detail-actions">
              {selection.kind === "topic" && selection.name && (
                <button
                  className="danger-link"
                  onClick={() => void remove()}
                  type="button"
                >
                  Delete
                </button>
              )}
              <button
                className="quiet"
                disabled={draft === saved || saving}
                onClick={() => {
                  setDraft(saved);
                  setRefusal(undefined);
                }}
                type="button"
              >
                Revert
              </button>
              <button
                className="primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
                type="button"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </header>
          {refusal && (
            <p className="workflows-refusal" role="alert">
              {refusal}
            </p>
          )}
          <textarea
            aria-label="File text"
            className="workflows-text"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "s") {
                event.preventDefault();
                if (dirty && !saving) void save();
              }
            }}
            spellCheck={false}
            value={draft}
          />
          <p className="workflows-hint">{HINTS[selection.kind]}</p>
        </section>
      </div>
    </div>
  );
}
