/**
 * The gateway's recent log lines, kept in memory for the admin page's
 * health section. Lines are redacted on the way in: anything that looks
 * like a token (32 or more base64 characters that are not a workspace id)
 * is replaced, so a stray secret in an error message never reaches the page.
 */

export interface LogLine {
  at: string;
  message: string;
}

/** Lines kept; older ones drop off. */
export const LOGBOOK_LINES = 50;
/** Longest line kept. */
const MAX_LINE = 500;

const TOKENISH = /[A-Za-z0-9+/=_-]{32,}/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Replaces token-like runs; workspace ids and names built on them stay. */
export function redact(message: string): string {
  return message.replace(TOKENISH, (run) =>
    run.replace(UUID, "").replace(/^ws-|-state$|-runner$|-/g, "").length < 16
      ? run
      : "[redacted]",
  );
}

export class Logbook {
  readonly #lines: LogLine[] = [];

  constructor(
    private readonly print: (message: string) => void = (message) =>
      console.error(message),
    private readonly now: () => number = Date.now,
  ) {}

  /** Prints the line as before and keeps a redacted copy. */
  readonly log = (message: string): void => {
    this.print(message);
    this.#lines.push({
      at: new Date(this.now()).toISOString(),
      message: redact(message).slice(0, MAX_LINE),
    });
    if (this.#lines.length > LOGBOOK_LINES) this.#lines.shift();
  };

  /** Newest first. */
  lines(): LogLine[] {
    return [...this.#lines].reverse();
  }
}
