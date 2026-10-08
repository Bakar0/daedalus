import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "@daedalus/platform";
import type { DaedalusConfig } from "../config";
import type { AgentSession } from "../domain";

/**
 * A Claude session's inbox: a named pipe Daedalus writes one line into, and
 * a hook in the session that waits on it.
 *
 * The hook runs on `Stop` and `SessionStart` with `asyncRewake`, so it waits
 * in the background while the session sits at its prompt. When a line
 * arrives it prints it to stderr and exits 2, and Claude wakes with the line
 * as a system reminder. Nothing is typed into the pane, so the line never
 * shows as something the user sent and never touches their draft. A pipe
 * hands each line to one reader, so a line cannot be delivered twice.
 *
 * A line on the pipe only reaches a session whose waiter is reading, which
 * suits routine runs: they go in only when the session is at its prompt.
 * Notes that must arrive whatever the session is doing, such as a handoff
 * request, go to the mailbox file beside the pipe instead. A waiter reads
 * the mailbox when it starts, so a note left during a turn arrives when the
 * turn ends, and after every line, so a poke on the pipe delivers it now.
 */

/** Marks the inbox hook among a session's hooks, after `-c <script>`. */
export const INBOX_HOOK_MARKER = "daedalus-inbox";

/**
 * The waiter: a shell blocked on reading the pipe, about 2 MB while it waits.
 * A new waiter ends the one before it, so a session never has two reading.
 * It prints whatever is in the mailbox, then the line, and exits 2 when it
 * printed anything; an empty line is only a poke to read the mailbox.
 */
export const INBOX_WAITER_SCRIPT = [
  'fifo="$1"',
  'pidfile="$fifo.pid"',
  'mail="$fifo.mail"',
  '[ -p "$fifo" ] || exit 0',
  'old=$(cat "$pidfile" 2>/dev/null)',
  'if [ -n "$old" ] && ps -p "$old" -o command= 2>/dev/null | grep -q daedalus-inbox; then kill "$old" 2>/dev/null; fi',
  'echo $$ > "$pidfile"',
  'done_waiting() { [ "$(cat "$pidfile" 2>/dev/null)" = "$$" ] && rm -f "$pidfile"; }',
  'take_mail() { [ -s "$mail" ] && mv "$mail" "$mail.$$" 2>/dev/null && cat "$mail.$$" >&2 && rm -f "$mail.$$"; }',
  "if take_mail; then done_waiting; exit 2; fi",
  'IFS= read -r line < "$fifo" || exit 0',
  "done_waiting",
  "printed=1",
  "take_mail && printed=0",
  'if [ -n "$line" ]; then printf \'%s\\n\' "$line" >&2; printed=0; fi',
  '[ "$printed" = 0 ] && exit 2',
  "exit 0",
].join("\n");

export const inboxPath = (config: DaedalusConfig, sessionId: string): string =>
  join(config.home, "inbox", `${sessionId}.fifo`);

/** The hook command that waits on a session's inbox. */
export const inboxHook = (config: DaedalusConfig, sessionId: string) => ({
  type: "command" as const,
  command: "/bin/sh",
  args: [
    "-c",
    INBOX_WAITER_SCRIPT,
    INBOX_HOOK_MARKER,
    inboxPath(config, sessionId),
  ],
  asyncRewake: true,
  // Not enforced on a background hook; set so it never reads as a limit.
  timeout: 86_400,
});

/** Creates the pipe, readable and writable only by the user. */
export async function ensureInbox(
  config: DaedalusConfig,
  sessionId: string,
): Promise<string> {
  const path = inboxPath(config, sessionId);
  await mkdir(join(config.home, "inbox"), { recursive: true, mode: 0o700 });
  await chmod(join(config.home, "inbox"), 0o700);
  const existing = await lstat(path).catch(() => undefined);
  if (existing?.isFIFO()) return path;
  if (existing) await rm(path, { force: true });
  const result = await runCommand("/usr/bin/mkfifo", ["-m", "600", path]);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `mkfifo failed for ${path}`);
  return path;
}

/**
 * Leaves a note for a session that must reach it whatever it is doing: now
 * if its waiter is reading, else when its current turn ends. True when a
 * waiter took it now.
 */
export async function leaveInInbox(
  config: DaedalusConfig,
  sessionId: string,
  line: string,
): Promise<boolean> {
  const mail = `${inboxPath(config, sessionId)}.mail`;
  const handle = await open(mail, "a", 0o600);
  try {
    await handle.write(`${line.replace(/[\r\n]+/g, " ").trim()}\n`);
  } finally {
    await handle.close();
  }
  return postToInbox(config, sessionId, "");
}

/** Whether a session was launched with the inbox hook. */
export const usesInbox = (session: AgentSession): boolean =>
  session.provider === "claude" &&
  session.args.some((argument) => argument.includes(INBOX_HOOK_MARKER));

/**
 * Writes one line to a session's inbox. False when nothing is reading it:
 * the session is in a turn, or not running. Never blocks.
 */
export async function postToInbox(
  config: DaedalusConfig,
  sessionId: string,
  line: string,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(
      inboxPath(config, sessionId),
      constants.O_WRONLY | constants.O_NONBLOCK,
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENXIO" || code === "ENOENT") return false;
    throw error;
  }
  try {
    await handle.write(`${line.replace(/[\r\n]+/g, " ").trim()}\n`);
    return true;
  } finally {
    await handle.close();
  }
}
