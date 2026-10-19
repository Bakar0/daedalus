import { statSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, Workspace } from "../domain";
import { TEAM_FILE } from "./abilities";

/** The protocol's copies are `JOURNAL_COMPACT_BYTES` and `TEAM_COMPACT_BYTES`. */
export const JOURNAL_COMPACT_BYTES = 50_000;
export const TEAM_COMPACT_BYTES = 20_000;

export interface LargeFile {
  kind: "journal" | "team";
  workspaceId: string;
  /** The lead, for a team file; null for a journal. */
  sessionId: string | null;
  bytes: number;
}

const sizeOf = (path: string): number => {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
};

/**
 * Each workspace journal and each lead's team file past its compact size.
 * One stat per file, synchronous so the change fingerprint can use it too.
 */
export function largeFiles(
  workspaces: readonly Workspace[],
  leads: readonly AgentSession[],
): LargeFile[] {
  const found: LargeFile[] = [];
  for (const workspace of workspaces) {
    if (workspace.archivedAt) continue;
    const bytes = sizeOf(join(workspace.path, "JOURNAL.md"));
    if (bytes > JOURNAL_COMPACT_BYTES)
      found.push({
        kind: "journal",
        workspaceId: workspace.id,
        sessionId: null,
        bytes,
      });
  }
  for (const lead of leads) {
    if (lead.archivedAt) continue;
    const bytes = sizeOf(join(lead.workingDirectory, TEAM_FILE));
    if (bytes > TEAM_COMPACT_BYTES)
      found.push({
        kind: "team",
        workspaceId: lead.workspaceId,
        sessionId: lead.id,
        bytes,
      });
  }
  return found;
}
