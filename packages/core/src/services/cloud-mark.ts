import type { AgentSession } from "../domain";
import type { ActivityObservation } from "./hook-events";

/**
 * How text from a cloud session is marked where agents and the user read it,
 * so nobody takes it for the user or a local agent (M-4, N-1).
 */

/** Every way a line can end, so no reader finds a line we did not split. */
const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

/**
 * The workspace name as a mark shows it, kept to letters, digits, spaces,
 * dots and dashes, so it can neither tag anyone nor close the brackets early.
 */
function markName(workspaceName: string | undefined): string {
  return (workspaceName ?? "")
    .replace(/[^\p{L}\p{N} ._-]/gu, "")
    .trim()
    .slice(0, 60);
}

/** The mark put before text: `[from cloud workspace final]`. */
export function cloudMark(workspaceName: string | undefined): string {
  const name = markName(workspaceName);
  return name ? `[from cloud workspace ${name}]` : "[from a cloud workspace]";
}

/** The mark put after an author's name: `[cloud final]`. */
export function cloudAuthorMark(workspaceName: string | undefined): string {
  const name = markName(workspaceName);
  return name ? `[cloud ${name}]` : "[cloud]";
}

/** Whether a session runs on a cloud host rather than this Mac. */
export function isCloudSession(session: Pick<AgentSession, "hostId">): boolean {
  return Boolean(session.hostId);
}

/** Text on one line, with the mark first: for titles and attention details. */
export function markOneLine(mark: string, text: string): string {
  return `${mark} ${splitLines(text).join(" ")}`;
}

/**
 * Text that keeps its lines, under the mark, every line quoted with `> ` so
 * none of them reads as text outside the quote: for task descriptions.
 */
export function markBlock(mark: string, text: string): string {
  return `${mark}\n\n${splitLines(text)
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}`;
}

/**
 * A message body under a header line: every line after the first is
 * indented, so no line of the body can start like a header (N-1).
 */
export function indentBody(body: string): string {
  return splitLines(body)
    .map((line, index) => (index === 0 || !line ? line : `  ${line}`))
    .join("\n");
}

/**
 * A hook event from a cloud session, with the text the app shows for it
 * marked: what a `Notification` or `PermissionRequest` says, and any detail
 * of a session waiting on the user (N-5). Details Daedalus writes itself, of
 * a session working or done, stay as they are.
 */
export function markCloudObservation(
  event: string,
  observation: ActivityObservation,
  mark: string,
): ActivityObservation {
  if (
    observation.detail === undefined ||
    !(
      event === "Notification" ||
      event === "PermissionRequest" ||
      observation.activity === "needs_input" ||
      observation.activity === "needs_permission"
    )
  )
    return observation;
  return { ...observation, detail: markOneLine(mark, observation.detail) };
}
