import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

const UUID_VALUE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Whether Codex kept a conversation it can resume: a thread in its state
 * database, or a non-empty rollout near the day the session started.
 */
export async function hasPersistedCodexSession(input: {
  sessionsDirectory: string;
  id: string;
  startedAt: string;
}): Promise<boolean> {
  // Legacy Codex sessions may be addressed by their user-visible name.
  if (!UUID_VALUE.test(input.id)) return true;
  const codexHome = dirname(input.sessionsDirectory);
  try {
    const entries = await readdir(codexHome, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^state_\d+\.sqlite$/.test(entry.name)) continue;
      let database: Database | undefined;
      try {
        database = new Database(join(codexHome, entry.name), {
          readonly: true,
        });
        const found = database
          .query<{ found: number }, [string]>(
            "SELECT 1 AS found FROM threads WHERE id = ? LIMIT 1",
          )
          .get(input.id);
        if (found) return true;
      } catch {
        // Fall through to rollout files for older or incompatible schemas.
      } finally {
        database?.close();
      }
    }
  } catch {
    // The Codex home may predate the SQLite state store.
  }

  const startedAt = Date.parse(input.startedAt);
  if (Number.isFinite(startedAt)) {
    for (const offset of [-1, 0, 1]) {
      const [year, month, day] = new Date(
        startedAt + offset * 24 * 60 * 60 * 1_000,
      )
        .toISOString()
        .slice(0, 10)
        .split("-");
      if (
        await hasCodexRollout(
          join(input.sessionsDirectory, year!, month!, day!),
          input.id,
        )
      )
        return true;
    }
  }
  return hasCodexRollout(join(codexHome, "archived_sessions"), input.id);
}

/**
 * An empty rollout is a conversation Codex opened and never wrote to. Codex
 * keeps no thread for it, so `codex archive` fails with "failed to archive
 * session", and there is nothing in it to resume.
 */
async function hasCodexRollout(directory: string, id: string) {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    // Missing date directories are expected.
    return false;
  }
  for (const entry of entries) {
    if (!entry.endsWith(`${id}.jsonl`)) continue;
    const size = await stat(join(directory, entry))
      .then((file) => file.size)
      .catch(() => 0);
    if (size > 0) return true;
  }
  return false;
}
