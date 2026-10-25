/** What a `SocketWriter` needs of a Bun socket. */
export interface WritableSocket {
  /** Bytes written, which can be fewer than given, or -1 once closed. */
  write(data: Uint8Array): number;
  end(): void;
}

const encoder = new TextEncoder();

/**
 * Writes everything to a Bun socket. `socket.write` takes only what fits in
 * the socket's buffer and returns how much that was; Bun keeps none of the
 * rest. This keeps the rest and sends it when the socket calls `drain`, so
 * the socket's `drain` handler must call `flush`. `end` waits for the
 * pending bytes to go.
 */
export class SocketWriter {
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #ending = false;
  #closed = false;

  /**
   * `maxPending` bounds what waits for a reader that does not read: past
   * it, the socket is ended and the bytes dropped.
   */
  constructor(
    private readonly socket: WritableSocket,
    private readonly maxPending = Number.POSITIVE_INFINITY,
  ) {}

  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  write(data: string | Uint8Array): void {
    if (this.#closed || this.#ending) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.byteLength === 0) return;
    this.#pending.push(bytes);
    this.#pendingBytes += bytes.byteLength;
    if (this.#pendingBytes > this.maxPending) {
      this.#close();
      return;
    }
    this.flush();
  }

  /** Ends the socket once everything written has gone. */
  end(): void {
    if (this.#closed) return;
    this.#ending = true;
    this.flush();
  }

  /** Sends what is pending; call it from the socket's `drain` handler. */
  flush(): void {
    if (this.#closed) return;
    while (this.#pending.length) {
      const head = this.#pending[0]!;
      const written = this.socket.write(head);
      if (written < 0) {
        this.#close();
        return;
      }
      this.#pendingBytes -= Math.max(written, 0);
      if (written < head.byteLength) {
        this.#pending[0] = head.subarray(written);
        return;
      }
      this.#pending.shift();
    }
    if (this.#ending) {
      this.#closed = true;
      this.socket.end();
    }
  }

  #close(): void {
    this.#closed = true;
    this.#pending = [];
    this.#pendingBytes = 0;
    this.socket.end();
  }
}
