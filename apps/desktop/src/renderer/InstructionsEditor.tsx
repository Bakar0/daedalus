/**
 * The Custom instructions tab: the index every session reads and one file per
 * topic, each edited as the markdown it is. Saving, renaming or deleting a
 * topic keeps its line in the index in step.
 */
import { useEffect, useRef, useState } from "react";
import type { InstructionFilesDto } from "@daedalus/protocol";
import type { DesktopClient } from "./client-types";
import { askConfirm } from "./dialogs";
import {
  alwaysRules,
  InstructionsIndexView,
  plural,
  topicFacts,
  TopicView,
} from "./FileViews";
import { INSTRUCTIONS_CHANGED } from "./InstructionsPane";
import {
  confirmDiscard,
  DOCS_URL,
  FileDetail,
  FileRow,
  Group,
  TabIntro,
} from "./FileEditorParts";

type Instructions = InstructionFilesDto;

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
  // A file opens on its read view; Edit shows its markdown.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();

  // What the focus handler compares against, current at the moment it runs.
  const latest = useRef({ instructions, selection, draft });
  latest.current = { instructions, selection, draft };

  useEffect(() => {
    void client.request.instructionFiles({}).then((response) => {
      if (!response.ok) {
        onError(response.error.message);
        return;
      }
      setInstructions(response.data);
      setDraft(response.data.index.text);
    });
    // Agents change these files too. Coming back to the window reads them
    // again, and shows the new text unless this file has unsaved changes.
    const reread = () =>
      void client.request.instructionFiles({}).then((response) => {
        const before = latest.current;
        if (!response.ok || !before.instructions) return;
        if (before.draft !== textOf(before.instructions, before.selection))
          return;
        setInstructions(response.data);
        setDraft(textOf(response.data, before.selection));
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
    if (editing && draft !== saved && !(await confirmDiscard())) return;
    setSelection(next);
    setDraft(textOf(instructions, next));
    setRefusal(undefined);
    setEditing(next.kind === "topic" && next.name === null);
  };

  const cancel = () => {
    setRefusal(undefined);
    setEditing(false);
    // A new topic that was never saved has nothing to show.
    const next: Selection = isNew ? { kind: "index" } : selection;
    setSelection(next);
    setDraft(textOf(instructions, next));
  };

  const save = async () => {
    setSaving(true);
    setRefusal(undefined);
    const previousName =
      selection.kind === "topic" && selection.name ? selection.name : undefined;
    const response = await client.request.instructionFileSave({
      kind: selection.kind,
      text: draft,
      ...(previousName ? { previousName } : {}),
    });
    setSaving(false);
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    const next = response.data;
    setInstructions(next);
    setEditing(false);
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
    const response = await client.request.instructionFileDelete({
      name: selection.name,
    });
    if (!response.ok) {
      setRefusal(response.error.message);
      return;
    }
    setInstructions(response.data);
    window.dispatchEvent(new Event(INSTRUCTIONS_CHANGED));
    setSelection({ kind: "index" });
    setDraft(response.data.index.text);
    setRefusal(undefined);
    setEditing(false);
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
            <FileRow
              meta={plural(alwaysRules(instructions.index.text).length, "rule")}
              name="Always"
              onSelect={() => void select({ kind: "index" })}
              selected={selection.kind === "index"}
              summary="Every request, and the list of topics"
            />
            {topicFacts(instructions).map((topic) => (
              <FileRow
                key={topic.name}
                meta={plural(topic.rules, "rule")}
                name={topic.heading}
                onSelect={() =>
                  void select({ kind: "topic", name: topic.name })
                }
                selected={isTopic(topic.name)}
                summary={topic.covers ?? topic.name}
              />
            ))}
          </Group>
        </nav>
        <FileDetail
          alert={refusal}
          dirty={dirty}
          draft={draft}
          editing={editing}
          hint={HINTS[selection.kind]}
          label="Instruction file"
          onCancel={cancel}
          onDraft={setDraft}
          onEdit={() => setEditing(true)}
          onSave={() => void save()}
          path={path}
          saving={saving}
          title={
            selection.kind === "index"
              ? "Custom instructions"
              : selection.name === null
                ? "New topic"
                : (topicFacts(instructions).find(
                    (topic) => topic.name === selection.name,
                  )?.heading ?? selection.name)
          }
          {...(selection.kind === "topic" && selection.name
            ? { onDelete: () => void remove() }
            : {})}
          view={
            selection.kind === "index" ? (
              <InstructionsIndexView
                instructions={instructions}
                onTopic={(name) => void select({ kind: "topic", name })}
              />
            ) : selection.name === null ? undefined : (
              <TopicView
                text={saved}
                {...(() => {
                  const covers = topicFacts(instructions).find(
                    (topic) => topic.name === selection.name,
                  )?.covers;
                  return covers ? { covers } : {};
                })()}
              />
            )
          }
        />
      </div>
    </div>
  );
}
