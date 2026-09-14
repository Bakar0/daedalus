import { describe, expect, test, vi } from "vitest";
import {
  authorizeTerminalRequest,
  BoundedTerminalBuffer,
  TerminalConnection,
} from "./terminal";

const AGENT_ID = "12345678-1234-4123-8123-123456789abc";

describe("terminal transport authentication", () => {
  test("requires the private token, terminal path, and a UUID session id", () => {
    expect(
      authorizeTerminalRequest(
        new Request(`http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}`),
        "secret",
      ),
    ).toEqual({ kind: "agent", id: AGENT_ID });
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&integrated=${AGENT_ID}&cols=120&rows=32`,
        ),
        "secret",
      ),
    ).toEqual({
      kind: "integrated",
      id: AGENT_ID,
      initialSize: { cols: 120, rows: 32 },
    });
    expect(
      authorizeTerminalRequest(
        new Request(`http://127.0.0.1/terminal?agent=${AGENT_ID}`),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}&integrated=${AGENT_ID}`,
        ),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request("http://127.0.0.1/terminal?token=secret&agent=not-an-id"),
        "secret",
      ),
    ).toBeUndefined();
    expect(
      authorizeTerminalRequest(
        new Request(
          `http://127.0.0.1/terminal?token=secret&agent=${AGENT_ID}&cols=1&rows=1`,
        ),
        "secret",
      ),
    ).toBeUndefined();
  });
});

describe("bounded terminal buffering", () => {
  test("retains only bounded recent output from a noisy producer", () => {
    const buffer = new BoundedTerminalBuffer(10);
    buffer.push(new TextEncoder().encode("123456"));
    buffer.push(new TextEncoder().encode("abcdef"));
    expect(buffer.byteLength).toBeLessThanOrEqual(10);
    expect(buffer.takeDroppedBytes()).toBe(6);
    expect(new TextDecoder().decode(buffer.shift())).toBe("abcdef");

    buffer.push(new TextEncoder().encode("0123456789OVERFLOW"));
    expect(buffer.byteLength).toBe(10);
    expect(new TextDecoder().decode(buffer.shift())).toBe("89OVERFLOW");
  });
});

describe("terminal connection lifecycle", () => {
  test("reconnects with ANSI/Unicode capture, forwards input and resize, and cleans up", async () => {
    const sent: Array<string | Uint8Array> = [];
    const lifecycle: string[] = [];
    const input = vi.fn(async () => {});
    const resize = vi.fn();
    const close = vi.fn();
    let output: ((chunk: Uint8Array) => void) | undefined;
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        getBufferedAmount: () => 0,
      },
      status: "reconnected",
      prepareCapture: async () => void lifecycle.push("resize"),
      capture: async () => {
        lifecycle.push("capture");
        return new TextEncoder().encode("\u001b[31mשלום 世界 😀\u001b[0m");
      },
      sendInput: input,
      createBridge: (listener) => {
        output = listener;
        return { start: async () => {}, resize, close };
      },
    });

    await connection.start();
    output?.(new TextEncoder().encode("\r\nlive"));
    await connection.message(JSON.stringify({ type: "input", data: "go\r" }));
    await connection.message(
      JSON.stringify({ type: "resize", cols: 101, rows: 32 }),
    );
    connection.close();

    expect(String(sent[0])).toContain('"status":"reconnected"');
    expect(new TextDecoder().decode(sent[1] as Uint8Array)).toContain(
      "\u001b[31mשלום 世界 😀\u001b[0m",
    );
    expect(new TextDecoder().decode(sent[2] as Uint8Array)).toBe("\r\nlive");
    expect(input).toHaveBeenCalledWith("go\r");
    expect(resize).toHaveBeenCalledWith(101, 32);
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle).toEqual(["resize", "capture"]);
  });

  test("pauses delivery above the socket high-water mark and bounds queued output", async () => {
    const sent: Array<string | Uint8Array> = [];
    let buffered = 300 * 1024;
    let output: ((chunk: Uint8Array) => void) | undefined;
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        getBufferedAmount: () => buffered,
      },
      status: "live",
      capture: async () => new Uint8Array(),
      sendInput: async () => {},
      createBridge: (listener) => {
        output = listener;
        return { start: async () => {}, resize: () => {}, close: () => {} };
      },
    });
    await connection.start();
    output?.(new Uint8Array(2 * 1024 * 1024));
    expect(connection.buffer.byteLength).toBe(1024 * 1024);
    buffered = 0;
    connection.flush();
    expect(
      sent.some((item) => String(item).includes('"type":"overflow"')),
    ).toBe(true);
    connection.close();
  });

  test("reports a lost session and closes both socket and bridge", async () => {
    const sent: Array<string | Uint8Array> = [];
    const closeSocket = vi.fn();
    const closeBridge = vi.fn();
    const connection = new TerminalConnection({
      agentId: AGENT_ID,
      socket: {
        send: (data) => void sent.push(data),
        close: closeSocket,
      },
      status: "live",
      capture: async () => new Uint8Array(),
      sendInput: async () => {},
      createBridge: () => ({
        start: async () => {},
        resize: () => {},
        close: closeBridge,
      }),
    });
    await connection.start();
    connection.end("lost");
    expect(sent.some((item) => String(item).includes('"status":"lost"'))).toBe(
      true,
    );
    expect(closeBridge).toHaveBeenCalledOnce();
    expect(closeSocket).toHaveBeenCalledOnce();
  });
});
