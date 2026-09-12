export type ErrorCode =
  "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "DEPENDENCY" | "INTERNAL";

const exitCodes: Record<ErrorCode, number> = {
  INTERNAL: 1,
  VALIDATION: 2,
  NOT_FOUND: 3,
  CONFLICT: 4,
  DEPENDENCY: 5,
};

export class DaedalusError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DaedalusError";
    this.code = code;
    this.details = details;
  }

  get exitCode(): number {
    return exitCodes[this.code];
  }
}

export function normalizeError(error: unknown): DaedalusError {
  return error instanceof DaedalusError
    ? error
    : new DaedalusError(
        "INTERNAL",
        error instanceof Error ? error.message : String(error),
      );
}
