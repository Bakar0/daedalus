/**
 * How long after a mouse selection or drag a cloud session's terminal may
 * still write the clipboard. tmux copies a drag with OSC 52 as the mouse
 * button comes up, so a real copy lands well inside this.
 */
export const CLOUD_CLIPBOARD_WINDOW_MS = 1500;

/**
 * Whether an OSC 52 clipboard write from a terminal is honoured. A local
 * session runs the user's own programs, so its writes are. A cloud session's
 * output comes from a pod running code this Mac does not trust, so its
 * writes are honoured only just after the user selected or dragged in that
 * terminal; otherwise a program could put a command on the clipboard for the
 * user to paste somewhere else later.
 */
export function acceptsClipboardWrite(input: {
  cloud: boolean;
  lastPointerAt: number | undefined;
  now: number;
}): boolean {
  if (!input.cloud) return true;
  return (
    input.lastPointerAt !== undefined &&
    input.now >= input.lastPointerAt &&
    input.now - input.lastPointerAt <= CLOUD_CLIPBOARD_WINDOW_MS
  );
}
