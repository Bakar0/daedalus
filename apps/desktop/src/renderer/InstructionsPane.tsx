/**
 * The user's custom instructions, under the Workflow pane in the side panel:
 * a header that opens the Custom instructions tab and one dim line saying
 * what there is.
 */
import { useEffect, useState } from "react";
import type { DesktopClient } from "./client-types";
import { INSTRUCTIONS_ICON_PATH } from "./WorkflowPane";

export interface InstructionsSummary {
  always: number;
  topics: number;
}

/**
 * The rules under the index's "## Always" heading: each top-level bullet or
 * numbered item. An indented line belongs to the rule above it.
 */
export function alwaysRuleCount(index: string): number {
  const section = /^##\s+Always[ \t]*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(
    index,
  )?.[1];
  return section
    ? section.split("\n").filter((line) => /^(?:[-*+]|\d+[.)])\s+\S/.test(line))
        .length
    : 0;
}

/** Sent by the Custom instructions tab after it saves or deletes a file. */
export const INSTRUCTIONS_CHANGED = "daedalus:instructions-changed";

/** How often the pane re-reads the files, for changes agents make. */
const REFRESH_MS = 15_000;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Reads the summary when the pane mounts, after the tab saves, when the
 * window comes back into focus, and every few seconds while it is shown,
 * since agents change the files too.
 */
export function useInstructionsSummary(
  client: DesktopClient,
): InstructionsSummary | undefined {
  const [summary, setSummary] = useState<InstructionsSummary>();
  useEffect(() => {
    let live = true;
    const read = () =>
      void client.request.workflowFiles({}).then((response) => {
        if (!live || !response.ok) return;
        const { index, topics } = response.data.instructions;
        setSummary({
          always: alwaysRuleCount(index.text),
          topics: topics.length,
        });
      });
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") read();
    }, REFRESH_MS);
    window.addEventListener("focus", read);
    window.addEventListener(INSTRUCTIONS_CHANGED, read);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
      window.removeEventListener(INSTRUCTIONS_CHANGED, read);
    };
  }, [client]);
  return summary;
}

export function InstructionsPane({
  onOpen,
  summary,
}: {
  /** Opens the Custom instructions tab in the center. */
  onOpen: () => void;
  summary?: InstructionsSummary;
}) {
  const empty = summary && summary.always === 0 && summary.topics === 0;
  return (
    <section aria-label="Custom instructions" className="workflow-pane">
      <div className="workflow-pane-header">
        <span className="workflow-pane-heading">
          <span className="workflow-pane-title">
            <svg
              aria-hidden="true"
              className="workflow-icon"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 16 16"
            >
              <path d={INSTRUCTIONS_ICON_PATH} />
            </svg>
            Custom instructions
          </span>
        </span>
        <button
          className="quiet workflow-pane-open"
          onClick={onOpen}
          title="The rules every session follows, and topic files"
          type="button"
        >
          Open <span aria-hidden="true">↗</span>
        </button>
      </div>
      {summary && (
        <p className="workflow-pane-empty">
          {empty
            ? "None yet · tell an agent how you like things done"
            : `${plural(summary.always, "Always rule")} · ${plural(summary.topics, "topic")}`}
        </p>
      )}
    </section>
  );
}
