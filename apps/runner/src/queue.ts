import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DaedalCall } from "@daedalus/remote-protocol";

/**
 * Hook events made while the Mac is offline, on disk so a pod restart keeps
 * them. One JSON object per line, oldest first.
 */
export class EventQueue {
  #calls: DaedalCall[];

  constructor(private readonly file: string) {
    this.#calls = this.#load();
  }

  #load(): DaedalCall[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const calls: DaedalCall[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        calls.push(JSON.parse(line) as DaedalCall);
      } catch {
        // A torn last line from a crash; drop it.
      }
    }
    return calls;
  }

  #save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(
      temporary,
      this.#calls.map((call) => `${JSON.stringify(call)}\n`).join(""),
      { mode: 0o600 },
    );
    renameSync(temporary, this.file);
  }

  get length(): number {
    return this.#calls.length;
  }

  peek(): DaedalCall | undefined {
    return this.#calls[0];
  }

  push(call: DaedalCall): void {
    if (this.#calls.some((queued) => queued.callId === call.callId)) return;
    this.#calls.push(call);
    this.#save();
  }

  /** Removes the oldest call once the Mac has answered it. */
  shift(): void {
    this.#calls.shift();
    this.#save();
  }
}
