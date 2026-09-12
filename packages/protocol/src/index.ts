export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "status"; status: "connected" | "reconnected" }
  | { type: "error"; message: string };

export interface DoctorCheck {
  name: string;
  ok: boolean;
  version?: string;
  detail: string;
}

export interface CliSuccess<T> {
  ok: true;
  data: T;
}

export interface CliFailure {
  ok: false;
  error: {
    code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "DEPENDENCY" | "INTERNAL";
    message: string;
    details?: Record<string, unknown>;
  };
}

export type CliEnvelope<T> = CliSuccess<T> | CliFailure;
