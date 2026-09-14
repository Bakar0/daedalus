import type {
  TerminalClientMessage,
  TerminalServerMessage,
} from "@daedalus/protocol";

export const TERMINAL_BUFFER_LIMIT = 1024 * 1024;
export const TERMINAL_SOCKET_HIGH_WATER = 256 * 1024;
export const TERMINAL_INPUT_LIMIT = 64 * 1024;

export interface TerminalSocket {
  send(data: string | Uint8Array): number | void;
  getBufferedAmount?(): number;
  close?(): void;
}

export interface TerminalBridge {
  start(): Promise<void>;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export class BoundedTerminalBuffer {
  readonly limit: number;
  #chunks: Uint8Array[] = [];
  #bytes = 0;
  #droppedBytes = 0;

  constructor(limit = TERMINAL_BUFFER_LIMIT) {
    this.limit = limit;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength >= this.limit) {
      this.#droppedBytes += this.#bytes + chunk.byteLength - this.limit;
      this.#chunks = [chunk.slice(chunk.byteLength - this.limit)];
      this.#bytes = this.limit;
      return;
    }
    this.#chunks.push(chunk);
    this.#bytes += chunk.byteLength;
    while (this.#bytes > this.limit) {
      const oldest = this.#chunks.shift();
      if (!oldest) break;
      this.#bytes -= oldest.byteLength;
      this.#droppedBytes += oldest.byteLength;
    }
  }

  takeDroppedBytes(): number {
    const value = this.#droppedBytes;
    this.#droppedBytes = 0;
    return value;
  }

  shift(): Uint8Array | undefined {
    const chunk = this.#chunks.shift();
    if (chunk) this.#bytes -= chunk.byteLength;
    return chunk;
  }
}

export interface AuthorizedTerminalTarget {
  kind: "agent" | "integrated";
  id: string;
  initialSize?: { cols: number; rows: number };
}

export function authorizeTerminalRequest(
  request: Request,
  expectedToken: string,
): AuthorizedTerminalTarget | undefined {
  const url = new URL(request.url);
  const agentId = url.searchParams.get("agent");
  const integratedId = url.searchParams.get("integrated");
  const id = agentId ?? integratedId;
  if (
    url.pathname !== "/terminal" ||
    url.searchParams.get("token") !== expectedToken ||
    !id ||
    Boolean(agentId) === Boolean(integratedId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    return undefined;
  const cols = Number(url.searchParams.get("cols"));
  const rows = Number(url.searchParams.get("rows"));
  const hasSize = url.searchParams.has("cols") || url.searchParams.has("rows");
  if (
    hasSize &&
    (!Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 500 ||
      rows < 5 ||
      rows > 300)
  )
    return undefined;
  return {
    kind: agentId ? "agent" : "integrated",
    id,
    ...(hasSize ? { initialSize: { cols, rows } } : {}),
  };
}

export interface TerminalConnectionOptions {
  agentId: string;
  socket: TerminalSocket;
  status: "live" | "reconnected";
  createBridge: (onOutput: (output: Uint8Array) => void) => TerminalBridge;
  onError?: (error: unknown) => void;
}

export class TerminalConnection {
  readonly buffer = new BoundedTerminalBuffer();
  readonly bridge: TerminalBridge;
  #closed = false;
  #initialized = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #inputChain = Promise.resolve();

  constructor(private readonly options: TerminalConnectionOptions) {
    this.bridge = options.createBridge((output) => {
      this.buffer.push(output);
      if (this.#initialized) this.flush();
    });
  }

  async start(): Promise<void> {
    this.#timer = setInterval(() => this.flush(), 16);
    try {
      this.sendJson({
        type: "status",
        status: this.options.status,
        agentId: this.options.agentId,
      });
      this.#initialized = true;
      this.flush();
      void this.bridge.start().catch((error) => this.fail(error));
    } catch (error) {
      this.fail(error);
    }
  }

  async message(payload: string | Uint8Array): Promise<void> {
    if (typeof payload !== "string") return;
    try {
      const message = JSON.parse(payload) as TerminalClientMessage;
      if (message.type === "input") {
        if (
          typeof message.data !== "string" ||
          new TextEncoder().encode(message.data).byteLength >
            TERMINAL_INPUT_LIMIT
        )
          throw new Error("Terminal input frame is too large");
        const operation = this.#inputChain.then(() => {
          this.bridge.write(message.data);
        });
        this.#inputChain = operation.catch(() => {});
        await operation;
      } else if (message.type === "resize") {
        if (!Number.isFinite(message.cols) || !Number.isFinite(message.rows))
          throw new Error("Invalid terminal dimensions");
        this.bridge.resize(message.cols, message.rows);
      }
    } catch (error) {
      this.fail(error, false);
    }
  }

  flush(): void {
    if (
      this.#closed ||
      !this.#initialized ||
      (this.options.socket.getBufferedAmount?.() ?? 0) >
        TERMINAL_SOCKET_HIGH_WATER
    )
      return;
    const droppedBytes = this.buffer.takeDroppedBytes();
    if (droppedBytes) this.sendJson({ type: "overflow", droppedBytes });
    let sent = 0;
    while (sent < 64 * 1024) {
      const chunk = this.buffer.shift();
      if (!chunk) break;
      this.options.socket.send(chunk);
      sent += chunk.byteLength;
      if (
        (this.options.socket.getBufferedAmount?.() ?? 0) >
        TERMINAL_SOCKET_HIGH_WATER
      )
        break;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.bridge.close();
  }

  end(status: "exited" | "lost"): void {
    this.sendJson({
      type: "status",
      status,
      agentId: this.options.agentId,
    });
    this.close();
    this.options.socket.close?.();
  }

  private fail(error: unknown, close = true): void {
    this.sendJson({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    this.options.onError?.(error);
    if (close) this.close();
  }

  private sendJson(message: TerminalServerMessage): void {
    if (!this.#closed) this.options.socket.send(JSON.stringify(message));
  }
}
