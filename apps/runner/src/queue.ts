import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DaedalCall } from "@daedalus/remote-protocol";

/**
 * How much the queue holds (N-4). A session writes the queue through its
 * hook events, so without a limit it could fill the runner's 256 MiB of
 * memory and its state volume, and the runner would fail again on every
 * start as it loads the file. 1000 events or 8 MiB is hours of hook events
 * from several sessions while the Mac is offline.
 */
export const QUEUE_MAX_CALLS = 1000;
export const QUEUE_MAX_BYTES = 8 * 1024 * 1024;

const size = (call: DaedalCall) => Buffer.byteLength(JSON.stringify(call)) + 1;

/**
 * Hook events made while the Mac is offline, on disk so a pod restart keeps
 * them. One JSON object per line, oldest first. When it is full the oldest
 * events go: the newest ones say what each session is doing now, which is
 * what the Mac shows, so dropping them instead would leave it showing an old
 * state.
 */
export class EventQueue {
  #calls: DaedalCall[];
  #bytes = 0;

  constructor(
    private readonly file: string,
    private readonly limits = {
      calls: QUEUE_MAX_CALLS,
      bytes: QUEUE_MAX_BYTES,
    },
  ) {
    this.#calls = [];
    for (const call of this.#load()) this.#append(call);
  }

  #load(): DaedalCall[] {
    let text: string;
    try {
      // A file this queue could not have written is not read into memory.
      if (statSync(this.file).size > 2 * this.limits.bytes) return [];
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

  /** Adds a call, dropping the oldest until it fits; false if it never can. */
  #append(call: DaedalCall): boolean {
    const bytes = size(call);
    if (bytes > this.limits.bytes) return false;
    this.#calls.push(call);
    this.#bytes += bytes;
    while (
      this.#calls.length > this.limits.calls ||
      this.#bytes > this.limits.bytes
    )
      this.#bytes -= size(this.#calls.shift()!);
    return true;
  }

  get length(): number {
    return this.#calls.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  peek(): DaedalCall | undefined {
    return this.#calls[0];
  }

  push(call: DaedalCall): void {
    if (this.#calls.some((queued) => queued.callId === call.callId)) return;
    if (this.#append(call)) this.#save();
  }

  /**
   * Removes a call once the Mac has answered it. By id, since a push may
   * have dropped it meanwhile.
   */
  remove(callId: string): void {
    const index = this.#calls.findIndex((call) => call.callId === callId);
    if (index === -1) return;
    this.#bytes -= size(this.#calls.splice(index, 1)[0]!);
    this.#save();
  }
}
