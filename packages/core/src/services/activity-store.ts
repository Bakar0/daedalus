import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentActivity,
  AgentActivitySource,
  AgentActivityState,
} from "../domain";

/**
 * Durable activity lives on the filesystem, mirroring the
 * `~/.daedalus/telemetry/<sessionId>.json` pattern, and SQLite is the index
 * over it.
 *
 * The split is not redundancy for its own sake. A provider hook is a
 * short-lived process that must succeed when the Daedalus app is not running
 * and when the database is locked by somebody else — so it writes here first
 * and applies to SQLite second. Everything that reads activity (the badge, the
 * app, `agent list`) reads the index, and `restore()` replays these files into
 * it on startup so an app restart mid-turn does not lose the turn.
 */
const DIRECTORY = "activity";

/** A hook payload is attacker-adjacent input; a record is a fixed small shape. */
const MAX_RECORD_BYTES = 8 * 1024;

const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIVITIES: readonly AgentActivity[] = [
  "unknown",
  "working",
  "needs_permission",
  "needs_input",
  "idle",
  "done",
  "error",
];

const SOURCES: readonly AgentActivitySource[] = [
  "agent",
  "hook",
  "transcript",
  "pane",
];

export interface StoredActivityRecord extends AgentActivityState {
  /**
   * The provider's own session id, captured from the first hook that carried
   * one. Codex runs short-lived internal agents beside the real conversation
   * and they fire the same events; binding to the first id seen is what keeps
   * their `Stop` from reporting the real session idle mid-turn.
   */
  providerSessionId?: string;
}

export const activityDirectory = (home: string): string =>
  join(home, DIRECTORY);

const recordPath = (home: string, sessionId: string): string =>
  join(activityDirectory(home), `${sessionId}.json`);

const isRecord = (value: unknown): value is StoredActivityRecord => {
  const candidate = value as Partial<StoredActivityRecord> | null;
  return Boolean(
    candidate &&
    typeof candidate.sessionId === "string" &&
    SESSION_ID.test(candidate.sessionId) &&
    ACTIVITIES.includes(candidate.activity as AgentActivity) &&
    SOURCES.includes(candidate.source as AgentActivitySource) &&
    typeof candidate.since === "string" &&
    typeof candidate.observedAt === "string",
  );
};

/**
 * Crash-safe temp+rename at 0o600, the same discipline as the telemetry sink:
 * a reader never sees a half-written record, and a record is never world
 * readable because it quotes whatever the agent was doing.
 */
export async function writeActivityRecord(
  home: string,
  record: StoredActivityRecord,
): Promise<void> {
  const serialized = JSON.stringify(record);
  if (serialized.length > MAX_RECORD_BYTES) return;
  const directory = activityDirectory(home);
  await mkdir(directory, { recursive: true });
  const destination = recordPath(home, record.sessionId);
  const temporary = join(
    directory,
    `${record.sessionId}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readActivityRecord(
  home: string,
  sessionId: string,
): Promise<StoredActivityRecord | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  try {
    const file = Bun.file(recordPath(home, sessionId));
    if (file.size > MAX_RECORD_BYTES) return undefined;
    const parsed: unknown = await file.json();
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // A missing or partially written record is simply no observation.
    return undefined;
  }
}

export async function listActivityRecords(
  home: string,
): Promise<StoredActivityRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(activityDirectory(home));
  } catch {
    return [];
  }
  const records = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        readActivityRecord(home, entry.slice(0, -".json".length)),
      ),
  );
  return records.filter((record): record is StoredActivityRecord =>
    Boolean(record),
  );
}

export async function deleteActivityRecord(
  home: string,
  sessionId: string,
): Promise<void> {
  if (!SESSION_ID.test(sessionId)) return;
  await rm(recordPath(home, sessionId), { force: true });
}
