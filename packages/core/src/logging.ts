import { appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export class JsonLogger {
  constructor(private readonly logsDirectory: string) {}

  async write(
    level: LogEntry["level"],
    message: string,
    context?: Record<string, unknown>,
  ) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };
    await appendFile(
      join(this.logsDirectory, "daedalus.log"),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }
}
