import { runCommand } from "./process";

export const SPIKE_SOCKET = "daedalus-spike";
export const SPIKE_SESSION = "daedalus_spike";

const tmuxArgs = (...args: string[]) => ["-L", SPIKE_SOCKET, ...args];

export async function ensureSpikeSession(cwd: string): Promise<boolean> {
  const exists = await runCommand(
    "tmux",
    tmuxArgs("has-session", "-t", SPIKE_SESSION),
  );
  if (exists.exitCode === 0) return false;
  const created = await runCommand(
    "tmux",
    tmuxArgs(
      "new-session",
      "-d",
      "-s",
      SPIKE_SESSION,
      "-c",
      cwd,
      "-x",
      "100",
      "-y",
      "30",
    ),
  );
  if (created.exitCode !== 0)
    throw new Error(created.stderr || "tmux session creation failed");
  return true;
}

export async function captureSpikePane(): Promise<Uint8Array> {
  const captured = await runCommand(
    "tmux",
    tmuxArgs("capture-pane", "-p", "-e", "-J", "-S", "-", "-t", SPIKE_SESSION),
  );
  if (captured.exitCode !== 0)
    throw new Error(captured.stderr || "tmux capture failed");
  const screen = captured.stdout.replace(/\r?\n/g, "\r\n");
  return new TextEncoder().encode(`\u001b[H\u001b[2J${screen}`);
}

export async function sendSpikeInput(data: string): Promise<void> {
  const chunks = data.split("\r");
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index] ?? "";
    if (chunk) {
      const literal = await runCommand(
        "tmux",
        tmuxArgs("send-keys", "-t", SPIKE_SESSION, "-l", "--", chunk),
      );
      if (literal.exitCode !== 0)
        throw new Error(literal.stderr || "tmux input failed");
    }
    if (index < chunks.length - 1) {
      const enter = await runCommand(
        "tmux",
        tmuxArgs("send-keys", "-t", SPIKE_SESSION, "Enter"),
      );
      if (enter.exitCode !== 0)
        throw new Error(enter.stderr || "tmux Enter input failed");
    }
  }
}

export function decodeControlOutput(payload: string): Uint8Array {
  const decoded = payload.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
  return new TextEncoder().encode(decoded);
}

export class TmuxControlBridge {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #onOutput: (output: Uint8Array) => void;
  #buffer = "";

  constructor(onOutput: (output: Uint8Array) => void) {
    this.#onOutput = onOutput;
    this.process = Bun.spawn(
      ["tmux", ...tmuxArgs("-C", "attach-session", "-t", SPIKE_SESSION)],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  }

  async start(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.#buffer += decoder.decode(value, { stream: true });
      let newline = this.#buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.startsWith("%output ")) {
          const separator = line.indexOf(" ", 8);
          if (separator >= 0)
            this.#onOutput(decodeControlOutput(line.slice(separator + 1)));
        }
        newline = this.#buffer.indexOf("\n");
      }
    }
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(5, Math.min(300, Math.floor(rows)));
    this.process.stdin.write(`refresh-client -C ${safeCols},${safeRows}\n`);
    this.process.stdin.flush();
  }

  close(): void {
    this.process.stdin.end();
  }
}
