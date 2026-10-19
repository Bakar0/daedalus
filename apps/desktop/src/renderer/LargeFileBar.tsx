import { useState } from "react";
import {
  COMPACT_WORKSPACE_SKILL,
  type LargeFileDto,
  type SessionColorDto,
} from "@daedalus/protocol";

const FILE_NAME: Record<LargeFileDto["kind"], string> = {
  journal: "JOURNAL.md",
  team: "TEAM.md",
};

/** The command that compacts a file, as the user types it in the session. */
export const compactCommand = (file: LargeFileDto): string =>
  `/${COMPACT_WORKSPACE_SKILL} ${file.kind}`;

/**
 * A bar above the terminal when a file this session reads has grown past its
 * compact size: the workspace journal, for any session that is not a team
 * member, and the team file, for its lead. It says the size and shows the
 * command to paste into the session; Daedalus never runs it.
 */
export function LargeFileBar({
  file,
  color,
  onCopy,
}: {
  file: LargeFileDto;
  color: SessionColorDto | null;
  /** Resolves true once the command is on the clipboard. */
  onCopy: (text: string) => Promise<boolean>;
}) {
  const [copied, setCopied] = useState(false);
  const command = compactCommand(file);
  return (
    <section
      aria-label={`${FILE_NAME[file.kind]} size`}
      className="routine-bar large-file-bar"
      data-color={color ?? undefined}
    >
      <div className="routine-bar-row">
        <span
          className="routine-bar-text"
          title="Every session that reads it pays for all of it, on every model call after. The command moves what is no longer current to an archive file."
        >
          {FILE_NAME[file.kind]} is {Math.round(file.bytes / 1000)} KB. To
          shrink it, run:
        </span>
        <code className="large-file-command">{command}</code>
        <span className="routine-bar-actions">
          <button
            className="quiet"
            onClick={() =>
              void onCopy(command).then((written) => {
                if (!written) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              })
            }
            type="button"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
    </section>
  );
}
